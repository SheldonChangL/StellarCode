import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { initializeProject, readProjectMetadata } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
import { openProjectStore } from '../src/storage/project-store.js'
import { contextForTask } from '../src/query/query-service.js'
import { classifyIntent } from '../src/query/intent.js'
import { termMatch, weightedScore, termWeights, stemTerm, allocateBudget, subtractTaken, densestWindow } from '../src/query/precision.js'
import { makeWorkspace } from './helpers.js'

const CONTEXT = { sync:false, compact:true, depth:1, withSource:true, maxFiles:6, maxLines:160, maxBytes:12000 }

// Replaces the sample fixture source with the given files, then indexes them.
async function fixture(files) {
  const w=await makeWorkspace()
  await fs.rm(path.join(w.repo,'src'),{recursive:true,force:true})
  await fs.rm(path.join(w.repo,'tests'),{recursive:true,force:true})
  await fs.rm(path.join(w.repo,'python'),{recursive:true,force:true})
  for(const [file,text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(w.repo,file)),{recursive:true})
    await fs.writeFile(path.join(w.repo,file),text)
  }
  await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
  return w
}

function grounded(ctx) {
  return [...ctx.targets,...ctx.relatedEvidence].filter(item=>item.source)
}

function sourceBytes(ctx) {
  return grounded(ctx).reduce((sum,item)=>sum+Buffer.byteLength(item.source),0)
}

test('v0.5.5 intent model classifies task shape deterministically', () => {
  const cases=[
    ['Find the production game startup implementation and explain where services are constructed and scenes are registered.','navigation'],
    ['Trace how finishing aquarium cleaning applies progression. Identify the cleaning scene and the module that applies it.','flow'],
    ['Find what is affected if PredatorPressure changes.','impact'],
    ['I need to modify dodge timing.','editing-prep'],
    ['Find where login is implemented.','navigation'],
    ['Find the login implementation.','navigation'],
    ['What uses this service?','impact'],
    ['Where should I modify cleaning rewards?','editing-prep'],
    ['Prepare the files needed to edit startup behavior.','editing-prep'],
    ['Find how spawn scheduling works and where the scene constructs or consumes that scheduler.','flow'],
    ['Before adding a new cleaning tool, identify the scene that owns tool lifecycle.','editing-prep'],
    ['Which file owns session initialization?','navigation']
  ]
  for(const [prompt,expected] of cases) {
    const first=classifyIntent(prompt)
    assert.equal(first.intent,expected,prompt)
    assert.deepEqual(classifyIntent(prompt),first,'deterministic')
    assert.ok(first.confidence>0&&first.confidence<=1)
    assert.ok(Array.isArray(first.signals))
  }
  // "implementation"/"implemented" alone never imply editing.
  assert.ok(!classifyIntent('Find where login is implemented.').signals.some(signal=>signal.startsWith('editing-prep')))
})

test('v0.5.5 term matching is identifier-boundary aware', () => {
  assert.equal(termMatch('RushScene','rush'),'boundary')
  assert.equal(termMatch('src/game/rush/Spawner.ts','rush'),'boundary')
  assert.equal(termMatch('BrushTool','rush'),'inner')
  assert.ok(weightedScore('RushSpawner',['rush'])>weightedScore('BrushTool',['rush']))
  // Identifiers abbreviate derived words, but compound query identifiers are not derived words.
  assert.equal(termMatch('AuthService','authentication'),'abbrev')
  assert.equal(termMatch('login','loginflow'),null)
  assert.equal(stemTerm('finishing'),'finish')
  assert.equal(stemTerm('applies'),'apply')
  assert.equal(stemTerm('class'),'class')
  // A term present in every document carries less weight than a rare one.
  const weights=termWeights(['module','progression'],['a module','b module','c module progression'])
  assert.ok(weights.get('module')<weights.get('progression'))
})

test('v0.5.5 startup navigation keeps the application entry first and grounded', async () => {
  const w=await fixture({
    'src/main.ts':`import { services } from './game/services'
import { WebPlatformAdapter } from './platform/WebPlatformAdapter'
async function start() {
  const platform = new WebPlatformAdapter()
  services.platform = platform
  const scenes = ['BootScene', 'RushScene']
  return scenes
}
void start()
`,
    'src/game/services.ts':'export interface Services { platform: unknown }\nexport const services = {} as Services\n',
    'src/platform/WebPlatformAdapter.ts':'export class WebPlatformAdapter { gameReady() { return true } }\n',
    'src/game/scenes/RushScene.ts':'export class RushScene { startChase() { return 1 } }\n'
  })
  try {
    const ctx=await contextForTask(w.repo,'Find the production game startup implementation and explain where the game services are constructed and scenes are registered.',{dirs:w.dirs,...CONTEXT})
    assert.equal(ctx.intent,'navigation')
    assert.equal(ctx.targets[0].path,'src/main.ts')
    assert.equal(ctx.targets[0].symbol,'start')
    assert.match(ctx.targets[0].source,/async function start/)
    assert.ok(ctx.groundedFiles.includes('src/main.ts'))
  } finally {await w.cleanup()}
})

test('v0.5.5 flow grounds the callee used by the relevant method ahead of an imported constant', async () => {
  const w=await fixture({
    'src/config/balance.ts':'export const CLEANING = { enabled: true, reward: 3 }\n',
    'src/meta/RunFlow.ts':'export function applyEnd(save, run) {\n  save.level = run + 1\n  return save\n}\n',
    'src/scenes/Scene.ts':`import { CLEANING } from '../config/balance'
import { applyEnd } from '../meta/RunFlow'
export class Scene {
  create() {
    if (CLEANING.enabled) this.ready = true
  }
  finish() {
    return applyEnd({}, CLEANING.reward)
  }
}
`
  })
  try {
    const ctx=await contextForTask(w.repo,'Trace how the scene finish applies the end progression.',{dirs:w.dirs,...CONTEXT})
    assert.equal(ctx.intent,'flow')
    const target=ctx.targets.find(item=>item.path==='src/scenes/Scene.ts')
    assert.equal(target?.symbol,'Scene.finish')
    const callee=ctx.relatedEvidence.findIndex(item=>item.path==='src/meta/RunFlow.ts'&&item.symbol==='applyEnd'&&item.source)
    assert.ok(callee>=0,'callee is grounded related evidence')
    assert.equal(ctx.relatedEvidence[callee].relation,'imported-symbol')
    assert.match(ctx.relatedEvidence[callee].reason,/applyEnd used in Scene\.finish/)
    const constant=ctx.relatedEvidence.findIndex(item=>item.symbol==='CLEANING')
    assert.ok(constant<0||constant>callee,'an imported constant never outranks the used callee')
  } finally {await w.cleanup()}
})

test('v0.5.5 symbol selection picks the query-relevant method, not the class or first symbol', async () => {
  const body=Array.from({length:30},(_,i)=>`    this.counter${i} = ${i}`).join('\n')
  const w=await fixture({
    'src/rush/Spawner.ts':`export class Spawner {
  constructor() {
${body}
  }
  spawn(kind) {
    return { kind }
  }
  update(dt) {
    this.elapsed += dt
  }
  finish() {
    this.done = true
  }
}
`
  })
  try {
    const ctx=await contextForTask(w.repo,'Find the spawner update tick.',{dirs:w.dirs,...CONTEXT})
    assert.equal(ctx.targets[0].path,'src/rush/Spawner.ts')
    assert.equal(ctx.targets[0].symbol,'Spawner.update')
    const [start,end]=ctx.targets[0].lines
    assert.ok(end-start+1<20,`range is the method, not the class (${start}-${end})`)
  } finally {await w.cleanup()}
})

test('v0.5.5 body evidence selects the method range when only the class name matches the query', async () => {
  const filler=Array.from({length:40},(_,i)=>`  helper${i}() { return ${i} }`).join('\n')
  const w=await fixture({
    'src/rush/Spawner.ts':`export class Spawner {
  constructor() {
    this.ready = true
  }
${filler}
  tick(now) {
    const next = this.scheduleQueue.shift()
    if (next && next.due <= now) this.emit(next)
  }
}
`
  })
  try {
    const ctx=await contextForTask(w.repo,'Trace how the spawner drains the schedule queue.',{dirs:w.dirs,...CONTEXT})
    assert.equal(ctx.targets[0].path,'src/rush/Spawner.ts')
    assert.equal(ctx.targets[0].symbol,'Spawner.tick')
    assert.match(ctx.targets[0].source,/scheduleQueue\.shift/)
  } finally {await w.cleanup()}
})

test('v0.5.5 a long hub method does not win on incidental body and binding mentions', async () => {
  const filler=Array.from({length:120},(_,i)=>`    this.slot${i} = PRESSURE.base + ${i}`).join('\n')
  const w=await fixture({
    'src/config/predator.ts':'export const PRESSURE = { base: 1 }\n',
    'src/rush/Coordinator.ts':`import { PRESSURE } from '../config/predator'
export class Coordinator {
  create() {
    // pressure slots predator setup
${filler}
  }
  chooseSlots(count) {
    return Array.from({ length: count }, (_, i) => i * PRESSURE.base)
  }
}
`
  })
  try {
    const ctx=await contextForTask(w.repo,'If predator pressure positioning changes, identify the module that calculates pressure slots.',{dirs:w.dirs,...CONTEXT})
    assert.equal(ctx.intent,'impact')
    const target=ctx.targets.find(item=>item.path==='src/rush/Coordinator.ts')
    assert.equal(target?.symbol,'Coordinator.chooseSlots')
  } finally {await w.cleanup()}
})

test('v0.5.5 source budget is shared fairly: a giant primary cannot starve a small related function', async () => {
  const big=Array.from({length:150},(_,i)=>`  total += values[${i}] * ${i} // accumulate weighted progression value number ${i}`).join('\n')
  const w=await fixture({
    'src/meta/applyReward.ts':'export function applyReward(save, amount) {\n  save.coins += amount\n  return save\n}\n',
    'src/scenes/finishCleaning.ts':`import { applyReward } from '../meta/applyReward'
export function finishCleaning(save, values) {
  let total = 0
${big}
  return applyReward(save, total)
}
`
  })
  try {
    const ctx=await contextForTask(w.repo,'Trace how finishCleaning applies the reward.',{dirs:w.dirs,...CONTEXT,maxBytes:2000})
    assert.equal(ctx.intent,'flow')
    assert.ok(ctx.targets.some(item=>item.path==='src/scenes/finishCleaning.ts'&&item.source))
    assert.ok(ctx.relatedEvidence.some(item=>item.path==='src/meta/applyReward.ts'&&/save\.coins/.test(item.source)),'small related function still gets source')
    assert.ok(sourceBytes(ctx)<=2000,`budget respected (${sourceBytes(ctx)})`)
  } finally {await w.cleanup()}
})

test('v0.5.5 the same file range is never returned twice', async () => {
  const w=await fixture({
    'src/meta/RunFlow.ts':'export function applyCleaningEnd(save) {\n  save.done = true\n  return save\n}\n',
    'src/scenes/CleaningScene.ts':`import { applyCleaningEnd } from '../meta/RunFlow'
export class CleaningScene {
  finishCleaning() {
    return applyCleaningEnd({})
  }
}
`
  })
  try {
    const ctx=await contextForTask(w.repo,'Trace how finishing cleaning applies the cleaning end.',{dirs:w.dirs,...CONTEXT})
    const blocks=grounded(ctx)
    assert.ok(blocks.some(item=>item.path==='src/meta/RunFlow.ts'))
    for(const [i,a] of blocks.entries()) for(const b of blocks.slice(i+1)) {
      if(a.path!==b.path)continue
      assert.ok(a.lines[1]<b.lines[0]||b.lines[1]<a.lines[0],`overlapping source for ${a.path}`)
    }
  } finally {await w.cleanup()}
})

test('v0.5.5 type-only imports are indexed as contracts for editing-prep', async () => {
  const w=await fixture({
    'src/cleaning/CleaningTool.ts':'export interface CleaningTool {\n  update(dt: number): void\n  done(): boolean\n}\n',
    'src/cleaning/BrushTool.ts':"import type { CleaningTool } from './CleaningTool'\nexport class BrushTool implements CleaningTool {\n  update(dt: number) { void dt }\n  done() { return true }\n}\n",
    'src/scenes/CleaningScene.ts':`import type { CleaningTool } from '../cleaning/CleaningTool'
import { BrushTool } from '../cleaning/BrushTool'
export class CleaningScene {
  private tools: CleaningTool[] = []
  makeTool(): CleaningTool {
    const tool = new BrushTool()
    this.tools.push(tool)
    return tool
  }
}
`
  })
  try {
    const {db}=await openProjectStore(w.repo,await readProjectMetadata(w.repo),{dirs:w.dirs})
    try {
      const row=db.prepare(`SELECT e.metadata_json,e.confidence FROM edges e JOIN symbols s ON s.symbol_id=e.target_id
        WHERE e.source_id='src/scenes/CleaningScene.ts' AND e.edge_type='references' AND s.name='CleaningTool'`).get()
      assert.ok(row)
      assert.equal(JSON.parse(row.metadata_json).importKind,'type')
      assert.ok(row.confidence<0.9)
    } finally {db.close()}
    const ctx=await contextForTask(w.repo,'Before adding a new cleaning tool, identify the scene that owns tool lifecycle and the tool interface it consumes.',{dirs:w.dirs,...CONTEXT})
    assert.equal(ctx.intent,'editing-prep')
    assert.ok(ctx.groundedFiles.includes('src/scenes/CleaningScene.ts'))
    assert.ok(ctx.groundedFiles.includes('src/cleaning/CleaningTool.ts'))
  } finally {await w.cleanup()}
})

test('v0.5.5 impact context grounds the consumer that uses the changed module', async () => {
  const w=await fixture({
    'src/rush/PredatorPressure.ts':'export function chooseSlots(count) {\n  return Array.from({ length: count }, (_, i) => i)\n}\n',
    'src/scenes/GameScene.ts':`import { chooseSlots } from '../rush/PredatorPressure'
export class GameScene {
  updatePressure() {
    return chooseSlots(3)
  }
  draw() {
    return 0
  }
}
`
  })
  try {
    const ctx=await contextForTask(w.repo,'What is affected if PredatorPressure changes?',{dirs:w.dirs,...CONTEXT})
    assert.equal(ctx.intent,'impact')
    assert.equal(ctx.targets[0].path,'src/rush/PredatorPressure.ts')
    const consumer=ctx.relatedEvidence.find(item=>item.path==='src/scenes/GameScene.ts')
    assert.equal(consumer?.symbol,'GameScene.updatePressure')
    assert.equal(consumer.relation,'imported-by')
    assert.equal(consumer.direction,'incoming')
    assert.ok(consumer.source)
  } finally {await w.cleanup()}
})

test('v0.5.5 related hints stay metadata and never carry source', async () => {
  const w=await fixture({
    'src/helper.ts':'export function helper() { return 1 }\n',
    'src/feature.ts':"import { helper } from './helper'\nexport function loginFeature() { return helper() }\n"
  })
  try {
    const ctx=await contextForTask(w.repo,'Find loginFeature',{dirs:w.dirs,...CONTEXT})
    assert.ok(ctx.relatedHints.length>0)
    assert.ok(ctx.relatedHints.every(hint=>hint.source===undefined))
    assert.ok(ctx.relatedHints.every(hint=>!ctx.groundedFiles.includes(hint.path)))
  } finally {await w.cleanup()}
})

test('v0.5.5 budget allocation is max-min fair and deterministic', () => {
  // A giant first item must not consume the budget of later small items.
  assert.deepEqual(allocateBudget([{desired:10000},{desired:300},{desired:200}],1000),[500,300,200])
  assert.deepEqual(allocateBudget([{desired:100},{desired:100}],1000),[100,100])
  const weighted=allocateBudget([{desired:5000,weight:1.5},{desired:5000,weight:1}],1000)
  assert.equal(weighted[0]+weighted[1],1000)
  assert.ok(weighted[0]>weighted[1])
  assert.deepEqual(allocateBudget([{desired:0},{desired:50}],10),[0,10])
})

test('v0.5.5 range dedup and densest window helpers', () => {
  assert.deepEqual(subtractTaken([10,20],[]),[10,20])
  assert.equal(subtractTaken([10,20],[[8,22]]),null)
  assert.deepEqual(subtractTaken([10,30],[[10,13]]),[14,30])
  // Keeps the window holding the evidence, not the head of the range.
  assert.deepEqual(densestWindow([10,10,10,10,10],[0,0,0,5,5],20),[3,5])
  assert.deepEqual(densestWindow([10,10,10],[0,0,0],20),[0,2])
})

test('v0.5.5 review regressions: $-identifiers, nested classes, allocation cap, exact ties', async () => {
  const { focusRange, rankFileSymbols } = await import('../src/query/precision.js')
  const lines=Array.from({length:100},(_,i)=>i===80?'  $store.set(1)':`  line${i}()`)
  const focused=focusRange([1,100],lines,{names:['$store'],windowLines:40})
  assert.ok(focused[0]<=81&&focused[1]>=81,`window covers $store use (${focused})`)
  // Nested class demotion is independent of symbol order.
  const symbols=[
    {name:'Outer',qualified_name:'Outer',kind:'class',start_line:1,end_line:20},
    {name:'Inner',qualified_name:'Outer.Inner',kind:'class',start_line:2,end_line:10},
    {name:'spawnTick',qualified_name:'Outer.Inner.spawnTick',kind:'method',start_line:3,end_line:5}
  ]
  const order=list=>rankFileSymbols({symbols:list,lines:Array(20).fill('spawn'),terms:['spawn'],intent:'flow'}).map(e=>[e.symbol.qualified_name,e.score])
  assert.deepEqual(order(symbols),order([...symbols].reverse()))
  // The rounding remainder never exceeds what an item asked for.
  const allotted=allocateBudget([{desired:5000},{desired:5000},{desired:453}],1658)
  assert.ok(allotted[2]<=453)
  assert.ok(allotted.reduce((a,b)=>a+b,0)<=1658)
  assert.deepEqual(densestWindow([1,1,1,1],[0.1,0.2,0.2,0.1],2),[1,3])
})
