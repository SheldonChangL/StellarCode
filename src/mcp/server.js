import readline from 'node:readline'
import { searchProject, fileDetail, symbolLookup, related, impact, contextForTask, architectureOverview } from '../query/query-service.js'
import { projectSummaries } from '../storage/registry.js'
import { resolveAnyProject } from '../core/global-runtime.js'

const PROTOCOL_VERSION = '2025-06-18'
const projectFields = {
  project:{type:'string',description:'Registered project name, UUID/prefix, or path. Omit when MCP runs inside a StellarCode repo.'},
  projectId:{type:'string',description:'Registered project UUID or prefix.'},
  projectPath:{type:'string',description:'Repository path (backward compatible).'}
}

const tools = [
  { name:'stellar_projects', description:'List all StellarCode projects registered on this computer, including active/idle/missing lifecycle state.', inputSchema:{type:'object',properties:{},additionalProperties:false} },
  { name:'stellar_search', description:'Search indexed files and symbols. Use this before broad repository grep/find.', inputSchema:{type:'object',properties:{query:{type:'string'},limit:{type:'integer',minimum:1,maximum:50},...projectFields},required:['query'],additionalProperties:false} },
  { name:'stellar_file', description:'Return compact facts for one indexed file: purpose, symbols, imports, reverse dependencies and tests.', inputSchema:{type:'object',properties:{path:{type:'string'},...projectFields},required:['path'],additionalProperties:false} },
  { name:'stellar_symbol', description:'Resolve a symbol name to file and line ranges.', inputSchema:{type:'object',properties:{query:{type:'string'},limit:{type:'integer',minimum:1,maximum:30},...projectFields},required:['query'],additionalProperties:false} },
  { name:'stellar_related', description:'Return direct incoming/outgoing repository relationships for a file or symbol.', inputSchema:{type:'object',properties:{target:{type:'string'},limit:{type:'integer',minimum:1,maximum:100},...projectFields},required:['target'],additionalProperties:false} },
  { name:'stellar_impact', description:'Bounded reverse dependency traversal showing likely impacted files/tests.', inputSchema:{type:'object',properties:{target:{type:'string'},depth:{type:'integer',minimum:1,maximum:6},limit:{type:'integer',minimum:1,maximum:200},...projectFields},required:['target'],additionalProperties:false} },
  { name:'stellar_context', description:'Recommend the smallest relevant reading set for a coding task. Deterministic and source-body-free.', inputSchema:{type:'object',properties:{task:{type:'string'},limit:{type:'integer',minimum:1,maximum:12},...projectFields},required:['task'],additionalProperties:false} },
  { name:'stellar_architecture', description:'Return deterministic application entries, structural core files, role counts, galaxies and modules.', inputSchema:{type:'object',properties:{...projectFields},additionalProperties:false} }
]

async function projectPathFor(args, defaultProject, queryOptions) {
  const reference = args.projectId || args.project || args.projectPath || defaultProject || null
  const resolved = await resolveAnyProject(reference, queryOptions)
  return resolved.root
}

async function invoke(name, args = {}, defaultProject = null, queryOptions = {}) {
  if (name === 'stellar_projects') return projectSummaries(queryOptions)
  const project = await projectPathFor(args, defaultProject, queryOptions)
  if (name === 'stellar_search') return searchProject(project, args.query, { ...queryOptions, limit: args.limit ?? 10 })
  if (name === 'stellar_file') return fileDetail(project, args.path, queryOptions)
  if (name === 'stellar_symbol') return symbolLookup(project, args.query, { ...queryOptions, limit: args.limit ?? 10 })
  if (name === 'stellar_related') return related(project, args.target, { ...queryOptions, limit: args.limit ?? 30 })
  if (name === 'stellar_impact') return impact(project, args.target, { ...queryOptions, depth: args.depth ?? 3, limit: args.limit ?? 50 })
  if (name === 'stellar_context') return contextForTask(project, args.task, { ...queryOptions, limit: args.limit ?? 8 })
  if (name === 'stellar_architecture') return architectureOverview(project, queryOptions)
  throw new Error(`Unknown tool: ${name}`)
}

function write(message, output = process.stdout) { output.write(JSON.stringify(message) + '\n') }

export async function handleMcpMessage(message, { defaultProject = null, queryOptions = {} } = {}) {
  const { id, method, params } = message
  if (method === 'initialize') {
    return { jsonrpc:'2.0', id, result:{ protocolVersion: params?.protocolVersion || PROTOCOL_VERSION, capabilities:{ tools:{ listChanged:false } }, serverInfo:{ name:'stellarcode', version:'0.5.0' }, instructions:'StellarCode is global in v0.5. Use stellar_projects to discover registered repositories; query project metadata before broad source search. Missing repositories retain their indexes but cannot be queried until restored.' } }
  }
  if (method === 'ping') return { jsonrpc:'2.0', id, result:{} }
  if (method === 'tools/list') return { jsonrpc:'2.0', id, result:{ tools } }
  if (method === 'tools/call') {
    try {
      const data = await invoke(params?.name, params?.arguments ?? {}, defaultProject, queryOptions)
      return { jsonrpc:'2.0', id, result:{ content:[{ type:'text', text:JSON.stringify(data) }], structuredContent:{ result:data }, isError:false } }
    } catch (error) {
      return { jsonrpc:'2.0', id, result:{ content:[{ type:'text', text:JSON.stringify({ error:error.code ?? 'STELLAR_ERROR', message:error.message }) }], isError:true } }
    }
  }
  if (method?.startsWith('notifications/')) return null
  return { jsonrpc:'2.0', id, error:{ code:-32601, message:`Method not found: ${method}` } }
}

export async function startMcpServer(options = {}) {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    const response = await handleMcpMessage(message, { defaultProject: options.projectPath ?? null, queryOptions: options.queryOptions ?? {} })
    if (response) write(response, output)
  }
}

export { tools as mcpTools, invoke as invokeMcpTool }
