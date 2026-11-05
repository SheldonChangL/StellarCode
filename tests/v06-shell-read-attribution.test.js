import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { completedEvidence, sourceCoverage } from '../src/benchmark/evidence.js'
import { tokenizeShell, splitCommands } from '../src/benchmark/shell-reads.js'

const A='export function saveUser(user) {\n  return database.insert("users", user)\n}\n'
const B='export const LABOR_RIGHT_QUERY = `\n  query LaborRight($id: ID!) {\n    laborRight(id: $id) { title updatedAt }\n  }\n`\n'
const C=Array.from({length:40},(_,i)=>`export const value${i+1} = computeSomething(${i+1}, "line ${i+1}")`).join('\n')+'\n'
const SPACED='export function spacedPath(input) {\n  return normalizeEverything(input)\n}\n'

async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'shell-reads-'))
  await fs.mkdir(path.join(root,'src','repo'),{recursive:true})
  await fs.mkdir(path.join(root,'src','graphql'),{recursive:true})
  await fs.mkdir(path.join(root,'src','my dir'),{recursive:true})
  await fs.writeFile(path.join(root,'src','repo','a.ts'),A)
  await fs.writeFile(path.join(root,'src','graphql','laborRight.ts'),B)
  await fs.writeFile(path.join(root,'src','repo','c.ts'),C)
  await fs.writeFile(path.join(root,'src','my dir','spaced.ts'),SPACED)
  return {root,cleanup:()=>fs.rm(root,{recursive:true,force:true})}
}

const evidence=(root,command,output)=>completedEvidence({input:{command},output,cwd:root,ok:true,atMs:0,via:'Bash'})
const paths=e=>[...new Set(e.reads.map(r=>r.path))].sort()

test('v0.6 cd-relative cat counts as a read of the repository-relative file', async () => {
  const f=await fixture()
  try {
    for(const command of ['cd src/repo && cat a.ts','cd src/repo; cat a.ts']) {
      const e=await evidence(f.root,command,A)
      assert.deepEqual(paths(e),['src/repo/a.ts'],command)
      assert.equal(e.reads[0].startLine,1);assert.equal(e.reads[0].endLine,3)
    }
    // Without the cd the literal path does not exist, so no read is invented.
    assert.deepEqual(paths(await evidence(f.root,'cat a.ts',A)),[])
  } finally { await f.cleanup() }
})

test('v0.6 cd-relative sed range reads only the printed lines', async () => {
  const f=await fixture()
  try {
    const printed=C.split('\n').slice(9,30).join('\n')+'\n'
    for(const command of ["cd src/repo && sed -n '10,30p' c.ts","cd src/repo; sed -n '10,30p' c.ts"]) {
      const e=await evidence(f.root,command,printed)
      assert.deepEqual(e.reads.map(r=>[r.path,r.startLine,r.endLine]),[['src/repo/c.ts',10,30]],command)
    }
    const direct=await evidence(f.root,"sed -n '10,30p' src/repo/c.ts",printed)
    assert.deepEqual(direct.reads.map(r=>[r.path,r.startLine,r.endLine]),[['src/repo/c.ts',10,30]])
  } finally { await f.cleanup() }
})

test('v0.6 glob and brace reads expand against the snapshot', async () => {
  const f=await fixture()
  try {
    const glob=await evidence(f.root,'cat src/graphql/laborRight.*',B)
    assert.deepEqual(paths(glob),['src/graphql/laborRight.ts'])
    const both=await evidence(f.root,'cat src/repo/*.ts',A+C)
    assert.deepEqual(paths(both),['src/repo/a.ts','src/repo/c.ts'])
    const brace=await evidence(f.root,'cat src/repo/{a,c}.ts',A+C)
    assert.deepEqual(paths(brace),['src/repo/a.ts','src/repo/c.ts'])
    // A glob with no match yields no file and no read.
    const none=await evidence(f.root,'cat src/missing/*.ts',A)
    assert.deepEqual(paths(none),[])
    assert.ok(!none.discovered.some(p=>p.includes('missing')))
  } finally { await f.cleanup() }
})

test('v0.6 multiple files and multiple command segments are all attributed', async () => {
  const f=await fixture()
  try {
    const multi=await evidence(f.root,'cat src/repo/a.ts src/graphql/laborRight.ts',A+B)
    assert.deepEqual(paths(multi),['src/graphql/laborRight.ts','src/repo/a.ts'])
    const chain=await evidence(f.root,'cd src && cat repo/a.ts && cat graphql/laborRight.ts',A+B)
    assert.deepEqual(paths(chain),['src/graphql/laborRight.ts','src/repo/a.ts'])
    const printed=C.split('\n').slice(0,20).join('\n')+'\n'
    const mixed=await evidence(f.root,"cd src/repo; cat a.ts; sed -n '1,20p' c.ts",A+printed)
    assert.deepEqual(mixed.reads.map(r=>[r.path,r.startLine,r.endLine]).sort(),[['src/repo/a.ts',1,3],['src/repo/c.ts',1,20]])
    const head=await evidence(f.root,'cd src/repo && head c.ts && tail -n 3 a.ts',C.split('\n').slice(0,10).join('\n')+'\n'+A)
    assert.deepEqual(paths(head),['src/repo/a.ts','src/repo/c.ts'])
    const wrapped=await evidence(f.root,"bash -lc 'cd src/repo && cat a.ts'",A)
    assert.deepEqual(paths(wrapped),['src/repo/a.ts'])
  } finally { await f.cleanup() }
})

test('v0.6 symlinked cwd and absolute paths resolve to the real repository file', async () => {
  const f=await fixture()
  const link=f.root+'-link'
  try {
    await fs.symlink(f.root,link)
    const viaLink=await completedEvidence({input:{command:'cd src/repo && cat a.ts'},output:A,cwd:link,ok:true,atMs:0,via:'Bash'})
    assert.deepEqual(paths(viaLink),['src/repo/a.ts'])
    await fs.symlink(path.join(f.root,'src','repo'),path.join(f.root,'repo-link'))
    const symlinkDir=await evidence(f.root,'cd repo-link && cat a.ts',A)
    assert.deepEqual(paths(symlinkDir),['src/repo/a.ts'],'cd through a symlinked directory normalizes to the real path')
    const absolute=await evidence(f.root,`cat ${path.join(await fs.realpath(f.root),'src','repo','a.ts')}`,A)
    assert.deepEqual(paths(absolute),['src/repo/a.ts'])
  } finally { await fs.rm(link,{force:true}); await f.cleanup() }
})

test('v0.6 quoted paths with spaces and grep output inside a cd directory', async () => {
  const f=await fixture()
  try {
    const quoted=await evidence(f.root,'cat "src/my dir/spaced.ts"',SPACED)
    assert.deepEqual(paths(quoted),['src/my dir/spaced.ts'])
    const cdQuoted=await evidence(f.root,"cd 'src/my dir' && cat spaced.ts",SPACED)
    assert.deepEqual(paths(cdQuoted),['src/my dir/spaced.ts'])
    const grep=await evidence(f.root,'cd src && grep -rn insert .','./repo/a.ts:1:export function saveUser(user) {\n./repo/a.ts:2:  return database.insert("users", user)\n')
    assert.deepEqual(grep.reads.map(r=>[r.path,r.startLine,r.endLine]),[['src/repo/a.ts',1,2]])
  } finally { await f.cleanup() }
})

test('v0.6 shell attribution never invents reads: output must still match source verbatim', async () => {
  const f=await fixture()
  try {
    const e=await evidence(f.root,'cd src/repo && cat a.ts','cat: a.ts: Permission denied\n')
    assert.deepEqual(e.reads,[])
    const failed=await completedEvidence({input:{command:'cd src/repo && cat a.ts'},output:A,cwd:f.root,ok:false,atMs:0,via:'Bash'})
    assert.deepEqual(failed.reads,[])
    // Unsupported constructs stop cwd tracking instead of guessing.
    const unsafe=await evidence(f.root,'cd $REPO_DIR && cat a.ts',A)
    assert.deepEqual(paths(unsafe),[])
    const dynamicGroup=await evidence(f.root,'(cd src/repo && cat a.ts)',A)
    assert.deepEqual(paths(dynamicGroup),[],'subshell cd is not trusted (conservative)')
  } finally { await f.cleanup() }
})

test('v0.6 coverage of shell-relative reads feeds unique source bytes', async () => {
  const f=await fixture()
  try {
    const e1=await evidence(f.root,'cd src/repo && cat a.ts',A)
    const e2=await evidence(f.root,'cat src/repo/a.ts',A)
    const coverage=await sourceCoverage(f.root,[...e1.reads,...e2.reads],['src/repo/a.ts'])
    assert.equal(coverage.uniqueSourceBytesRead,Buffer.byteLength(A))
    assert.equal(coverage.expectedSourceBytes,Buffer.byteLength(A))
    assert.equal(coverage.uniqueSourceLinesRead,3)
  } finally { await f.cleanup() }
})

test('v0.6 shell tokenizer keeps quotes, operators and escapes conservative', () => {
  const commands=splitCommands(tokenizeShell("cd 'a b' && cat x\\ y.ts | head -n 2; sed -n '1,2p' z.ts"))
  assert.deepEqual(commands.map(c=>c.words.map(w=>w.value.replaceAll('\u0000',''))),[['cd','a b'],['cat','x y.ts'],['head','-n','2'],['sed','-n','1,2p','z.ts']])
  assert.equal(tokenizeShell("cat 'unterminated"),null)
})
