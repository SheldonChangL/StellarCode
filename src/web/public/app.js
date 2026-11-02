const $ = selector => document.querySelector(selector)
const canvas = $('#universe')
const ctx = canvas.getContext('2d')
const palette = $('#palette')
const searchInput = $('#searchInput')
const searchResults = $('#searchResults')
const tooltip = $('#tooltip')
const inspector = $('#inspector')
const PROJECT_ID = location.pathname.match(/^\/project\/([^/]+)/)?.[1] ?? new URLSearchParams(location.search).get('project')

const ROLE_COLORS = {
  'application-entry':'#ffd166','domain-core':'#9c7cff','service':'#78a7ff','ui':'#61dfff',
  'infrastructure':'#55d6c2','test':'#55e5a2','config':'#f2a65a','module-entry':'#c084fc','docs':'#8da0bc','source':'#7b9bc8'
}
const GALAXY_COLORS = ['#6fe6ff','#9b7cff','#55e5a2','#ffc76b','#ff7fa6','#70a7ff','#c084fc','#5be0d6','#f29b72']
const state = {
  graph:null, level:'galaxy', galaxy:null, module:null, nodes:[], selected:null, hovered:null, impact:null,
  transform:{x:0,y:0,k:1}, dragging:false, dragStart:null, pointer:{x:0,y:0}, stars:[]
}

function hash(str){let h=2166136261;for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}
function galaxyColor(id){return GALAXY_COLORS[hash(id)%GALAXY_COLORS.length]}
function roleColor(role){return ROLE_COLORS[role]||ROLE_COLORS.source}
function clamp(value,min,max){return Math.max(min,Math.min(max,value))}
function esc(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
async function api(url){
  const target = PROJECT_ID && url.startsWith('/api/') ? `/api/projects/${encodeURIComponent(PROJECT_ID)}${url.slice(4)}` : url
  const response=await fetch(target);if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.message||response.statusText)}return response.json()
}

function resize(){
  const rect=canvas.getBoundingClientRect(), dpr=Math.min(devicePixelRatio||1,2)
  canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;ctx.setTransform(dpr,0,0,dpr,0,0)
  buildStarfield();layoutCurrent();fit(false);draw()
}
function buildStarfield(){
  const w=canvas.clientWidth,h=canvas.clientHeight,count=Math.round((w*h)/13500);state.stars=[]
  for(let i=0;i<count;i++){const n=hash(`star-${i}-${Math.round(w/100)}`);state.stars.push({x:(n%10000)/10000*w,y:((n>>>8)%10000)/10000*h,r:.35+((n>>>16)%100)/150,a:.12+((n>>>22)%100)/260})}
}
function hierarchyNodes(){
  if(!state.graph)return[]
  if(state.level==='galaxy')return state.graph.galaxies.map(g=>({...g,type:'galaxy',color:galaxyColor(g.id)}))
  if(state.level==='module')return state.graph.modules.filter(m=>m.galaxy===state.galaxy).map(m=>({...m,type:'module',color:galaxyColor(m.id)}))
  return state.graph.nodes.filter(n=>n.module===state.module).map(n=>({...n,type:'file',color:roleColor(n.role)}))
}
function layoutCurrent(){
  const source=hierarchyNodes(), w=canvas.clientWidth||1000,h=canvas.clientHeight||700,cx=w/2,cy=h/2+4
  if(state.level==='galaxy'){
    const sorted=[...source].sort((a,b)=>b.files-a.files||a.id.localeCompare(b.id))
    const maxFiles=Math.max(1,...sorted.map(n=>n.files))
    state.nodes=sorted.map((n,i)=>{const ring=i<7?0:1,ringIndex=ring?i-7:i,ringCount=ring?Math.max(1,sorted.length-7):Math.min(7,sorted.length);const angle=-Math.PI/2+(Math.PI*2*ringIndex/ringCount)+(ring?.18:0);const radius=Math.min(w,h)*(ring?.37:.25);return {...n,x:cx+Math.cos(angle)*radius,y:cy+Math.sin(angle)*radius,r:28+Math.sqrt(n.files/maxFiles)*25}})
  } else if(state.level==='module'){
    const sorted=[...source].sort((a,b)=>b.files-a.files||a.id.localeCompare(b.id));const maxFiles=Math.max(1,...sorted.map(n=>n.files))
    state.nodes=sorted.map((n,i)=>{const count=sorted.length,ring=i<10?0:1,idx=ring?i-10:i,rc=ring?Math.max(1,count-10):Math.min(10,count);const angle=-Math.PI/2+Math.PI*2*idx/rc+(ring?.22:0);const radius=Math.min(w,h)*(ring?.38:.25);return {...n,x:cx+Math.cos(angle)*radius,y:cy+Math.sin(angle)*radius,r:19+Math.sqrt(n.files/maxFiles)*18}})
  } else {
    const sorted=[...source].sort((a,b)=>{
      const ae=(a.role==='application-entry'?1:0),be=(b.role==='application-entry'?1:0);return be-ae||b.importance-a.importance||a.id.localeCompare(b.id)
    })
    const maxImp=Math.max(.01,...sorted.map(n=>n.importance||0))
    state.nodes=sorted.map((n,i)=>{
      if(i===0)return {...n,x:cx,y:cy,r:fileRadius(n,maxImp)+5,central:true}
      const ring=Math.floor((i-1)/12)+1,idx=(i-1)%12,count=Math.min(12,sorted.length-1-(ring-1)*12);const angle=-Math.PI/2+(Math.PI*2*idx/Math.max(1,count))+(ring%2?.16:0);const radius=88+ring*68;return {...n,x:cx+Math.cos(angle)*radius,y:cy+Math.sin(angle)*radius,r:fileRadius(n,maxImp),central:false}
    })
  }
  state.selected=null;state.hovered=null;state.impact=null;hideInspector();updateHud();updateBreadcrumbs();updateLegend();updateHint()
}
function fileRadius(node,maxImp){const base=node.role==='application-entry'?11:node.role==='domain-core'?9:node.isTest?5.5:6.5;return base+Math.sqrt(Math.max(0,node.importance)/maxImp)*6}
function addExternalNodes(paths){
  if(state.level!=='file'||!paths?.length)return
  const existing=new Set(state.nodes.map(node=>node.id)),wanted=[...new Set(paths)].filter(path=>!existing.has(path))
  if(!wanted.length)return
  const cx=canvas.clientWidth/2,cy=canvas.clientHeight/2,maxImp=Math.max(.01,...state.graph.nodes.map(node=>node.importance||0)),radius=Math.min(canvas.clientWidth,canvas.clientHeight)*.39
  const start=state.nodes.filter(node=>node.external).length
  for(let i=0;i<wanted.length;i++){
    const source=state.graph.nodes.find(node=>node.id===wanted[i]);if(!source)continue
    const angle=-Math.PI/2+Math.PI*2*(start+i)/Math.max(7,start+wanted.length)
    state.nodes.push({...source,type:'file',color:roleColor(source.role),external:true,x:cx+Math.cos(angle)*radius,y:cy+Math.sin(angle)*radius,r:fileRadius(source,maxImp)})
  }
}
function worldToScreen(node){return{x:node.x*state.transform.k+state.transform.x,y:node.y*state.transform.k+state.transform.y,r:Math.max(2,node.r*Math.sqrt(state.transform.k))}}
function fit(animate=true){
  if(!state.nodes.length)return
  const xs=state.nodes.map(n=>n.x),ys=state.nodes.map(n=>n.y);const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys)
  const margin=state.level==='file'?115:90,w=canvas.clientWidth,h=canvas.clientHeight;const spanX=Math.max(160,maxX-minX+margin*2),spanY=Math.max(160,maxY-minY+margin*2);const k=clamp(Math.min(w/spanX,h/spanY),.35,1.18)
  state.transform={k,x:w/2-((minX+maxX)/2)*k,y:h/2-((minY+maxY)/2)*k};draw()
}
function clear(){
  ctx.clearRect(0,0,canvas.clientWidth,canvas.clientHeight)
  const bg=ctx.createRadialGradient(canvas.clientWidth*.54,canvas.clientHeight*.42,20,canvas.clientWidth*.54,canvas.clientHeight*.42,Math.max(canvas.clientWidth,canvas.clientHeight)*.75);bg.addColorStop(0,'rgba(31,66,132,.17)');bg.addColorStop(.44,'rgba(10,24,55,.07)');bg.addColorStop(1,'rgba(1,3,10,0)');ctx.fillStyle=bg;ctx.fillRect(0,0,canvas.clientWidth,canvas.clientHeight)
  for(const star of state.stars){ctx.globalAlpha=star.a;ctx.fillStyle='#b9d8ff';ctx.beginPath();ctx.arc(star.x,star.y,star.r,0,Math.PI*2);ctx.fill()}ctx.globalAlpha=1
}
function draw(){clear();if(!state.graph)return;drawRelations();for(const node of state.nodes)drawNode(node);ctx.globalAlpha=1}
function visibleRelationPaths(){
  if(state.level!=='file')return null
  if(state.impact){const set=new Set(state.impact.nodes.map(n=>n.path));set.add(state.impact.target);return set}
  const target=state.selected?.id||state.hovered?.id;if(!target)return null
  const set=new Set([target]);for(const edge of state.graph.edges){if(edge.source===target)set.add(edge.target);if(edge.target===target)set.add(edge.source)}return set
}
function drawRelations(){
  if(state.level!=='file')return
  const byId=new Map(state.nodes.map(n=>[n.id,n]));const visible=visibleRelationPaths();if(!visible)return
  const edges=state.impact?.edges||state.graph.edges.filter(e=>visible.has(e.source)&&visible.has(e.target))
  for(const edge of edges){const a=byId.get(edge.source),b=byId.get(edge.target);if(!a||!b)continue;const A=worldToScreen(a),B=worldToScreen(b);const grad=ctx.createLinearGradient(A.x,A.y,B.x,B.y);const color=edge.type==='tests'?'85,229,162':'104,171,255';grad.addColorStop(0,`rgba(${color},.15)`);grad.addColorStop(.55,`rgba(${color},.78)`);grad.addColorStop(1,`rgba(${color},.12)`);ctx.strokeStyle=grad;ctx.lineWidth=state.impact?1.5:1.15;ctx.beginPath();ctx.moveTo(A.x,A.y);const mx=(A.x+B.x)/2,my=(A.y+B.y)/2-18;ctx.quadraticCurveTo(mx,my,B.x,B.y);ctx.stroke()}
}
function nodeAlpha(node){
  if(state.level!=='file')return 1
  const visible=visibleRelationPaths();if(!visible)return 1
  return visible.has(node.id)?1:.075
}
function drawNode(node){
  const p=worldToScreen(node),selected=state.selected?.id===node.id,hovered=state.hovered?.id===node.id;ctx.globalAlpha=nodeAlpha(node)
  if(node.type==='galaxy')return drawGalaxy(node,p,hovered)
  if(node.type==='module')return drawModule(node,p,hovered)
  drawFile(node,p,selected,hovered)
}
function drawGalaxy(node,p,hovered){
  const r=p.r*(hovered?1.06:1);const glow=ctx.createRadialGradient(p.x,p.y,r*.08,p.x,p.y,r*2.35);glow.addColorStop(0,node.color+'e6');glow.addColorStop(.18,node.color+'6d');glow.addColorStop(.55,node.color+'18');glow.addColorStop(1,node.color+'00');ctx.fillStyle=glow;ctx.beginPath();ctx.arc(p.x,p.y,r*2.35,0,Math.PI*2);ctx.fill()
  ctx.strokeStyle=node.color+'48';ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(p.x,p.y,r*1.55,r*.62,-.28,0,Math.PI*2);ctx.stroke();ctx.strokeStyle=node.color+'24';ctx.beginPath();ctx.ellipse(p.x,p.y,r*1.87,r*.88,.38,0,Math.PI*2);ctx.stroke()
  ctx.fillStyle=node.color;drawStar(p.x,p.y,Math.max(7,r*.28),5);ctx.fill();ctx.textAlign='center';ctx.fillStyle='#eef6ff';ctx.font='600 13px ui-sans-serif';ctx.fillText(node.label,p.x,p.y+r+22);ctx.fillStyle='#657b9a';ctx.font='9px ui-sans-serif';ctx.fillText(`${node.files} files · ${node.tests} tests`,p.x,p.y+r+37)
}
function drawModule(node,p,hovered){
  const r=p.r*(hovered?1.07:1);const glow=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,r*2);glow.addColorStop(0,node.color+'a8');glow.addColorStop(.28,node.color+'30');glow.addColorStop(1,node.color+'00');ctx.fillStyle=glow;ctx.beginPath();ctx.arc(p.x,p.y,r*2,0,Math.PI*2);ctx.fill();ctx.strokeStyle=node.color+'48';ctx.beginPath();ctx.arc(p.x,p.y,r*1.3,0,Math.PI*2);ctx.stroke();ctx.fillStyle=node.color;ctx.beginPath();ctx.arc(p.x,p.y,Math.max(6,r*.29),0,Math.PI*2);ctx.fill()
  ctx.textAlign='center';ctx.fillStyle='#e8f2ff';ctx.font='600 11px ui-sans-serif';ctx.fillText(node.label,p.x,p.y+r+18);ctx.fillStyle='#5f7594';ctx.font='8px ui-sans-serif';ctx.fillText(`${node.files} files`,p.x,p.y+r+31)
}
function drawFile(node,p,selected,hovered){
  const r=p.r*(selected?1.25:hovered?1.12:1);const color=node.color;const glow=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,r*3.25);glow.addColorStop(0,color+'d8');glow.addColorStop(.24,color+'55');glow.addColorStop(1,color+'00');ctx.fillStyle=glow;ctx.beginPath();ctx.arc(p.x,p.y,r*3.25,0,Math.PI*2);ctx.fill();ctx.fillStyle=color
  if(node.role==='application-entry'){drawStar(p.x,p.y,r,5);ctx.fill()}else if(node.role==='module-entry'){drawDiamond(p.x,p.y,r);ctx.fill()}else if(node.role==='config'){drawHexagon(p.x,p.y,r);ctx.fill()}else{ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fill()}
  if(node.external){ctx.setLineDash([3,3]);ctx.strokeStyle=color+'78';ctx.lineWidth=.8;ctx.beginPath();ctx.arc(p.x,p.y,r*1.55,0,Math.PI*2);ctx.stroke();ctx.setLineDash([])}
  if(selected){ctx.strokeStyle='#e7fbff';ctx.lineWidth=1.35;ctx.beginPath();ctx.arc(p.x,p.y,r*1.75,0,Math.PI*2);ctx.stroke();ctx.strokeStyle=color+'75';ctx.beginPath();ctx.arc(p.x,p.y,r*2.35,0,Math.PI*2);ctx.stroke()}
  if(selected||hovered||node.central||node.importance>.55){ctx.textAlign='center';ctx.fillStyle='#dbe9fb';ctx.font=`${selected?'600 ':''}9px ui-sans-serif`;ctx.fillText(node.label,p.x,p.y+r+14)}
}
function drawStar(x,y,r,points=5){ctx.beginPath();for(let i=0;i<points*2;i++){const a=-Math.PI/2+i*Math.PI/points,rr=i%2===0?r:r*.42;const px=x+Math.cos(a)*rr,py=y+Math.sin(a)*rr;i?ctx.lineTo(px,py):ctx.moveTo(px,py)}ctx.closePath()}
function drawDiamond(x,y,r){ctx.beginPath();ctx.moveTo(x,y-r);ctx.lineTo(x+r*.78,y);ctx.lineTo(x,y+r);ctx.lineTo(x-r*.78,y);ctx.closePath()}
function drawHexagon(x,y,r){ctx.beginPath();for(let i=0;i<6;i++){const a=-Math.PI/2+i*Math.PI/3,px=x+Math.cos(a)*r,py=y+Math.sin(a)*r;i?ctx.lineTo(px,py):ctx.moveTo(px,py)}ctx.closePath()}
function pick(x,y){let best=null,bestDist=Infinity;for(const node of state.nodes){const p=worldToScreen(node),d=Math.hypot(p.x-x,p.y-y),hit=Math.max(14,p.r*1.35);if(d<hit&&d<bestDist){best=node;bestDist=d}}return best}

function updateHud(){
  if(!state.graph)return;let title='Repository galaxies',metrics=[]
  if(state.level==='galaxy')metrics=[`${state.graph.nodes.length} files`,`${state.graph.galaxies.length} galaxies`,`${state.graph.modules.length} modules`]
  if(state.level==='module'){title=state.galaxy;const mods=state.graph.modules.filter(m=>m.galaxy===state.galaxy);const files=state.graph.nodes.filter(n=>n.galaxy===state.galaxy);metrics=[`${mods.length} modules`,`${files.length} files`,`${files.filter(n=>n.isTest).length} tests`]}
  if(state.level==='file'){title=state.module;const files=state.graph.nodes.filter(n=>n.module===state.module);metrics=[`${files.length} files`,`${files.filter(n=>n.role==='application-entry').length} app entries`,`${files.filter(n=>n.isTest).length} tests`]}
  $('#universeHud').innerHTML=`<span class="hud-title">${esc(title)}</span>${metrics.map(m=>`<i class="hud-dot"></i><span class="hud-metric">${esc(m)}</span>`).join('')}`
}
function updateBreadcrumbs(){
  const items=[{label:state.graph?.project?.display_name||'Repository',level:'galaxy'}];if(state.galaxy)items.push({label:state.galaxy,level:'module'});if(state.module)items.push({label:state.module.split('/').at(-1),level:'file'})
  $('#breadcrumbs').innerHTML=items.map((item,i)=>`${i?'<span class="crumb-sep">›</span>':''}<button class="crumb ${i===items.length-1?'current':''}" data-level="${item.level}">${esc(item.label)}</button>`).join('')
  document.querySelectorAll('.crumb:not(.current)').forEach(button=>button.onclick=()=>{if(button.dataset.level==='galaxy')goGalaxies();else if(button.dataset.level==='module')goModules(state.galaxy)})
}
function updateLegend(){
  const roles=state.level==='file'?['application-entry','domain-core','service','ui','infrastructure','test','config','module-entry']:[]
  $('#roleLegend').innerHTML=roles.map(role=>`<span class="role-item"><i style="background:${roleColor(role)};color:${roleColor(role)}"></i>${role.replaceAll('-',' ')}</span>`).join('')
  $('#roleLegend').style.display=roles.length?'flex':'none'
}
function updateHint(){
  $('#universeHint').textContent=state.level==='galaxy'?'Click a galaxy to enter · scroll to zoom · drag to explore':state.level==='module'?'Click a module to reveal its files · use breadcrumbs to go back':'Select a file to reveal relations · Impact shows reverse dependency reach'
}
function goGalaxies(){state.level='galaxy';state.galaxy=null;state.module=null;layoutCurrent();fit();draw()}
function goModules(galaxy){state.level='module';state.galaxy=galaxy;state.module=null;layoutCurrent();fit();draw()}
function goFiles(module){const entry=state.graph.modules.find(m=>m.id===module);state.level='file';state.galaxy=entry?.galaxy||module.split('/')[0];state.module=module;layoutCurrent();fit();draw()}
async function navigateToFile(path){const file=state.graph.nodes.find(n=>n.id===path);if(!file)return;state.level='file';state.galaxy=file.galaxy;state.module=file.module;layoutCurrent();fit();const node=state.nodes.find(n=>n.id===path);if(node){await selectFile(node);focusNode(node)}}

function showTooltip(node,x,y){
  if(!node){tooltip.classList.add('hidden');return}let kicker='',title='',copy='',meta=''
  if(node.type==='galaxy'){kicker='Galaxy';title=node.id;copy=`${node.files} indexed files grouped into ${state.graph.modules.filter(m=>m.galaxy===node.id).length} modules.`;meta=`${node.lines.toLocaleString()} LOC · ${node.tests} tests`}
  else if(node.type==='module'){kicker='Module';title=node.id;copy=`Local system inside ${node.galaxy}.`;meta=`${node.files} files · ${node.lines.toLocaleString()} LOC`}
  else{kicker=node.roleLabel||node.role;title=node.label;copy=node.summary||node.roleReason||'Indexed source file';meta=`${node.lines} lines · importance ${Number(node.importance).toFixed(2)}`}
  tooltip.innerHTML=`<span class="tooltip-kicker">${esc(kicker)}</span><b>${esc(title)}</b><p>${esc(copy)}</p><div class="tooltip-meta">${esc(meta)}</div>`;tooltip.style.left=`${Math.min(canvas.clientWidth-290,x+17)}px`;tooltip.style.top=`${Math.max(10,y-22)}px`;tooltip.classList.remove('hidden')
}
function hideInspector(){inspector.classList.add('hidden');inspector.innerHTML=''}
async function selectFile(node){
  state.impact=null
  const detail=await api(`/api/file?path=${encodeURIComponent(node.id)}`)
  addExternalNodes([...(detail.dependsOn||[]).map(v=>v.path),...(detail.usedBy||[]).map(v=>v.path),...(detail.tests||[])])
  state.selected=state.nodes.find(item=>item.id===node.id)||node
  draw();renderInspector(detail)
}
function renderInspector(detail){
  const syms=detail.symbols?.slice(0,12)||[],deps=detail.dependsOn||[],used=detail.usedBy||[],architecture=detail.architecture||{}
  inspector.classList.remove('hidden');inspector.innerHTML=`
    <div class="inspect-head"><button class="inspect-close" id="inspectClose">×</button><span class="role-chip" style="color:${roleColor(architecture.role)}">● ${esc(architecture.roleLabel||architecture.role||'Source')}</span><h2>${esc(detail.name)}</h2><div class="inspect-path">${esc(detail.path)}</div><p class="inspect-summary">${esc(detail.summary||'Deterministic module metadata.')}</p><div class="inspect-actions"><button id="impactBtn" class="primary">✦ Impact</button><button id="focusBtn">◎ Focus</button></div></div>
    <div class="inspect-section"><h4>Overview</h4><div class="meta-grid"><div class="meta-card"><b>${detail.lines}</b><span>Lines</span></div><div class="meta-card"><b>${Number(detail.importance).toFixed(2)}</b><span>Importance</span></div><div class="meta-card"><b>${deps.length}</b><span>Depends on</span></div><div class="meta-card"><b>${used.length}</b><span>Used by</span></div></div></div>
    <div class="inspect-section"><h4>Architecture</h4><div class="architecture-note">${esc(architecture.reason||'General source classification.')}</div></div>
    <div class="inspect-section"><h4>Symbols</h4>${syms.length?syms.map(s=>`<div class="list-row"><span class="badge">${esc(s.kind)}</span><span class="path">${esc(s.qualifiedName)}</span><span class="line-no">L${s.lines[0]}</span></div>`).join(''):'<div class="list-row">No indexed symbols</div>'}</div>
    <div class="inspect-section"><h4>Depends on</h4>${deps.length?deps.map(v=>`<div class="list-row">→ <span class="path">${esc(v.path)}</span></div>`).join(''):'<div class="list-row">No direct dependencies</div>'}</div>
    <div class="inspect-section"><h4>Used by</h4>${used.length?used.map(v=>`<div class="list-row">← <span class="path">${esc(v.path)}</span></div>`).join(''):'<div class="list-row">No direct reverse dependencies</div>'}</div>
    <div class="inspect-section"><h4>Tests</h4>${detail.tests?.length?detail.tests.map(v=>`<div class="list-row">◌ <span class="path">${esc(v)}</span></div>`).join(''):'<div class="list-row">No linked tests</div>'}</div>`
  $('#inspectClose').onclick=()=>{state.selected=null;state.impact=null;hideInspector();draw()};$('#impactBtn').onclick=()=>showImpact(detail.path);$('#focusBtn').onclick=()=>focusNode(state.selected)
}
async function showImpact(target){
  state.impact=await api(`/api/impact?target=${encodeURIComponent(target)}&depth=3`)
  addExternalNodes(state.impact.nodes.map(node=>node.path));draw()
  const head=inspector.querySelector('.inspect-head');head.querySelector('.impact-summary')?.remove();head.insertAdjacentHTML('beforeend',`<div class="meta-grid impact-summary" style="margin-top:12px"><div class="meta-card"><b>${state.impact.direct}</b><span>Direct</span></div><div class="meta-card"><b>${state.impact.indirect}</b><span>Indirect</span></div><div class="meta-card"><b>${state.impact.tests}</b><span>Tests</span></div><div class="meta-card"><b>${state.impact.nodes.length}</b><span>Reach</span></div></div>`)
}
function focusNode(node){if(!node)return;const targetK=Math.max(1.3,state.transform.k);state.transform={k:targetK,x:canvas.clientWidth/2-node.x*targetK,y:canvas.clientHeight/2-node.y*targetK};draw()}

function openPalette(){palette.classList.remove('hidden');searchInput.value='';searchResults.innerHTML='<div class="search-empty">Search the indexed universe.</div>';setTimeout(()=>searchInput.focus(),0)}function closePalette(){palette.classList.add('hidden')}
let searchTimer;searchInput.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(runSearch,110)})
async function runSearch(){const q=searchInput.value.trim();if(!q){searchResults.innerHTML='<div class="search-empty">Search the indexed universe.</div>';return}const results=await api(`/api/search?q=${encodeURIComponent(q)}`);searchResults.innerHTML=results.length?results.map((item,index)=>`<div class="search-item ${index===0?'selected':''}" data-path="${esc(item.path)}"><span class="search-item-icon">${item.type==='symbol'?'ƒ':'●'}</span><span class="search-main"><b>${esc(item.type==='symbol'?item.qualifiedName:item.path)}</b><span>${esc(item.type==='symbol'?item.path:(item.summary||item.roleLabel||'Indexed file'))}</span></span><span class="search-kind">${esc(item.type)}</span></div>`).join(''):'<div class="search-empty">No indexed match.</div>';searchResults.querySelectorAll('.search-item').forEach(el=>el.onclick=async()=>{closePalette();await navigateToFile(el.dataset.path)})}
async function loadChanges(){const rows=await api('/api/changes');$('#changesList').innerHTML=rows.length?rows.map(change=>`<article class="change-card"><b>${esc(change.source)}</b> <small>${new Date(change.occurredAt).toLocaleString()}</small>${change.reason?`<p>${esc(change.reason)}</p>`:''}<div class="change-files">${change.files.map(file=>`<span class="change-file">${esc(file)}</span>`).join('')}</div></article>`).join(''):'<div class="search-empty">No change events yet.</div>'}
async function showArchitecture(){const data=await api('/api/architecture');openPalette();searchInput.value='architecture';searchResults.innerHTML=[...data.entries.slice(0,4),...data.core.slice(0,8)].map((item,index)=>`<div class="search-item ${index===0?'selected':''}" data-path="${esc(item.path)}"><span class="search-item-icon" style="color:${roleColor(item.architecture?.role)}">${item.architecture?.role==='application-entry'?'★':'●'}</span><span class="search-main"><b>${esc(item.path)}</b><span>${esc(item.architecture?.roleLabel||'Core')} · importance ${Number(item.importance).toFixed(2)}</span></span><span class="search-kind">${esc(item.architecture?.role||'source')}</span></div>`).join('');searchResults.querySelectorAll('.search-item').forEach(el=>el.onclick=async()=>{closePalette();await navigateToFile(el.dataset.path)})}

canvas.addEventListener('pointerdown',event=>{state.dragging=true;state.dragStart={x:event.clientX,y:event.clientY,tx:state.transform.x,ty:state.transform.y};canvas.classList.add('dragging');canvas.setPointerCapture(event.pointerId)})
canvas.addEventListener('pointermove',event=>{state.pointer={x:event.offsetX,y:event.offsetY};const node=pick(event.offsetX,event.offsetY);if(state.hovered?.id!==node?.id){state.hovered=node;draw()}showTooltip(node,event.offsetX,event.offsetY);if(state.dragging){state.transform.x=state.dragStart.tx+(event.clientX-state.dragStart.x);state.transform.y=state.dragStart.ty+(event.clientY-state.dragStart.y);draw()}})
canvas.addEventListener('pointerleave',()=>{state.hovered=null;tooltip.classList.add('hidden');draw()})
canvas.addEventListener('pointerup',async event=>{const moved=Math.hypot(event.clientX-state.dragStart.x,event.clientY-state.dragStart.y);state.dragging=false;canvas.classList.remove('dragging');if(moved>=5)return;const node=pick(event.offsetX,event.offsetY);if(!node)return;if(node.type==='galaxy')goModules(node.id);else if(node.type==='module')goFiles(node.id);else if(node.external)await navigateToFile(node.id);else await selectFile(node)})
canvas.addEventListener('wheel',event=>{event.preventDefault();const old=state.transform.k,next=clamp(old*Math.exp(-event.deltaY*.001),.28,3.6),mx=event.offsetX,my=event.offsetY;state.transform.x=mx-(mx-state.transform.x)*(next/old);state.transform.y=my-(my-state.transform.y)*(next/old);state.transform.k=next;draw()},{passive:false})
$('#zoomIn').onclick=()=>{state.transform.k=Math.min(3.6,state.transform.k*1.18);draw()};$('#zoomOut').onclick=()=>{state.transform.k=Math.max(.28,state.transform.k/1.18);draw()};$('#fitView').onclick=()=>fit();$('#resetView').onclick=goGalaxies;$('#searchTrigger').onclick=openPalette;$('#architectureBtn').onclick=showArchitecture
palette.addEventListener('click',event=>{if(event.target===palette)closePalette()});window.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openPalette()}if(event.key==='Escape'){closePalette();if(!palette.classList.contains('hidden'))return}})
document.querySelectorAll('.rail-button[data-view]').forEach(button=>button.onclick=()=>{document.querySelectorAll('.rail-button[data-view]').forEach(b=>b.classList.toggle('active',b===button));document.querySelectorAll('.view').forEach(view=>view.classList.remove('active'));$(`#${button.dataset.view}View`).classList.add('active');if(button.dataset.view==='changes')loadChanges();else resize()})
window.addEventListener('resize',resize)

async function loadGraph(){
  state.graph=await api('/api/graph');$('#syncState').innerHTML='<i></i> indexed';resize()
  const params=new URLSearchParams(location.search),file=params.get('file'),module=params.get('module'),galaxy=params.get('galaxy')
  if(file&&state.graph.nodes.some(node=>node.id===file))await navigateToFile(file)
  else if(module&&state.graph.modules.some(item=>item.id===module))goFiles(module)
  else if(galaxy&&state.graph.galaxies.some(item=>item.id===galaxy))goModules(galaxy)
  else goGalaxies()
}
await loadGraph()
