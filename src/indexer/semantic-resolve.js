import crypto from 'node:crypto'

// Global, deterministic resolution of per-file semantic facts into relation edges.
//
// Edge types (stored in `edges`, one row per source/target/type):
//   CALLS       executable symbol (or module) -> invoked function/method
//   IMPLEMENTS  class -> interface, and class method -> interface method
//   REGISTERS   symbol (or module) -> function/method passed as a callback argument,
//               or decorated by a call-form decorator
//   CONSUMES    executable symbol -> imported symbol used without being called
//               (types, contracts, constants, classes)
//
// A relation is emitted only when every step resolves to exactly one repository
// symbol. Anything else (dynamic or computed access, untyped receivers, unknown
// modules, ambiguous re-exports) produces no edge. Confidence is deterministic:
//   high    direct local/imported function, `this`/`self` member, receiver typed or
//           constructed as a class, module member, explicit implements, callback
//           argument bound to a known symbol
//   medium  receiver typed as an interface (the call names the contract, not a
//           runtime target), constructor field inferred from every instantiation
//           site, decorator registration

export const SEMANTIC_EDGE_TYPES = ['CALLS', 'IMPLEMENTS', 'REGISTERS', 'CONSUMES']
export const CONFIDENCE_VALUE = { high: 1, medium: 0.6 }
const MAX_DEPTH = 6

function edgeId(source, target, type) {
  return crypto.createHash('sha1').update(`${source}|${target}|${type}`).digest('hex')
}

export function isCallableSymbol(symbol) {
  if (!symbol) return false
  if (symbol.kind === 'function' || symbol.kind === 'method') return true
  return symbol.kind === 'constant' && /=>|\bfunction\b/.test(symbol.signature ?? '')
}

const weaker = (a, b) => (a === 'medium' || b === 'medium') ? 'medium' : 'high'

export function resolveSemanticEdges(db, { resolveImport, resolvePythonModule }) {
  const files = db.prepare('SELECT file_id,path,language FROM files').all()
  const fileById = new Map(files.map(f => [f.file_id, f]))
  const symbols = db.prepare('SELECT symbol_id,file_id,qualified_name,name,kind,start_line,end_line,exported,signature FROM symbols ORDER BY file_id,start_line,qualified_name').all()
  const byFile = new Map()
  const SCOPE_KINDS = new Set(['function', 'method', 'constant'])
  const AMBIGUOUS = { t: 'ambiguous' }
  for (const s of symbols) {
    if (!byFile.has(s.file_id)) byFile.set(s.file_id, { byQName: new Map(), top: new Map(), list: [] })
    const entry = byFile.get(s.file_id)
    entry.list.push(s)
    if (!entry.byQName.has(s.qualified_name)) entry.byQName.set(s.qualified_name, s)
  }
  // Module-level names: undotted symbols not nested inside a function/method range. A
  // name declared twice at module level is ambiguous and binds nothing.
  for (const entry of byFile.values()) {
    const open = []
    for (const s of entry.list) {
      while (open.length && open[open.length - 1].end_line < s.start_line) open.pop()
      const nested = open.some(o => o.end_line >= s.end_line && !(o.start_line === s.start_line && o.end_line === s.end_line))
      if (SCOPE_KINDS.has(s.kind) && s.end_line > s.start_line) open.push(s)
      if (nested || s.qualified_name.includes('.')) continue
      entry.top.set(s.name, entry.top.has(s.name) && entry.top.get(s.name).symbol_id !== s.symbol_id ? AMBIGUOUS : s)
    }
  }
  const facts = new Map()
  for (const row of db.prepare('SELECT file_id,facts_json FROM semantic_facts').all()) {
    try { facts.set(row.file_id, JSON.parse(row.facts_json)) } catch {}
  }
  const qname = (fileId, name) => byFile.get(fileId)?.byQName.get(name) ?? null
  const isPy = fileId => facts.get(fileId)?.language === 'py'

  const sym = (s, conf = 'high') => s ? { t: 'sym', s, conf } : null
  const inst = (cls, conf = 'high') => cls ? { t: 'inst', cls, conf: cls.kind === 'interface' ? 'medium' : conf } : null
  const mod = fileId => fileId ? { t: 'mod', f: fileId, conf: 'high' } : null

  const exportMemo = new Map()
  const bindingMemo = new Map()
  const fieldMemo = new Map()

  function importTarget(fileId, specifier) {
    return resolveImport(fileById.get(fileId)?.path ?? fileId, specifier)
  }

  function typeSymbol(fileId, typeName, depth = 0) {
    if (!typeName || depth > MAX_DEPTH) return null
    const parts = typeName.split('.')
    let value = binding(fileId, parts[0], null, depth + 1)
    for (const part of parts.slice(1)) value = step(value, part, depth + 1)
    if (value?.t === 'sym' && (value.s.kind === 'class' || value.s.kind === 'interface')) return value.s
    return null
  }

  function exportValue(fileId, name, depth = 0) {
    if (!fileId || depth > MAX_DEPTH) return null
    const key = `${fileId}|${name}`
    if (exportMemo.has(key)) return exportMemo.get(key)
    exportMemo.set(key, null)
    const f = facts.get(fileId)
    let value = null
    if (f?.language === 'js') {
      const sameName = list => (list ?? []).filter(e => e.exported === name).length
      if (sameName(f.reexports) + sameName(f.exports?.named) > 1) { exportMemo.set(key, null); return null }
      if (name === 'default') {
        const d = f.exports?.defaultExpr
        if (d?.kind === 'new') value = inst(typeSymbol(fileId, d.className, depth + 1))
        else if (d?.kind === 'ident') value = binding(fileId, d.name, null, depth + 1)
      } else {
        const named = f.exports?.named?.find(e => e.exported === name)
        if (named) value = binding(fileId, named.local, null, depth + 1)
        const top = byFile.get(fileId)?.top.get(name)
        if (!value && ((top && top !== AMBIGUOUS && top.exported) || f.values?.some(v => v.name === name && !v.scope))) value = binding(fileId, name, null, depth + 1)
        if (!value) {
          const re = f.reexports?.find(r => r.exported === name)
          if (re) {
            const target = importTarget(fileId, re.specifier)
            value = re.imported === '*' ? mod(target) : exportValue(target, re.imported, depth + 1)
          }
        }
        if (!value && f.stars?.length) {
          const found = f.stars.map(spec => exportValue(importTarget(fileId, spec), name, depth + 1)).filter(Boolean)
          const distinct = new Set(found.map(v => v.t === 'sym' ? v.s.symbol_id : v.t === 'inst' ? `i:${v.cls.symbol_id}` : `m:${v.f}`))
          if (distinct.size === 1) value = found[0]
        }
      }
    } else if (f?.language === 'py') {
      value = binding(fileId, name, null, depth + 1)
    }
    exportMemo.set(key, value)
    return value
  }

  function pythonSubmodule(fileId, name) {
    const path = fileById.get(fileId)?.path
    if (!path) return null
    const dir = path.endsWith('/__init__.py') ? path.slice(0, -'/__init__.py'.length) : null
    if (dir === null) return null
    for (const candidate of [`${dir}/${name}.py`, `${dir}/${name}/__init__.py`]) if (fileById.has(candidate)) return candidate
    return null
  }

  function binding(fileId, name, scope, depth = 0) {
    if (!name || depth > MAX_DEPTH) return null
    const key = `${fileId}|${name}|${scope ?? ''}`
    if (bindingMemo.has(key)) return bindingMemo.get(key)
    bindingMemo.set(key, null)
    const value = lookup(fileId, name, scope, depth)
    bindingMemo.set(key, value)
    return value
  }

  // Lookup order: enclosing executable scopes (innermost first), then module scope. A
  // name bound in a scope without a resolvable type shadows everything outside it.
  function lookup(fileId, name, scope, depth) {
    const f = facts.get(fileId) ?? {}
    const reassigned = new Set(f.reassigned ?? [])
    const assigned = (s, n) => f.assignCounts?.[`${s ?? ''}|${n}`] ?? 0
    for (let s = scope, guard = 0; s && guard < 32; s = f.scopeParents?.[s] ?? null, guard++) {
      const param = f.params?.[s]?.find(p => p.name === name)
      if (param) return inst(typeSymbol(fileId, param.type, depth + 1))
      const local = f.values?.filter(v => v.name === name && v.scope === s) ?? []
      if (local.length) {
        const ok = local.length === 1 && !local[0].unknown && !(local[0].mutable && reassigned.has(name)) && (f.language !== 'py' || assigned(s, name) === 1)
        return ok ? valueFromDeclaration(fileId, local[0], depth) : null
      }
      const destructured = f.destructures?.find(d => d.scope === s && d.names.some(n => n.local === name))
      if (destructured) return fromDestructure(fileId, destructured, name, s, depth)
      const scopedRequire = f.requires?.find(x => x.local === name && x.scope === s)
      if (scopedRequire) return mod(importTarget(fileId, scopedRequire.specifier))
      if (f.locals?.[s]?.includes(name)) return null
    }
    const moduleValues = f.values?.filter(v => v.name === name && !v.scope) ?? []
    if (moduleValues.length) {
      const ok = moduleValues.length === 1 && !moduleValues[0].unknown && !(moduleValues[0].mutable && reassigned.has(name)) && (f.language !== 'py' || assigned(null, name) === 1)
      return ok ? valueFromDeclaration(fileId, moduleValues[0], depth) : null
    }
    // A module-level reassignment of a declared function (`save = wrap(save)`) hides it.
    if (f.language === 'py' && assigned(null, name) > 0) return null
    const top = byFile.get(fileId)?.top.get(name)
    if (top === AMBIGUOUS) return null
    if (top) return (f.language === 'js' && reassigned.has(name)) ? null : sym(top)
    for (const imp of f.imports ?? []) {
      const b = imp.bindings.find(x => x.local === name)
      if (!b) continue
      if (f.language === 'py') {
        const asModule = resolvePythonModule(fileById.get(fileId)?.path ?? fileId, `${imp.specifier}.${b.imported}`.replace(/^(\.+)\./, '$1'))
        return asModule ? mod(asModule) : exportValue(importTarget(fileId, imp.specifier), b.imported, depth + 1)
      }
      const target = importTarget(fileId, imp.specifier)
      return b.imported === '*' ? mod(target) : exportValue(target, b.imported, depth + 1)
    }
    const r = f.requires?.find(x => x.local === name && !x.scope)
    if (r) return mod(importTarget(fileId, r.specifier))
    const m = f.modules?.find(x => x.local === name)
    if (m) return mod(resolvePythonModule(fileById.get(fileId)?.path ?? fileId, m.full ? m.module : m.module.split('.')[0]))
    const destructured = f.destructures?.find(d => !d.scope && d.names.some(n => n.local === name))
    if (destructured) return fromDestructure(fileId, destructured, name, null, depth)
    return null
  }

  function valueFromDeclaration(fileId, decl, depth) {
    if (decl.type) { const t = typeSymbol(fileId, decl.type, depth + 1); if (t) return inst(t) }
    if (decl.newClass) {
      const t = typeSymbol(fileId, decl.newClass, depth + 1)
      if (t?.kind === 'class') return inst(t)
    }
    return null
  }

  function fromDestructure(fileId, decl, name, scope, depth) {
    const entry = decl.names.find(n => n.local === name)
    const source = decl.from.startsWith('this.') ? thisMember(fileId, scope, decl.from.slice(5), depth) : binding(fileId, decl.from, scope, depth + 1)
    if (!source || source.t === 'sym' && !['class', 'constant'].includes(source.s.kind)) return null
    return step(source, entry.imported, depth + 1)
  }

  function enclosingOwner(fileId, caller) {
    if (!caller || !caller.includes('.')) return null
    const owner = qname(fileId, caller.slice(0, caller.lastIndexOf('.')))
    if (!owner) return null
    if (owner.kind === 'class') return inst(owner)
    if (owner.kind === 'constant') return sym(owner)
    return null
  }

  function thisMember(fileId, caller, member, depth) {
    return step(enclosingOwner(fileId, caller), member, depth + 1)
  }

  function memberOf(cls, name, depth = 0, seen = new Set()) {
    if (!cls || depth > MAX_DEPTH || seen.has(cls.symbol_id)) return null
    seen.add(cls.symbol_id)
    const own = qname(cls.file_id, `${cls.qualified_name}.${name}`)
    if (own) return own
    const classFact = facts.get(cls.file_id)?.classes?.find(c => c.name === cls.qualified_name)
    for (const base of classFact?.extends ?? []) {
      const found = memberOf(typeSymbol(cls.file_id, base, depth + 1), name, depth + 1, seen)
      if (found) return found
    }
    return null
  }

  function fieldOf(cls, name, depth = 0, seen = new Set()) {
    if (!cls || depth > MAX_DEPTH || seen.has(cls.symbol_id)) return null
    seen.add(cls.symbol_id)
    const key = `${cls.symbol_id}|${name}`
    if (fieldMemo.has(key)) return fieldMemo.get(key)
    fieldMemo.set(key, null)
    const classFact = facts.get(cls.file_id)?.classes?.find(c => c.name === cls.qualified_name)
    let value = null
    const fields = (classFact?.fields ?? []).filter(f => f.name === name)
    // Every assignment must agree on one class; any unknown or unresolvable one voids the field.
    if (fields.length && !fields.some(f => f.unknown)) {
      const untypedParams = fields.filter(f => !f.type && !f.newClass && Number.isInteger(f.ctorParam))
      const typedEntries = fields.filter(f => f.type || f.newClass)
      if (untypedParams.length && !typedEntries.length && new Set(untypedParams.map(f => f.ctorParam)).size === 1) {
        value = inferFromInstantiations(cls, untypedParams[0].ctorParam, depth)
      } else if (!untypedParams.length) {
        const resolved = typedEntries.map(f => f.type ? typeSymbol(cls.file_id, f.type, depth + 1) : typeSymbol(cls.file_id, f.newClass, depth + 1))
        const valid = resolved.every((t, i) => t && (typedEntries[i].type || t.kind === 'class'))
        const distinct = new Map(resolved.filter(Boolean).map(t => [t.symbol_id, t]))
        if (valid && distinct.size === 1) value = inst([...distinct.values()][0])
      }
    }
    if (!value && !fields.length) for (const base of classFact?.extends ?? []) {
      value = fieldOf(typeSymbol(cls.file_id, base, depth + 1), name, depth + 1, seen)
      if (value) break
    }
    fieldMemo.set(key, value)
    return value
  }

  let instantiations = null
  function inferFromInstantiations(cls, index, depth) {
    if (!instantiations) {
      instantiations = new Map()
      for (const [fileId, f] of facts) for (const n of f.news ?? []) {
        const target = typeSymbol(fileId, n.className, 0)
        if (target?.kind !== 'class') continue
        if (!instantiations.has(target.symbol_id)) instantiations.set(target.symbol_id, [])
        instantiations.get(target.symbol_id).push({ fileId, ...n })
      }
    }
    const sites = instantiations.get(cls.symbol_id) ?? []
    if (!sites.length) return null
    const resolved = sites.map(site => {
      const arg = site.args?.[index]
      if (!arg) return null
      const created = arg.match(/^new\s+([A-Za-z_$][\w$.]*)\s*[<(]/) ?? (isPy(site.fileId) ? arg.match(/^([A-Za-z_][\w.]*)\s*\(/) : null)
      if (created) { const t = typeSymbol(site.fileId, created[1], depth + 1); return t?.kind === 'class' ? t : null }
      if (/^[A-Za-z_$][\w$]*$/.test(arg)) { const v = binding(site.fileId, arg, site.scope ?? null, depth + 1); return v?.t === 'inst' ? v.cls : null }
      return null
    })
    if (resolved.some(r => !r)) return null
    const distinct = new Set(resolved.map(r => r.symbol_id))
    return distinct.size === 1 ? inst(resolved[0], 'medium') : null
  }

  function step(value, member, depth = 0) {
    if (!value || depth > MAX_DEPTH) return null
    if (value.t === 'mod') {
      const sub = isPy(value.f) ? pythonSubmodule(value.f, member) : null
      return sub ? mod(sub) : exportValue(value.f, member, depth + 1)
    }
    if (value.t === 'inst') {
      const method = memberOf(value.cls, member, depth + 1)
      if (method) return sym(method, value.cls.kind === 'interface' ? 'medium' : value.conf)
      const field = fieldOf(value.cls, member, depth + 1)
      return field ? { ...field, conf: weaker(field.conf, value.conf) } : null
    }
    if (value.t === 'sym') {
      if (value.s.kind === 'class' || value.s.kind === 'interface') {
        const method = memberOf(value.s, member, depth + 1)
        return method ? sym(method, value.conf) : null
      }
      if (value.s.kind === 'constant') {
        const own = qname(value.s.file_id, `${value.s.qualified_name}.${member}`)
        return own ? sym(own, value.conf) : null
      }
    }
    return null
  }

  function resolveChain(fileId, caller, chain, scope = caller) {
    const py = isPy(fileId)
    let value
    const head = chain[0]
    if ((head === 'this' && !py) || (head === 'self' && py)) value = enclosingOwner(fileId, caller)
    else if (head === 'super' && !py) {
      const owner = enclosingOwner(fileId, caller)
      const classFact = owner?.t === 'inst' ? facts.get(fileId)?.classes?.find(c => c.name === owner.cls.qualified_name) : null
      value = classFact?.extends?.length === 1 ? inst(typeSymbol(fileId, classFact.extends[0])) : null
    } else value = binding(fileId, head, scope)
    for (const part of chain.slice(1)) value = step(value, part)
    return value
  }

  // ---------------------------------------------------------------- emit
  const insert = db.prepare(`INSERT OR IGNORE INTO edges(edge_id,source_id,target_id,edge_type,weight,confidence,source_file_id,metadata_json)
    VALUES(?,?,?,?,?,?,?,?)`)
  const emitted = new Set()
  const counts = { CALLS: 0, IMPLEMENTS: 0, REGISTERS: 0, CONSUMES: 0 }
  const emit = (type, fromId, fileId, target, confidence, metadata) => {
    if (!target || fromId === target.symbol_id) return
    const key = `${fromId}|${target.symbol_id}|${type}`
    if (emitted.has(key)) return
    emitted.add(key)
    counts[type]++
    insert.run(edgeId(fromId, target.symbol_id, type), fromId, target.symbol_id, type, 1, CONFIDENCE_VALUE[confidence], fileId,
      JSON.stringify({ confidence, path: fileId, ...metadata }))
  }
  const fromOf = (fileId, caller) => (caller && qname(fileId, caller)?.symbol_id) || fileId
  const pairs = new Set()

  for (const [fileId, f] of facts) {
    for (const call of f.calls ?? []) {
      const value = resolveChain(fileId, call.caller, call.chain, call.scope ?? null)
      const expression = `${call.chain.join('.')}(…)`
      if (value?.t === 'sym' && isCallableSymbol(value.s)) {
        const conf = value.s.kind === 'method' && qname(value.s.file_id, value.s.qualified_name.slice(0, value.s.qualified_name.lastIndexOf('.')))?.kind === 'interface' ? 'medium' : value.conf
        const from = fromOf(fileId, call.caller)
        emit('CALLS', from, fileId, value.s, conf, { line: call.line, expression })
        pairs.add(`${from}|${value.s.symbol_id}`)
      }
      for (const arg of call.args ?? []) {
        if (!arg) continue
        const target = resolveChain(fileId, call.caller, arg.split('.'), call.scope ?? null)
        if (target?.t === 'sym' && isCallableSymbol(target.s) && target.s.symbol_id !== value?.s?.symbol_id) {
          const from = fromOf(fileId, call.caller)
          emit('REGISTERS', from, fileId, target.s, target.conf, { line: call.line, expression, argument: arg })
          pairs.add(`${from}|${target.s.symbol_id}`)
        }
      }
    }
    for (const d of f.decorators ?? []) {
      const target = qname(fileId, d.target)
      if (target) emit('REGISTERS', fileId, fileId, target, 'medium', { line: d.line, expression: `@${d.expression}(…)`, via: 'decorator' })
    }
    for (const c of f.classes ?? []) {
      const cls = qname(fileId, c.name)
      if (!cls) continue
      for (const name of c.implements ?? []) {
        const contract = typeSymbol(fileId, name)
        if (!contract) continue
        emit('IMPLEMENTS', cls.symbol_id, fileId, contract, 'high', { line: cls.start_line, expression: `implements ${name}` })
        pairs.add(`${cls.symbol_id}|${contract.symbol_id}`)
        for (const member of byFile.get(contract.file_id)?.byQName.values() ?? []) {
          if (!member.qualified_name.startsWith(`${contract.qualified_name}.`)) continue
          const own = qname(fileId, `${c.name}.${member.name}`)
          if (own) emit('IMPLEMENTS', own.symbol_id, fileId, member, 'high', { line: own.start_line, expression: `${c.name}.${member.name} implements ${name}.${member.name}` })
        }
      }
    }
  }
  // Consumption is recorded last so a CALLS/REGISTERS/IMPLEMENTS pair is not duplicated.
  for (const [fileId, f] of facts) {
    for (const ref of f.refs ?? []) {
      // A local of the same name shadows the import inside this scope.
      let value = binding(fileId, ref.local, ref.scope ?? null)
      if (ref.member && value?.t === 'mod') value = step(value, ref.member)
      if (value?.t !== 'sym' || value.s.file_id === fileId) continue
      const from = fromOf(fileId, ref.caller)
      if (from === fileId || pairs.has(`${from}|${value.s.symbol_id}`)) continue
      emit('CONSUMES', from, fileId, value.s, 'high', { line: ref.line, expression: ref.member ? `${ref.local}.${ref.member}` : ref.local })
    }
  }
  return counts
}
