import fs from 'node:fs/promises'
import { openSync, writeSync, closeSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { completedEvidence, strings as flattenStrings } from './evidence.js'
import { GROUNDING_CONTRACT } from './delivery.js'

function parseJsonLine(line) {
  try { return JSON.parse(line) } catch { return null }
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

function finalJsonFromText(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch {}
  // Claude often explains first and then emits the requested JSON. Prose may itself
  // contain brace examples such as `new Game({...})`, so first-{ / last-} is unsafe.
  const objects=jsonObjectsFromText(text)
  for(let i=objects.length-1;i>=0;i--) {
    try { return JSON.parse(objects[i]) } catch {}
  }
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

// The exact StellarCode context command the STELLAR condition must run first. Shared with
// the local latency benchmark so both measure the same request. Built from the prompt only.
export const STELLAR_CONTEXT_FLAGS = ['--compact', '--with-source', '--depth', '1', '--max-files', '6', '--max-lines', '160', '--max-bytes', '12000', '--json']
export function stellarContextArgs(prompt) { return ['context', String(prompt), ...STELLAR_CONTEXT_FLAGS] }

const STELLAR_GUIDANCE = `Any item in targets or relatedEvidence with a "source" field contains repository source read live from the working tree, with line numbers, and counts as inspected source for that range. Do not re-read those same embedded ranges. relatedHints are navigation metadata only: never list a hinted file in the final answer unless you separately inspect its source. Paths, symbols, confidence values and relation metadata without source are never source-of-truth. If targets plus relatedEvidence cover every part the task asks about, answer immediately with no further tool calls. If a concrete part is still unsupported, inspect only the smallest relevant hinted file/range (stellar source <path> --lines START:END --json or your file reader), then answer. Do not answer from paths or symbol names alone. Do not fall back to broad find/tree/grep/rg unless the returned grounded evidence is clearly unrelated.`

// The prompt is built from the task prompt and, for prefetch modes, the StellarCode
// envelope only. Benchmark metadata (category, expected files, match mode) is never an
// input here: callers pass { prompt } alone.
export function benchmarkPrompt(task, mode, { envelope = null } = {}) {
  const common = `You are running a repository-navigation benchmark. Work only inside the current repository. Do not modify files.

Task: ${task.prompt}

Repository source is the source of truth. Before making implementation claims, you must read the relevant source file or source range. Return a concise final JSON object with exactly these fields: {"summary":"...","files":["repo/relative/path"],"symbols":["name"]}. The files field must contain only key source files you actually read during this run.`
  if (mode === 'baseline') return `${common}

Benchmark condition: BASELINE. StellarCode is disabled. Use your normal repository exploration tools (search, grep, file reads, directory inspection) as needed. Do not list a file in the final answer unless you opened its source.`
  if (mode === 'prefetch' || mode === 'prefetch-contract') {
    if (!envelope) throw new Error(`${mode} requires a prefetched StellarCode envelope`)
    // Identical to the pull condition except for delivery: the output of the same
    // stellar context command is already attached, so no first call is needed.
    const contract = mode === 'prefetch-contract' ? `\n\nGrounding contract: ${GROUNDING_CONTRACT}` : ''
    return `${common}

Benchmark condition: STELLAR. The output of the command stellar context ${JSON.stringify(task.prompt)} ${STELLAR_CONTEXT_FLAGS.join(' ')} was already retrieved for this repository before you started; it is attached below as <stellar-grounded-context> (targets and related evidence with source, then related hints). Do not run that command again. ${STELLAR_GUIDANCE}

${envelope}${contract}`
  }
  return `${common}

Benchmark condition: STELLAR. Your first action must be exactly one command: stellar context ${JSON.stringify(task.prompt)} ${STELLAR_CONTEXT_FLAGS.join(' ')}. ${STELLAR_GUIDANCE}`
}

export async function runAgent({ agent, task, mode, cwd, env, model, maxTurns, onEvent, diagnosticDir, diagnostic = {}, envelope = null }) {
  const prompt = benchmarkPrompt({ prompt: task.prompt }, mode, { envelope })
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
  const metrics={timing:{firstEventMs:null,firstModelEventMs:null},toolCalls:0,searchCalls:0,stellarCalls:0,filesMentioned:new Set(),filesOpened:new Set(),sourceReads:[],sourceBytesRead:0,firstRelevantMs:null,usage:{inputTokens:0,uncachedInputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0},costUsd:null,finalText:'',structured:null,rawEvents:0,turns:[],resultNumTurns:null}
  // Model turns: one per distinct assistant message id (one provider call each). Usage on
  // an assistant message is that call's own input accounting.
  const turnById=new Map()
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
  const observe=(input,output,ok,via,startedAt=null,turn=null)=>{
    const atMs=Math.round(performance.now()-started)
    const request=flattenStrings(input).join('\n'),response=flattenStrings(output).join('\n')
    const name=typeof input==='string'?input.slice(0,120):(input?.tool??input?.name??via)
    const interaction={sequence:++interactionSequence,turn,tool:name,kind:interactionKind(input),search:isSearchText([name,...flattenStrings(input)].join(' ')),requestBytes:Buffer.byteLength(request),responseBytes:Buffer.byteLength(response),estimatedRequestTokens:estimateTokens(request),estimatedResponseTokens:estimateTokens(response),durationMs:startedAt==null?null:Math.max(0,atMs-startedAt),startedAtMs:startedAt,completedAtMs:atMs,success:Boolean(ok)}
    if(interaction.kind==='stellarContext') {
      // Which file the agent's own context call returned first (delivery stratification).
      const text=flattenStrings(output).join('\n')
      for(const candidate of [text,...jsonObjectsFromText(text).reverse()]) {
        try { const parsed=JSON.parse(candidate); if(parsed?.targets){interaction.topTarget=parsed.targets[0]?.path??null;break} } catch {}
      }
    }
    interactions.push(interaction)
    if(outputFiles.length)writeSync(outputFiles[4],JSON.stringify(interaction)+'\n')
    const evidenceVia=/\bstellar\s+source\b|stellar_source/.test(flattenStrings(input).join(' '))?'stellar':interaction.kind==='stellarContext'?'stellar-context':via
    const p=completedEvidence({input,output,ok,cwd,atMs,via:evidenceVia}).then(e=>{
      for(const file of e.discovered)metrics.filesMentioned.add(file)
      for(const read of e.reads){const r={...read,turn};metrics.filesOpened.add(r.path);metrics.sourceReads.push(r);metrics.sourceBytesRead+=r.bytes}
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
      const eventAtMs=Math.round(performance.now()-started)
      if(metrics.timing.firstEventMs==null)metrics.timing.firstEventMs=eventAtMs
      if(metrics.timing.firstModelEventMs==null && (event.type==='assistant' || (event.type==='item.started'||event.type==='item.completed')))metrics.timing.firstModelEventMs=eventAtMs
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
          metrics.resultNumTurns=Number.isFinite(Number(event.num_turns))?Number(event.num_turns):null
        }
        if(event.type==='user' && Array.isArray(event.message?.content)) {
          for(const block of event.message.content) if(block.type==='tool_result') {
            const tool=toolInputs.get(block.tool_use_id)
            if(tool)observe(tool.input,block.content,!block.is_error,tool.name,tool.startedAt,tool.turn)
          }
        }
        const content=event?.message?.content
        let turn=null
        if (event.type==='assistant' && event.message?.id) {
          if(!turnById.has(event.message.id)){const record={turn:turnById.size+1,id:event.message.id,inputTokens:null,outputTokens:null,toolUses:0};turnById.set(event.message.id,record);metrics.turns.push(record)}
          const record=turnById.get(event.message.id);turn=record.turn
          const usage=event.message.usage
          if(usage)record.inputTokens=Number(usage.input_tokens??0)+Number(usage.cache_creation_input_tokens??0)+Number(usage.cache_read_input_tokens??0),record.outputTokens=Number(usage.output_tokens??0)
          if(Array.isArray(content))record.toolUses+=content.filter(block=>block?.type==='tool_use').length
        }
        if (event.type==='assistant' && Array.isArray(content)) {
          for (const block of content) if(block?.type==='tool_use') {
            toolInputs.set(block.id,{name:block.name,input:block.input,startedAt:Math.round(performance.now()-started),turn})
            countTool(block.input,block.name)
          }
        }
      }
    }

    child.on('close',async (code,signal)=>{
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
      resolve({exitCode:code,signal:signal??null,stdout,stderr,durationMs,startedAtEpochMs,commands,metrics:{...metrics,interactions,filesMentioned:[...metrics.filesMentioned].sort(),filesOpened:[...metrics.filesOpened].sort(),structured}})
    })
  })
}
