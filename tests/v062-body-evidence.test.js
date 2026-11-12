import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { initializeProject } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
import { contextForTask } from '../src/query/query-service.js'
import { bodyTermCoverage } from '../src/query/precision.js'
import { makeWorkspace } from './helpers.js'

const CONTEXT = { sync:false, compact:true, depth:1, withSource:true, maxFiles:6, maxLines:160 }

async function fixture(files) {
  const w=await makeWorkspace()
  for(const dir of ['src','tests','python'])await fs.rm(path.join(w.repo,dir),{recursive:true,force:true})
  for(const [file,text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(w.repo,file)),{recursive:true})
    await fs.writeFile(path.join(w.repo,file),text)
  }
  await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
  return w
}

test('v0.6.2 body term coverage credits rare terms and ignores common ones', () => {
  const bodies=new Map([
    ['a.ts',['const storage = multer.diskStorage({ destination, filename })','// the request handler']],
    ['b.ts',['export function handler(request) { return request.body }']],
    ['c.ts',['export function other(request) { return request.query }']],
    ['d.ts',['export const requestLimit = 3']]
  ])
  const coverage=bodyTermCoverage(bodies,['destination','filename','disk','request','missing'])
  assert.deepEqual(coverage.get('a.ts').matched,['destination','filename','disk'])
  assert.equal(coverage.get('a.ts').covered,3)
  // `request` is in every file: it adds nothing anywhere.
  assert.equal(coverage.get('b.ts').covered,0)
  assert.deepEqual(coverage.get('b.ts').matched,[])
})

test('v0.6.2 a file whose body, not its names, carries the task terms becomes a target', async () => {
  const w=await fixture({
    // The answer: nothing in the path or the symbol names says destination, timestamp or filename.
    'src/middlewares/intake.ts':`import multer from 'multer'\n\nconst storage = multer.diskStorage({\n  destination: (req, file, cb) => cb(null, '/var/spool/sheets'),\n  // timestamp-based filename on disk\n  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)\n})\n\nexport const intake = multer({ storage })\n`,
    // Decoys whose names repeat one common word of the task.
    'src/models/ISend.ts':'export interface Send {\n  to: string\n  subject: string\n}\n',
    'src/models/IClient.ts':'export interface Client {\n  id: number\n  label: string\n}\n',
    'src/services/mail.ts':'export function sendMail(client, message) {\n  return client.post(message)\n}\n',
    'src/services/report.ts':'export function buildReport(rows) {\n  return rows.map(row => row.total)\n}\n',
    'src/services/ledger.ts':'export function postLedger(entries) {\n  return entries.length\n}\n'
  })
  const ctx=await contextForTask(w.repo,'When a client sends a spreadsheet file, where is the destination directory and the timestamp-based filename on disk decided?',{...CONTEXT,dirs:w.dirs})
  const grounded=[...ctx.targets,...ctx.relatedEvidence].filter(item=>item.source)
  assert.equal(ctx.targets[0].path,'src/middlewares/intake.ts')
  assert.match(grounded.find(item=>item.path==='src/middlewares/intake.ts').source,/diskStorage/)
})
