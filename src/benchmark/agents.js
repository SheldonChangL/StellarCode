import fs from 'node:fs/promises'
import { openSync, writeSync, closeSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { completedEvidence, strings as flattenStrings } from './evidence.js'

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

function estimateTokens(value) { return Math.ceil(Buffer.byteLength(String(value ?? ''), 'utf8') / 4) }

function interactionKind(input) {
  const text=flattenStrings(input).join(' ').toLowerCase()
  if (/\bstellar\s+context\b/.test(text)) return 'stellarContext'
  if (/\bstellar\s+source\b/.test(text)) return 'stellarSource'
  if (/\b(cat|sed|head|tail|awk|bat|less|more)\b|\bread[_-]?file\b/.test(text)) return 'nativeSourceRead'
  return 'otherTool'
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
  const common = `You are running a repository-navigation benchmark. Work only inside the current repository. Do not modify files.

Task: ${task.prompt}

Repository source is the source of truth. Before making implementation claims, you must read the relevant source file or source range. Return a concise final JSON object with exactly these fields: {"summary":"...","files":["repo/relative/path"],"symbols":["name"]}. The files field must contain only key source files you actually read during this run.`
  if (mode === 'baseline') return `${common}

Benchmark condition: BASELINE. StellarCode is disabled. Use your normal repository exploration tools (search, grep, file reads, directory inspection) as needed. Do not list a file in the final answer unless you opened its source.`
  return `${common}

Benchmark condition: STELLAR. Before any broad repository search, run: stellar context ${JSON.stringify(task.prompt)} --compact --max-files 2 --max-lines 160 --max-bytes 8000 --json. Treat StellarCode metadata only as navigation evidence, never as source-of-truth. You must read source before implementation claims. Read only the returned primary source ranges first, preferably with: stellar source <path> --lines START:END --json. Start with the smallest returned evidence set. If a concrete unanswered question remains, run the same compact context with --depth 1 before reading another range. Do not answer from summaries alone. Do not fall back to broad find/tree/grep/rg unless StellarCode cannot provide useful targets.`
}

export async function runAgent({ agent, task, mode, cwd, env, model, maxTurns, onEvent, diagnosticDir, diagnostic = {} }) {
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

  const outputFiles=[]
  if (diagnosticDir) {
    await fs.mkdir(diagnosticDir,{recursive:true,mode:0o700})
    await fs.writeFile(path.join(diagnosticDir,'diagnostic.json'),JSON.stringify({...diagnostic,promptSent:prompt,cwd,PATH:env.PATH,agentBinary:bin,args},null,2)+'\n',{mode:0o600})
    for (const name of ['raw-events.jsonl','stdout.log','stderr.log','event-times.jsonl','interactions.jsonl']) outputFiles.push(openSync(path.join(diagnosticDir,name),'w',0o600))
  }
  const closeOutputs=()=>{for(const fd of outputFiles.splice(0))closeSync(fd)}
  const started=performance.now()
  const startedAtEpochMs=Date.now()
  const metrics={toolCalls:0,searchCalls:0,stellarCalls:0,filesMentioned:new Set(),filesOpened:new Set(),sourceReads:[],sourceBytesRead:0,firstRelevantMs:null,usage:{inputTokens:0,uncachedInputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0},costUsd:null,finalText:'',structured:null,rawEvents:0}
  const pending=new Set()
  const commands=[]
  const toolInputs=new Map(), interactions=[]
  let interactionSequence=0
  const countTool=(input,name)=>{
    const joined=[name,...flattenStrings(input)].join(' ')
    metrics.toolCalls++
    if(isSearchText(joined))metrics.searchCalls++
    if(/\bstellar\b|stellar_/.test(joined))metrics.stellarCalls++
    if(typeof input==='string')commands.push(input)
    else if(input?.command)commands.push(input.command)
  }
  const observe=(input,output,ok,via,startedAt=null)=>{
    const atMs=Math.round(performance.now()-started)
    const request=flattenStrings(input).join('\n'),response=flattenStrings(output).join('\n')
    const name=typeof input==='string'?input.slice(0,120):(input?.tool??input?.name??via)
    const interaction={sequence:++interactionSequence,tool:name,kind:interactionKind(input),requestBytes:Buffer.byteLength(request),responseBytes:Buffer.byteLength(response),estimatedRequestTokens:estimateTokens(request),estimatedResponseTokens:estimateTokens(response),durationMs:startedAt==null?null:Math.max(0,atMs-startedAt),success:Boolean(ok)}
    interactions.push(interaction)
    if(outputFiles.length)writeSync(outputFiles[4],JSON.stringify(interaction)+'\n')
    const evidenceVia=/\bstellar\s+source\b|stellar_source/.test(flattenStrings(input).join(' '))?'stellar':via
    const p=completedEvidence({input,output,ok,cwd,atMs,via:evidenceVia}).then(e=>{
      for(const file of e.discovered)metrics.filesMentioned.add(file)
      for(const read of e.reads){metrics.filesOpened.add(read.path);metrics.sourceReads.push(read);metrics.sourceBytesRead+=read.bytes}
    })
    pending.add(p);p.finally(()=>pending.delete(p))
  }

  function isSearchText(text) { return /(?:^|[\s;&|])(rg|grep|find|fd|tree|ls)(?:\s|$)/.test(text) || /search|glob|grep/i.test(text) }

  return await new Promise((resolve,reject)=>{
    const child=spawn(bin,args,{cwd,env,stdio:['ignore','pipe','pipe']})
    let stdout='',stderr='',buffer=''
    child.on('error',error=>{closeOutputs();reject(error)})
    child.stderr.on('data',d=>{if(outputFiles.length)writeSync(outputFiles[2],d);stderr+=d.toString()})
    child.stdout.on('data',d=>{
      if(outputFiles.length){writeSync(outputFiles[0],d);writeSync(outputFiles[1],d)}
      const text=d.toString();stdout+=text;buffer+=text
      const lines=buffer.split(/\r?\n/);buffer=lines.pop() ?? ''
      for (const line of lines) processLine(line)
    })

    async function processLine(line) {
      const event=parseJsonLine(line); if(!event)return
      metrics.rawEvents++
      if(outputFiles.length)writeSync(outputFiles[3],JSON.stringify({event:metrics.rawEvents,atMs:Math.round(performance.now()-started),type:event.type,itemId:event.item?.id??null})+'\n')
      onEvent?.(event)
      if (agent==='codex') {
        if (event.type==='turn.completed' && event.usage) metrics.usage=codexUsage(event.usage)
        const item=event.item
        if (event.type==='item.started' && item && ['command_execution','mcp_tool_call','web_search','file_change','file_read','read_file','tool_call'].includes(item.type)) {
          const input=item.command??{tool:item.tool,input:item.arguments??item.input??item}
          toolInputs.set(item.id,{input,startedAt:Math.round(performance.now()-started)})
          countTool(input,item.tool??item.type)
        }
        if(event.type==='item.completed' && item && item.type!=='agent_message') {
          const recorded=toolInputs.get(item.id)
          const input=recorded?.input??item.command??item.arguments??item.input
          if(input) {
            const output=item.aggregated_output??item.result??item.output??item.content
            const ok=item.type==='command_execution'?item.exit_code===0:item.status!=='failed'&&!item.error&&!item.is_error&&item.result?.isError!==true
            observe(input,output,ok,item.type,recorded?.startedAt)
          }
        }
        if(event.type==='item.completed' && item?.type==='agent_message' && item.text) metrics.finalText=item.text
      } else {
        if (event.type==='result') {
          metrics.usage=claudeUsage(event.usage)
          metrics.costUsd=event.total_cost_usd ?? null
          metrics.finalText=event.result ?? metrics.finalText
          metrics.structured=event.structured_output ?? null
        }
        if(event.type==='user' && Array.isArray(event.message?.content)) {
          for(const block of event.message.content) if(block.type==='tool_result') {
            const tool=toolInputs.get(block.tool_use_id)
            if(tool)observe(tool.input,block.content,!block.is_error,tool.name,tool.startedAt)
          }
        }
        const content=event?.message?.content
        if (event.type==='assistant' && Array.isArray(content)) {
          for (const block of content) if(block?.type==='tool_use') {
            toolInputs.set(block.id,{name:block.name,input:block.input,startedAt:Math.round(performance.now()-started)})
            countTool(block.input,block.name)
          }
        }
      }
    }

    child.on('close',async code=>{
      if(buffer.trim()) await processLine(buffer.trim())
      closeOutputs()
      await Promise.allSettled([...pending])
      const durationMs=Math.round(performance.now()-started)
      const structured=metrics.structured ?? finalJsonFromText(metrics.finalText)
      if(diagnosticDir) {
        const estimated={benchmarkPrompt:estimateTokens(prompt),stellarContextRequest:0,stellarContextResponse:0,stellarSourceRequest:0,stellarSourceResponse:0,nativeSourceReads:0,otherToolInputs:0,otherToolOutputs:0}
        for(const interaction of interactions) {
          if(interaction.kind==='stellarContext') { estimated.stellarContextRequest+=interaction.estimatedRequestTokens;estimated.stellarContextResponse+=interaction.estimatedResponseTokens }
          else if(interaction.kind==='stellarSource') { estimated.stellarSourceRequest+=interaction.estimatedRequestTokens;estimated.stellarSourceResponse+=interaction.estimatedResponseTokens }
          else if(interaction.kind==='nativeSourceRead') estimated.nativeSourceReads+=interaction.estimatedResponseTokens
          else { estimated.otherToolInputs+=interaction.estimatedRequestTokens;estimated.otherToolOutputs+=interaction.estimatedResponseTokens }
        }
        estimated.knownTotal=Object.values(estimated).reduce((sum,value)=>sum+value,0)
        estimated.unattributedVsProvider=Math.max(0,metrics.usage.inputTokens-estimated.knownTotal)
        await fs.writeFile(path.join(diagnosticDir,'token-attribution.json'),JSON.stringify({providerReported:{inputTokens:metrics.usage.inputTokens,cachedInputTokens:metrics.usage.cachedInputTokens,outputTokens:metrics.usage.outputTokens},estimated:{...estimated,note:'Estimated from UTF-8 bytes divided by four; provider input includes model context and tool schema that cannot be attributed exactly.'},interactions},null,2)+'\n')
      }
      resolve({exitCode:code,stdout,stderr,durationMs,startedAtEpochMs,commands,metrics:{...metrics,interactions,filesMentioned:[...metrics.filesMentioned].sort(),filesOpened:[...metrics.filesOpened].sort(),structured}})
    })
  })
}
