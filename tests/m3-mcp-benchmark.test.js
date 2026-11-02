import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { initializeProject } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
import { handleMcpMessage } from '../src/mcp/server.js'
import { benchmarkReport } from '../src/benchmark/report.js'
import { makeWorkspace } from './helpers.js'

test('MCP initialize/list/call exposes compact StellarCode tools', async () => {
  const w=await makeWorkspace()
  try {
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    // Keep the MCP test isolated from default OS app data by passing projectPath and env dirs through process.
    const init=await handleMcpMessage({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{defaultProject:w.repo})
    assert.equal(init.result.serverInfo.name,'stellarcode')
    const list=await handleMcpMessage({jsonrpc:'2.0',id:2,method:'tools/list',params:{}},{defaultProject:w.repo})
    assert.equal(list.result.tools.length,9)
    assert.ok(list.result.tools.some(tool=>tool.name==='stellar_projects'))
    assert.ok(list.result.tools.some(tool=>tool.name==='stellar_architecture'))
    assert.ok(list.result.tools.some(tool=>tool.name==='stellar_source'))
    const call=await handleMcpMessage({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'stellar_context',arguments:{task:'fix refresh token retry after 401'}}},{defaultProject:w.repo,queryOptions:{dirs:w.dirs}})
    assert.equal(call.result.isError,false)
    assert.ok(call.result.structuredContent.result.targets.some(v=>v.path==='src/auth/AuthService.ts'))
  } finally { await w.cleanup() }
})

test('benchmark reporter evaluates MVP acceptance thresholds', async () => {
  const w=await makeWorkspace()
  try {
    const b=path.join(w.base,'baseline.jsonl'),s=path.join(w.base,'stellar.jsonl')
    const baseline=[1,2,3,4].map(i=>JSON.stringify({schemaVersion:2,taskId:String(i),success:true,discoverySuccess:true,sourceGrounded:true,answerSuccess:true,discoveryToolCalls:20,discoveryTokens:10000,firstRelevantMs:10000,filesOpened:12})).join('\n')+'\n'
    const stellar=[1,2,3,4].map(i=>JSON.stringify({schemaVersion:2,taskId:String(i),success:true,discoverySuccess:true,sourceGrounded:true,answerSuccess:true,discoveryToolCalls:8,discoveryTokens:5000,firstRelevantMs:4000,filesOpened:5})).join('\n')+'\n'
    await fs.writeFile(b,baseline);await fs.writeFile(s,stellar)
    const report=await benchmarkReport(b,s)
    assert.equal(report.mvpThresholdsMet,true)
    assert.ok(report.delta.toolCallReductionPct>=50)
  } finally { await w.cleanup() }
})
