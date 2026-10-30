#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { initializeProject } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
const execFileAsync=promisify(execFile)
const base=await fs.mkdtemp(path.join(os.tmpdir(),'stellar-10k-'))
const repo=path.join(base,'repo');await fs.mkdir(repo,{recursive:true})
const dirs={data:path.join(base,'data'),cache:path.join(base,'cache'),logs:path.join(base,'logs')}
try{
  for(let d=0;d<100;d++){
    const dir=path.join(repo,'src',`m${String(d).padStart(3,'0')}`);await fs.mkdir(dir,{recursive:true})
    const jobs=[]
    for(let i=0;i<100;i++)jobs.push(fs.writeFile(path.join(dir,`f${String(i).padStart(3,'0')}.js`),`export function f_${d}_${i}(x) { return x + ${i}; }\n`))
    await Promise.all(jobs)
  }
  await execFileAsync('git',['-C',repo,'init','-q']);await execFileAsync('git',['-C',repo,'config','user.email','benchmark@stellar.local']);await execFileAsync('git',['-C',repo,'config','user.name','Stellar Benchmark']);await execFileAsync('git',['-C',repo,'add','.']);await execFileAsync('git',['-C',repo,'commit','-qm','10k fixture'])
  await initializeProject(repo)
  const full=await syncProject(repo,{dirs,force:true})
  const warm=await syncProject(repo,{dirs})
  console.log(JSON.stringify({files:full.files,fullMs:full.durationMs,warmMs:warm.durationMs,noChange:warm.noChange,fastPath:warm.fastPath,targetWarmMs:500,passesWarmTarget:warm.durationMs<=500},null,2))
}finally{await fs.rm(base,{recursive:true,force:true})}
