import fs from 'node:fs/promises'
import path from 'node:path'

export function strings(value, out=[]) {
  if(typeof value==='string') out.push(value)
  else if(Array.isArray(value)) for(const v of value) strings(v,out)
  else if(value && typeof value==='object') for(const v of Object.values(value)) strings(v,out)
  return out
}

export function sourcePaths(value, cwd) {
  const result=new Set()
  for(const text of strings(value)) {
    for(let token of text.match(/(?:[A-Za-z]:)?[^\s'"`|<>]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|rb|php|cs|c|cc|cpp|h|hpp|vue|svelte)\b/g)??[]) {
      const rel=path.relative(cwd,path.resolve(cwd,token)).replaceAll('\\','/')
      if(rel && rel!=='..' && !rel.startsWith('../'))result.add(rel)
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
  const discovered=sourcePaths([input,output],cwd)
  const text=strings(input).join(' ')
  const navigation=/\bstellar\s+(context|search|find|file|symbol|related|impact|architecture)\b|stellar_(context|search|find|file|symbol|related|impact|architecture)/.test(text)
  if(navigation)return {discovered,reads:[]}
  const candidates=sourcePaths(input,cwd)
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
