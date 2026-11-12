import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { initializeProject } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
import { contextForTask } from '../src/query/query-service.js'
import { completedEvidence } from '../src/benchmark/evidence.js'
import { runAgent } from '../src/benchmark/agents.js'
import { makeWorkspace } from './helpers.js'

test('v0.5.4 flow evidence prefers the imported behavior used by the query-relevant method', async () => {
  const w=await makeWorkspace()
  try {
    await fs.mkdir(path.join(w.repo,'src/game/scenes'),{recursive:true})
    await fs.mkdir(path.join(w.repo,'src/game/debug'),{recursive:true})
    await fs.mkdir(path.join(w.repo,'src/game/meta'),{recursive:true})
    await fs.mkdir(path.join(w.repo,'src/config'),{recursive:true})
    await fs.writeFile(path.join(w.repo,'src/config/balance.ts'),'export const CLEANING = { enabled: true }\n')
    await fs.writeFile(path.join(w.repo,'src/game/meta/ProgressionSystem.ts'),'export function getRunDefinition(run) { return run }\n')
    await fs.writeFile(path.join(w.repo,'src/game/meta/RunFlow.ts'),'export function applyCleaningEnd(save, run) { save.done = true; return run }\n')
    await fs.writeFile(path.join(w.repo,'src/game/scenes/RushScene.ts'),'export class RushScene { update() { return 1 } }\n')
    await fs.writeFile(path.join(w.repo,'src/game/debug/switchScene.ts'),'export function switchScene() { return true }\n')
    await fs.writeFile(path.join(w.repo,'src/game/scenes/CleaningScene.ts'),`import { CLEANING } from '../../config/balance'
import { getRunDefinition } from '../meta/ProgressionSystem'
import { applyCleaningEnd } from '../meta/RunFlow'
export class CleaningScene {
  create() { if (CLEANING.enabled) getRunDefinition(1) }
  private finishCleaning() { return applyCleaningEnd({}, 1) }
}
`)
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const ctx=await contextForTask(w.repo,'Trace how finishing aquarium cleaning applies progression. Identify the cleaning scene and the production module that applies the end-of-cleaning progression.',{dirs:w.dirs,sync:false,compact:true,depth:1,withSource:true,maxFiles:6,maxLines:160,maxBytes:12000})
    assert.equal(ctx.intent,'flow')
    assert.ok(ctx.relatedEvidence.some(e=>e.path==='src/game/meta/RunFlow.ts'&&e.symbol==='applyCleaningEnd'&&e.source))
  } finally {await w.cleanup()}
})

test('v0.5.4 startup navigation expands to start/main and does not become editing-prep', async () => {
  const w=await makeWorkspace()
  try {
    await fs.mkdir(path.join(w.repo,'src/game'),{recursive:true})
    await fs.mkdir(path.join(w.repo,'src/platform'),{recursive:true})
    await fs.writeFile(path.join(w.repo,'src/main.ts'),`import { services } from './game/services'
async function start() {
  services.ready = true
  const scenes = ['BootScene', 'RushScene']
  return scenes
}
void start()
`)
    await fs.writeFile(path.join(w.repo,'src/game/services.ts'),'export interface Services { ready: boolean }\nexport const services = {} as Services\n')
    await fs.writeFile(path.join(w.repo,'src/platform/WebPlatformAdapter.ts'),'export class WebPlatformAdapter { gameReady() { return true } }\n')
    await fs.writeFile(path.join(w.repo,'src/platform/YouTubePlatformAdapter.ts'),'export class YouTubePlatformAdapter { gameReady() { return true } }\n')
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const ctx=await contextForTask(w.repo,'Find the production game startup implementation and explain where the game services are constructed and scenes are registered.',{dirs:w.dirs,sync:false,compact:true,depth:1,withSource:true,maxFiles:6,maxLines:160,maxBytes:12000})
    assert.equal(ctx.intent,'navigation')
    assert.equal(ctx.targets[0].path,'src/main.ts')
    assert.match(ctx.targets[0].source,/async function start/)
  } finally {await w.cleanup()}
})

test('v0.5.4 evidence recognizes grep context prefixes and source paths from output', async () => {
  const w=await makeWorkspace()
  try {
    const file='src/auth/AuthService.ts'
    const source=(await fs.readFile(path.join(w.repo,file),'utf8')).split(/\r?\n/)
    const grep=`${file}:1:${source[0]}\n${file}-2-${source[1]}\n${file}-3-${source[2]}`
    const evidence=await completedEvidence({input:{name:'Grep',path:'src/auth',pattern:'auth'},output:grep,cwd:w.repo,ok:true,via:'Grep'})
    assert.ok(evidence.reads.some(read=>read.path===file&&read.startLine===1&&read.endLine>=3))
  } finally {await w.cleanup()}
})

test('v0.5.4 evidence extracts stellar source JSON even when shell output precedes it', async () => {
  const w=await makeWorkspace()
  try {
    const file='src/auth/AuthService.ts'
    const source=(await fs.readFile(path.join(w.repo,file),'utf8')).split(/\r?\n/).slice(0,6)
    const content=source.map((line,index)=>`${index+1}: ${line}`).join('\n')
    const output=`auth\n${JSON.stringify({path:file,lines:[1,6],content,sourceOfTruth:true})}`
    const evidence=await completedEvidence({input:`ls src; stellar source ${file} --lines 1:6 --json`,output,cwd:w.repo,ok:true,via:'Bash'})
    assert.ok(evidence.reads.some(read=>read.path===file&&read.startLine===1))
  } finally {await w.cleanup()}
})

test('v0.5.4 final JSON extraction ignores brace examples in prose before the answer', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stellar-json-answer-'))
  try {
    const fake=path.join(dir,'claude.mjs')
    const answer='Production uses new Phaser.Game({...}).\\n```json\\n{"summary":"ok","files":["src/main.ts"],"symbols":["start"]}\\n```'
    await fs.writeFile(fake,`#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'result',usage:{input_tokens:1,output_tokens:1},result:${JSON.stringify(answer)}}))\n`,{mode:0o755})
    const result=await runAgent({agent:'claude',task:{prompt:'Find startup'},mode:'baseline',cwd:dir,env:{...process.env,STELLAR_BENCH_CLAUDE_BIN:fake}})
    assert.deepEqual(result.metrics.structured,{summary:'ok',files:['src/main.ts'],symbols:['start']})
  } finally {await fs.rm(dir,{recursive:true,force:true})}
})
