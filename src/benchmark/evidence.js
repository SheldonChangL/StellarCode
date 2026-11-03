import fs from 'node:fs/promises'
import path from 'node:path'

export function strings(value, out=[]) {
  if(typeof value==='string') out.push(value)
  else if(Array.isArray(value)) for(const v of value) strings(v,out)
  else if(value && typeof value==='object') for(const v of Object.values(value)) strings(v,out)
  return out
}

// `roots` may list several spellings of the same directory (for example macOS
// /var/... and its realpath /private/var/...); agents may report either.
export function sourcePaths(value, roots) {
  const result=new Set()
  const bases=Array.isArray(roots)?roots:[roots]
  for(const text of strings(value)) {
    for(let token of text.match(/(?:[A-Za-z]:)?[^\s'"`|<>]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|rb|php|cs|c|cc|cpp|h|hpp|vue|svelte)\b/g)??[]) {
      for(const base of bases) {
        const rel=path.relative(base,path.resolve(bases[0],token)).replaceAll('\\','/')
        if(rel && rel!=='..' && !rel.startsWith('../') && !path.isAbsolute(rel)){result.add(rel);break}
      }
    }
  }
  return [...result]
}

function outputStrings(value) {
  const out=[]
  for(const text of strings(value)) {
    try {out.push(...strings(JSON.parse(text)))} catch {out.push(text)}
  }
  return out
}

// Evidence comes from completed tool output, matched against repository source.
// A command name or a path in tool arguments alone is never a source read.
export async function completedEvidence({input,output,cwd,ok,atMs,via}) {
  if(!ok)return {discovered:[],reads:[]}
  let roots=[cwd]
  try {const real=await fs.realpath(cwd); if(real!==cwd)roots.push(real)} catch {}
  const discovered=sourcePaths([input,output],roots)
  const text=strings(input).join(' ')
  // `stellar context --with-source` returns live source excerpts; those count as reads
  // only where the returned lines match repository source verbatim (checked below).
  const contextWithSource=/\bstellar\s+context\b.*--with-source|stellar_context/.test(text)
  const navigation=/\bstellar\s+(context|search|find|file|symbol|related|impact|architecture)\b|stellar_(context|search|find|file|symbol|related|impact|architecture)/.test(text)
  if(navigation && !contextWithSource)return {discovered,reads:[]}
  const candidates=contextWithSource?sourcePaths(output,roots):sourcePaths(input,roots)
  const outputs=outputStrings(output)
  const reads=[]
  for(const rel of candidates) {
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
      const returned=output.split(/\r?\n/).map(line=>{
        const numbered=line.match(/^\s*(\d+)(?:: |\t|\s{2,})(.*)$/)
        return numbered?{text:numbered[2],line:Number(numbered[1])}:{text:line,line:null}
      })
      for(let i=0;i<returned.length;i++) {
        if(!returned[i].text.trim())continue
        let bestStart=-1,bestCount=0
        for(let start=0;start<lines.length;start++) {
          if(returned[i].line!==null && returned[i].line!==start+1)continue
          let count=0
          while(start+count<lines.length && i+count<returned.length && lines[start+count]===returned[i+count].text && (returned[i+count].line===null || returned[i+count].line===start+count+1))count++
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
  return {discovered,reads}
}
