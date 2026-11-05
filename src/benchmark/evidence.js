import fs from 'node:fs/promises'
import path from 'node:path'
import { shellCommandFiles } from './shell-reads.js'

export function strings(value, out=[]) {
  if(typeof value==='string') out.push(value)
  else if(Array.isArray(value)) for(const v of value) strings(v,out)
  else if(value && typeof value==='object') for(const v of Object.values(value)) strings(v,out)
  return out
}

// `roots` may list several spellings of the same directory (for example macOS
// /var/... and its realpath /private/var/...); agents may report either.
const SOURCE_FILE=/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|rb|php|cs|c|cc|cpp|h|hpp|vue|svelte)$/

export function sourcePaths(value, roots) {
  const result=new Set()
  const bases=Array.isArray(roots)?roots:[roots]
  for(const text of strings(value)) {
    for(let token of text.match(/(?:[A-Za-z]:)?[^\s'"`|<>]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|rb|php|cs|c|cc|cpp|h|hpp|vue|svelte)\b/g)??[]) {
      if(/[*?[\]{}]/.test(token))continue
      for(const base of bases) {
        const rel=path.relative(base,path.resolve(bases[0],token)).replaceAll('\\','/')
        if(rel && rel!=='..' && !rel.startsWith('../') && !path.isAbsolute(rel)){result.add(rel);break}
      }
    }
  }
  return [...result]
}

function jsonObjectsFromText(text) {
  const result=[]
  let start=-1,depth=0,inString=false,escaped=false
  for(let i=0;i<text.length;i++) {
    const c=text[i]
    if(start<0) {
      if(c==='{'){start=i;depth=1;inString=false;escaped=false}
      continue
    }
    if(inString) {
      if(escaped){escaped=false;continue}
      if(c==='\\'){escaped=true;continue}
      if(c==='"')inString=false
      continue
    }
    if(c==='"'){inString=true;continue}
    if(c==='{')depth++
    else if(c==='}') {
      depth--
      if(depth===0){result.push(text.slice(start,i+1));start=-1}
    }
  }
  return result
}

function outputStrings(value) {
  const out=[]
  for(const text of strings(value)) {
    out.push(text)
    try {out.push(...strings(JSON.parse(text)));continue} catch {}
    for(const candidate of jsonObjectsFromText(text)) {
      try {out.push(...strings(JSON.parse(candidate)))} catch {}
    }
  }
  return out
}

function observedSourceLine(line, spellings) {
  const normalized=String(line).replaceAll('\\','/')
  for(const spelled of spellings) {
    const at=normalized.indexOf(spelled)
    if(at<0)continue
    const suffix=normalized.slice(at+spelled.length)
    // grep -n prints `path:12:text` with no separator; some tools add one space.
    const withPath=suffix.match(/^[:\-](\d+)[:\-](.*)$/)
    if(withPath)return {text:withPath[2],alt:withPath[2].startsWith(' ')?withPath[2].slice(1):null,line:Number(withPath[1])}
  }
  const numbered=normalized.match(/^\s*(\d+)(?:(?::|-)\s?|\t|\s{2,})(.*)$/)
  return numbered?{text:numbered[2],line:Number(numbered[1])}:{text:line,line:null}
}

// Evidence comes from completed tool output, matched against repository source.
// A command name or a path in tool arguments alone is never a source read.
export async function completedEvidence({input,output,cwd,ok,atMs,via}) {
  if(!ok)return {discovered:[],reads:[]}
  let roots=[cwd]
  try {const real=await fs.realpath(cwd); if(real!==cwd)roots.push(real)} catch {}
  const discovered=sourcePaths([input,output],roots)
  const discoveredExtra=new Set()
  const text=strings(input).join(' ')
  // `stellar context --with-source` returns live source excerpts; those count as reads
  // only where the returned lines match repository source verbatim (checked below).
  const contextWithSource=/\bstellar\s+context\b.*--with-source|stellar_context/.test(text)
  const navigation=/\bstellar\s+(context|search|find|file|symbol|related|impact|architecture)\b|stellar_(context|search|find|file|symbol|related|impact|architecture)/.test(text)
  if(navigation && !contextWithSource)return {discovered,reads:[]}
  const candidates=new Map()
  const addCandidate=(rel,spelled)=>{const set=candidates.get(rel)??new Set([rel]);if(spelled)set.add(spelled.replaceAll('\\','/'));candidates.set(rel,set)}
  for(const rel of sourcePaths(contextWithSource?output:[input,output],roots))addCandidate(rel)
  if(!contextWithSource) {
    // Shell commands may read through `cd`, globs, braces or quoted paths; resolve
    // them against the snapshot, then require the same verbatim match as any read.
    let realRoot=cwd
    try{realRoot=await fs.realpath(cwd)}catch{}
    const inside=async file=>{try{const real=await fs.realpath(file);if(!(await fs.stat(real)).isFile())return null;const rel=path.relative(realRoot,real);return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)?rel.replaceAll('\\','/'):null}catch{return null}}
    for(const script of strings(input)) {
      if(!/\s/.test(script.trim()))continue
      const {files,cwds}=await shellCommandFiles(script,cwd)
      for(const entry of files){const rel=await inside(entry.file);if(rel){addCandidate(rel,entry.spelled);discoveredExtra.add(rel)}}
      // Paths printed by commands run inside a `cd` directory are relative to it.
      for(const dir of cwds) {
        for(const rel of sourcePaths(output,[dir])) {
          const resolved=await inside(path.join(dir,rel))
          if(resolved){addCandidate(resolved,rel);addCandidate(resolved,'./'+rel);discoveredExtra.add(resolved)}
        }
      }
    }
  }
  const outputs=outputStrings(output)
  const reads=[]
  for(const [rel,spellings] of candidates) {
    const absolute=path.resolve(cwd,rel)
    let source
    try {
      const real=await fs.realpath(absolute), root=await fs.realpath(cwd)
      if(!real.startsWith(root+path.sep))continue
      source=await fs.readFile(real,'utf8')
    } catch {continue}
    const lines=source.split(/\r?\n/)
    if(lines.at(-1)==='')lines.pop()
    const observed=new Set()
    for(const output of outputs) {
      const returned=output.split(/\r?\n/).map(line=>observedSourceLine(line,[...spellings]))
      for(let i=0;i<returned.length;i++) {
        if(!returned[i].text.trim())continue
        let bestStart=-1,bestCount=0
        for(let start=0;start<lines.length;start++) {
          if(returned[i].line!==null && returned[i].line!==start+1)continue
          let count=0
          while(start+count<lines.length && i+count<returned.length && (lines[start+count]===returned[i+count].text||lines[start+count]===returned[i+count].alt) && (returned[i+count].line===null || returned[i+count].line===start+count+1))count++
          if(count>bestCount){bestStart=start;bestCount=count}
        }
        const meaningful=lines.slice(bestStart,bestStart+bestCount).filter(line=>line.trim().length>3)
        if(meaningful.length<2 && !(meaningful.length===1 && meaningful[0].length>=24))continue
        for(let k=0;k<bestCount;k++)observed.add(bestStart+k)
        i+=bestCount-1
      }
    }

    const sorted=[...observed].sort((a,b)=>a-b)
    for(let i=0;i<sorted.length;) {
      const start=sorted[i];let end=start
      while(i+1<sorted.length && sorted[i+1]===end+1){end=sorted[++i]}
      reads.push({path:rel,startLine:start+1,endLine:end+1,bytes:Buffer.byteLength(lines.slice(start,end+1).join('\n'))+(end<lines.length-1||source.endsWith('\n')?1:0),via,atMs})
      i++
    }
  }
  for(const rel of discoveredExtra)if(SOURCE_FILE.test(rel)&&!discovered.includes(rel))discovered.push(rel)
  return {discovered,reads}
}

// Unique source bytes read, merged per file so overlapping or repeated reads count once.
// expectedSourceBytes / nonExpectedSourceBytes split that total by the task's expected
// files. expectedFileSourcePrecision = expected / (expected + nonExpected) is a benchmark
// proxy for context focus only: an expected file can contain irrelevant lines and a
// non-expected file can be useful, so it is not line-level semantic correctness.
export async function sourceCoverage(root, reads, expectedFiles = []) {
  const expected=new Set(expectedFiles)
  const byPath=new Map()
  for(const read of reads) {
    const ranges=byPath.get(read.path)??[];ranges.push(read);byPath.set(read.path,ranges)
  }
  let uniqueLines=0,uniqueBytes=0,expectedBytes=0
  for(const [file,ranges] of byPath) {
    ranges.sort((a,b)=>a.startLine-b.startLine)
    let active=null
    const merged=[]
    for(const range of ranges) {
      if(!active || range.startLine>active.endLine+1) { if(active)merged.push(active); active={...range} }
      else if(range.endLine>active.endLine) active.endLine=range.endLine
    }
    if(active)merged.push(active)
    const source=(await fs.readFile(path.join(root,file),'utf8')).split(/\r?\n/)
    for(const range of merged) {
      uniqueLines+=range.endLine-range.startLine+1
      const excerpt=source.slice(range.startLine-1,range.endLine).join('\n')
      const bytes=Buffer.byteLength(excerpt)+(range.endLine<source.length?1:0)
      uniqueBytes+=bytes
      if(expected.has(file))expectedBytes+=bytes
    }
  }
  return {
    uniqueSourceLinesRead:uniqueLines,uniqueSourceBytesRead:uniqueBytes,
    expectedSourceBytes:expectedBytes,nonExpectedSourceBytes:uniqueBytes-expectedBytes,
    expectedFileSourcePrecision:uniqueBytes?expectedBytes/uniqueBytes:null
  }
}
