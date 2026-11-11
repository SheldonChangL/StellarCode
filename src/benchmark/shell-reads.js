import fs from 'node:fs/promises'
import path from 'node:path'

// Deterministic, conservative reading of shell commands for benchmark evidence.
// Nothing here executes a command. It only answers: "which repository files could
// this command chain have printed?" Every candidate still has to match repository
// source verbatim in the tool output (evidence.js) before it counts as a read.
//
// Supported: `;`, `&&`, `||`, `|` and newlines between simple commands, `cd DIR`
// (relative, absolute, through symlinks), single/double quotes and backslash
// escapes, brace expansion `{a,b}`, globs `* ? [...]` against the snapshot, and
// `sh|bash|zsh -c SCRIPT` wrappers. Anything else (command substitution,
// variables, subshell grouping, `cd -`, `cd` without an argument) makes the
// parser stop trusting the working directory instead of guessing it.

const SEPARATORS=new Set([';','&&','||','|','\n','&'])
const SHELLS=new Set(['sh','bash','zsh','dash'])

export function tokenizeShell(script) {
  const tokens=[]
  let word='',quoted=false,unsafe=false,inWord=false
  const push=()=>{if(inWord)tokens.push({type:'word',value:word,quoted,unsafe});word='';quoted=false;unsafe=false;inWord=false}
  for(let i=0;i<script.length;i++) {
    const c=script[i]
    if(c==="'") {
      const end=script.indexOf("'",i+1)
      if(end<0)return null
      word+=protect(script.slice(i+1,end));quoted=true;inWord=true;i=end;continue
    }
    if(c==='"') {
      let j=i+1,text=''
      for(;j<script.length && script[j]!=='"';j++) {
        if(script[j]==='\\' && j+1<script.length && '"\\$`\n'.includes(script[j+1])){text+=script[++j];continue}
        if(script[j]==='$'||script[j]==='`')unsafe=true
        text+=script[j]
      }
      if(j>=script.length)return null
      word+=protect(text);quoted=true;inWord=true;i=j;continue
    }
    if(c==='\\') {
      if(i+1<script.length){if(script[i+1]!=='\n'){word+=protect(script[i+1]);inWord=true}i++}
      continue
    }
    if(c==='#' && !inWord) {while(i<script.length && script[i]!=='\n')i++;i--;continue}
    if(c==='\n'||c===';'||c==='|'||c==='&') {
      push()
      const two=script.slice(i,i+2)
      if(two==='&&'||two==='||'){tokens.push({type:'op',value:two});i++}
      else if(c==='&' && script[i+1]==='>'){tokens.push({type:'op',value:'>'});i++}
      else tokens.push({type:'op',value:c})
      continue
    }
    if(c==='<'||c==='>') {
      push()
      let op=c
      while(script[i+1]==='>'||script[i+1]==='&'||(script[i+1]>='0'&&script[i+1]<='9'&&op.endsWith('&')))op+=script[++i]
      tokens.push({type:'op',value:op.startsWith('<')?'<':'>'})
      continue
    }
    if(c==='('||c===')') {push();tokens.push({type:'op',value:c});continue}
    if(/\s/.test(c)){push();continue}
    if(c==='$'||c==='`')unsafe=true
    word+=c;inWord=true
  }
  push()
  return tokens
}

// Quoted characters must never be treated as glob or brace syntax.
const GUARD='\u0000'
function protect(text){return [...text].map(ch=>'*?[]{},'.includes(ch)?GUARD+ch:ch).join('')}
function unprotect(text){return text.replaceAll(GUARD,'')}
function hasPattern(text){return /(^|[^\u0000])[*?[]/.test(text)}

export function splitCommands(tokens) {
  const commands=[]
  let current={words:[],redirectIn:[],separator:null,grouped:false}
  let depth=0
  for(let i=0;i<tokens.length;i++) {
    const token=tokens[i]
    if(token.type==='op') {
      if(token.value==='('){depth++;current.grouped=true;continue}
      if(token.value===')'){depth=Math.max(0,depth-1);continue}
      if(token.value==='<'||token.value==='>') {
        const target=tokens[i+1]
        if(target?.type==='word'){if(token.value==='<')current.redirectIn.push(target);i++}
        continue
      }
      if(SEPARATORS.has(token.value)) {
        current.separator=token.value
        if(current.words.length)commands.push(current)
        current={words:[],redirectIn:[],separator:null,grouped:depth>0}
        continue
      }
    }
    if(token.type==='word')current.words.push(token)
  }
  if(current.words.length)commands.push(current)
  return commands
}

function braceExpand(text) {
  for(let i=0;i<text.length;i++) {
    if(text[i]!=='{' || text[i-1]===GUARD)continue
    let depth=0
    for(let j=i;j<text.length;j++) {
      if(text[j-1]===GUARD)continue
      if(text[j]==='{')depth++
      else if(text[j]==='}' && --depth===0) {
        const body=text.slice(i+1,j),parts=[]
        let level=0,start=0
        for(let k=0;k<body.length;k++) {
          if(body[k-1]===GUARD)continue
          if(body[k]==='{')level++
          else if(body[k]==='}')level--
          else if(body[k]===',' && level===0){parts.push(body.slice(start,k));start=k+1}
        }
        parts.push(body.slice(start))
        if(parts.length<2)break
        return parts.flatMap(part=>braceExpand(text.slice(0,i)+part+text.slice(j+1)))
      }
    }
  }
  return [text]
}

function segmentRegex(segment) {
  let source='^'
  for(let i=0;i<segment.length;i++) {
    const c=segment[i]
    if(c===GUARD){source+=escapeRegex(segment[++i]??'');continue}
    if(c==='*')source+='[^/]*'
    else if(c==='?')source+='[^/]'
    else if(c==='[') {
      const end=segment.indexOf(']',i+2)
      if(end<0){source+='\\[';continue}
      let body=segment.slice(i+1,end).replaceAll(GUARD,'')
      if(body.startsWith('!'))body='^'+body.slice(1)
      source+='['+body.replaceAll('\\','\\\\')+']'
      i=end
    } else source+=escapeRegex(c)
  }
  return new RegExp(source+'$')
}
function escapeRegex(text){return text.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&')}

async function exists(file){try{await fs.stat(file);return true}catch{return false}}

// Expands one glob word against the filesystem. A pattern without matches yields
// nothing: bash would pass the literal through, and that literal does not exist.
async function expandGlob(word, cwd) {
  const absolute=path.isAbsolute(word)
  const parts=word.split('/')
  let bases=[absolute?'/':cwd]
  for(let index=0;index<parts.length;index++) {
    const part=parts[index]
    if(part===''||part==='.')continue
    const next=[]
    if(!hasPattern(part)) {
      for(const base of bases)next.push(path.join(base,unprotect(part)))
    } else {
      const regex=segmentRegex(part)
      for(const base of bases) {
        let entries=[]
        try{entries=(await fs.readdir(base)).sort()}catch{continue}
        for(const entry of entries) {
          if(entry.startsWith('.') && !unprotect(part).startsWith('.'))continue
          if(regex.test(entry))next.push(path.join(base,entry))
        }
      }
    }
    bases=next
    if(!bases.length)return []
  }
  const found=[]
  for(const file of bases)if(await exists(file))found.push(file)
  return found
}

export async function expandWord(word, cwd) {
  const results=[]
  for(const variant of braceExpand(word)) {
    if(hasPattern(variant))results.push(...await expandGlob(variant,cwd))
    else results.push(path.resolve(cwd,unprotect(variant)))
  }
  return results
}

function scriptOf(words) {
  if(!SHELLS.has(path.basename(words[0]?.value??'')))return null
  for(let i=1;i<words.length;i++) {
    const flag=words[i].value
    if(!flag.startsWith('-'))return null
    if(/^-[a-z]*c[a-z]*$/i.test(flag))return words[i+1]?unprotect(words[i+1].value):null
  }
  return null
}

// Returns every file a command chain names, resolved against the working directory
// that command would have used, plus the spelling each one had in the command.
export async function shellCommandFiles(script, startCwd, depth=0) {
  const tokens=tokenizeShell(String(script))
  if(!tokens)return {files:[],cwds:[]}
  const commands=splitCommands(tokens)
  const files=[],cwds=new Set()
  let cwd=startCwd
  for(const command of commands) {
    const words=command.words
    const nested=depth<2?scriptOf(words):null
    if(nested!==null) {
      if(cwd){const inner=await shellCommandFiles(nested,cwd,depth+1);files.push(...inner.files);inner.cwds.forEach(dir=>cwds.add(dir))}
      continue
    }
    const name=unprotect(words[0].value)
    if(name==='cd'||name==='pushd') {
      const target=words.slice(1).find(word=>!word.value.startsWith('-'))
      if(!cwd||!target||target.unsafe||target.value==='-'||command.grouped||command.separator==='|') {cwd=command.grouped||command.separator==='|'?cwd:null;continue}
      const [dir]=await expandWord(target.value,cwd)
      let real=null
      try{real=await fs.realpath(dir);if(!(await fs.stat(real)).isDirectory())real=null}catch{}
      cwd=real
      if(cwd)cwds.add(cwd)
      continue
    }
    if(name==='popd'){cwd=null;continue}
    if(!cwd)continue
    for(const word of [...words.slice(1),...command.redirectIn]) {
      if(word.unsafe)continue
      const raw=unprotect(word.value)
      if(raw.startsWith('-')||!raw||/^\d/.test(raw)&&!raw.includes('/')&&!raw.includes('.'))continue
      for(const file of await expandWord(word.value,cwd))files.push({file,spelled:path.isAbsolute(raw)||hasPattern(word.value)?path.relative(cwd,file):raw,cwd})
    }
  }
  return {files,cwds:[...cwds]}
}
