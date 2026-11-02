import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|rb|php|cs|c|cc|cpp|h|hpp|vue|svelte)$/i

function flattenStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) flattenStrings(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) flattenStrings(v, out)
  return out
}

function extractPaths(strings, cwd) {
  const found = new Set()
  for (const text of strings) {
    const tokens = text.match(/(?:[A-Za-z]:)?[^\s'"`|<>]+/g) ?? []
    for (let token of tokens) {
      token = token.replace(/[),;:]$/,'').replace(/^\.\//,'')
      if (!SOURCE_EXT.test(token)) continue
      const abs = path.isAbsolute(token) ? token : path.join(cwd, token)
      if (abs.startsWith(cwd)) found.add(path.relative(cwd, abs).replaceAll('\\','/'))
    }
  }
  return found
}

function parseJsonLine(line) {
  try { return JSON.parse(line) } catch { return null }
}

function finalJsonFromText(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch {}
  const start=text.indexOf('{'), end=text.lastIndexOf('}')
  if (start>=0 && end>start) { try { return JSON.parse(text.slice(start,end+1)) } catch {} }
  return null
}

function claudeUsage(raw = {}) {
  const input = Number(raw.input_tokens ?? 0)
  const cacheCreate = Number(raw.cache_creation_input_tokens ?? 0)
  const cacheRead = Number(raw.cache_read_input_tokens ?? 0)
  return {
    inputTokens: input + cacheCreate + cacheRead,
    uncachedInputTokens: input,
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheCreate,
    outputTokens: Number(raw.output_tokens ?? 0),
    reasoningOutputTokens: 0
  }
}

function codexUsage(raw = {}) {
  return {
    inputTokens: Number(raw.input_tokens ?? 0),
    uncachedInputTokens: Math.max(0, Number(raw.input_tokens ?? 0) - Number(raw.cached_input_tokens ?? 0)),
    cachedInputTokens: Number(raw.cached_input_tokens ?? 0),
    cacheWriteInputTokens: Number(raw.cache_write_input_tokens ?? 0),
    outputTokens: Number(raw.output_tokens ?? 0),
    reasoningOutputTokens: Number(raw.reasoning_output_tokens ?? 0)
  }
}

export function agentBinary(agent, env = process.env) {
  if (agent === 'claude') return env.STELLAR_BENCH_CLAUDE_BIN || 'claude'
  if (agent === 'codex') return env.STELLAR_BENCH_CODEX_BIN || 'codex'
  throw new Error(`Unsupported agent: ${agent}`)
}

function capture(bin,args,env) {
  return new Promise(resolve=>{
    const child=spawn(bin,args,{env,stdio:['ignore','pipe','pipe']})
    let out='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>out+=d)
    child.on('error',e=>resolve({code:null,out,error:e.message}))
    child.on('close',code=>resolve({code,out:out.trim(),error:null}))
  })
}

export async function commandVersion(agent, env = process.env) {
  const bin = agentBinary(agent, env)
  const version=await capture(bin,['--version'],env)
  if(version.code!==0)return {agent,bin,available:false,error:version.error??version.out??'not found',exitCode:version.code}
  const help=await capture(bin,agent==='codex'?['exec','--help']:['--help'],env)
  const required=agent==='codex'
    ? ['--json','--sandbox','--ephemeral','--ignore-user-config','--ignore-rules']
    : ['--output-format','--permission-mode','--allowedTools','--setting-sources','--strict-mcp-config','--mcp-config']
  const missingFlags=help.code===0?required.filter(flag=>!help.out.includes(flag)):required
  return {agent,bin,available:true,compatible:missingFlags.length===0,missingFlags,version:version.out,exitCode:version.code}
}

export function benchmarkPrompt(task, mode) {
  const common = `You are running a repository-navigation benchmark. Work only inside the current repository. Do not modify files.\n\nTask: ${task.prompt}\n\nReturn a concise final JSON object with exactly these fields: {"summary":"...","files":["repo/relative/path"],"symbols":["name"]}. The files field must contain the key source files that support your answer.`
  if (mode === 'baseline') return `${common}\n\nBenchmark condition: BASELINE. StellarCode is disabled. Use your normal repository exploration tools (search, grep, file reads, directory inspection) as needed.`
  return `${common}\n\nBenchmark condition: STELLAR. Before any broad repository search, run: stellar context ${JSON.stringify(task.prompt)} --json. Use stellar search/file/related when helpful. Then read only the source files needed to verify the answer. Do not fall back to broad find/tree/grep/rg unless StellarCode has insufficient evidence.`
}

export async function runAgent({ agent, task, mode, cwd, env, model, maxTurns, onEvent }) {
  const prompt = benchmarkPrompt(task, mode)
  const bin = agentBinary(agent, env)
  let args
  if (agent === 'codex') {
    args=['exec','--json','--sandbox','read-only','--ephemeral','--ignore-user-config','--ignore-rules']
    if (model) args.push('--model',model)
    args.push(prompt)
  } else {
    const isolationDir=env.STELLAR_CACHE_DIR || path.join(cwd,'.stellar-benchmark-cache')
    await fs.mkdir(isolationDir,{recursive:true})
    const emptyMcp=path.join(isolationDir,'empty-mcp.json')
    await fs.writeFile(emptyMcp,JSON.stringify({mcpServers:{}}))
    env={...env,ENABLE_CLAUDEAI_MCP_SERVERS:'false'}
    args=['-p',prompt,'--output-format','stream-json','--verbose','--permission-mode','dontAsk','--allowedTools','Bash,Read,Grep,Glob','--setting-sources','','--strict-mcp-config','--mcp-config',emptyMcp]
    if (model) args.push('--model',model)
    if (maxTurns) args.push('--max-turns',String(maxTurns))
  }

  const started=performance.now()
  const metrics={toolCalls:0,searchCalls:0,stellarCalls:0,filesOpened:new Set(),sourceBytesRead:0,firstRelevantMs:null,usage:{inputTokens:0,uncachedInputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0},costUsd:null,finalText:'',structured:null,rawEvents:0}
  const expected=new Set(task.expectedFiles.map(v=>v.replaceAll('\\','/')))
  const seenBytePaths=new Set()
  const pending=new Set()

  async function observeStrings(strings) {
    const paths=extractPaths(strings,cwd)
    for (const rel of paths) {
      metrics.filesOpened.add(rel)
      if (expected.has(rel) && metrics.firstRelevantMs===null) metrics.firstRelevantMs=Math.round(performance.now()-started)
      if (!seenBytePaths.has(rel)) {
        seenBytePaths.add(rel)
        try { const st=await fs.stat(path.join(cwd,rel));metrics.sourceBytesRead+=st.size } catch {}
      }
    }
  }

  function isSearchText(text) { return /(?:^|[\s;&|])(rg|grep|find|fd|tree|ls)(?:\s|$)/.test(text) || /search|glob|grep/i.test(text) }

  return await new Promise((resolve,reject)=>{
    const child=spawn(bin,args,{cwd,env,stdio:['ignore','pipe','pipe']})
    let stdout='',stderr='',buffer=''
    child.on('error',reject)
    child.stderr.on('data',d=>{stderr+=d.toString()})
    child.stdout.on('data',d=>{
      const text=d.toString();stdout+=text;buffer+=text
      const lines=buffer.split(/\r?\n/);buffer=lines.pop() ?? ''
      for (const line of lines) processLine(line)
    })

    async function processLine(line) {
      const event=parseJsonLine(line); if(!event)return
      metrics.rawEvents++
      onEvent?.(event)
      if (agent==='codex') {
        if (event.type==='turn.completed' && event.usage) metrics.usage=codexUsage(event.usage)
        const item=event.item
        if (event.type==='item.started' && item && ['command_execution','mcp_tool_call','web_search','file_change'].includes(item.type)) {
          metrics.toolCalls++
          const strings=flattenStrings(item)
          const joined=strings.join(' ')
          if(isSearchText(joined))metrics.searchCalls++
          if(/\bstellar\b/.test(joined))metrics.stellarCalls++
          { const p=observeStrings(strings);pending.add(p);p.finally(()=>pending.delete(p)) }
        }
        if(event.type==='item.completed' && item?.type==='agent_message' && item.text) metrics.finalText=item.text
      } else {
        if (event.type==='result') {
          metrics.usage=claudeUsage(event.usage)
          metrics.costUsd=event.total_cost_usd ?? null
          metrics.finalText=event.result ?? metrics.finalText
          metrics.structured=event.structured_output ?? null
        }
        const content=event?.message?.content
        if (event.type==='assistant' && Array.isArray(content)) {
          for (const block of content) if(block?.type==='tool_use') {
            metrics.toolCalls++
            const strings=flattenStrings(block.input)
            const joined=[block.name,...strings].join(' ')
            if(isSearchText(joined))metrics.searchCalls++
            if(/\bstellar\b/.test(joined))metrics.stellarCalls++
            { const p=observeStrings(strings);pending.add(p);p.finally(()=>pending.delete(p)) }
          }
        }
      }
    }

    child.on('close',async code=>{
      if(buffer.trim()) await processLine(buffer.trim())
      await Promise.allSettled([...pending])
      const durationMs=Math.round(performance.now()-started)
      const structured=metrics.structured ?? finalJsonFromText(metrics.finalText)
      resolve({exitCode:code,stdout,stderr,durationMs,metrics:{...metrics,filesOpened:[...metrics.filesOpened].sort(),structured}})
    })
  })
}
