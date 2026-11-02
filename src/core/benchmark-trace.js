import fs from 'node:fs'
import path from 'node:path'

function compactResult(command, value) {
  if (command === 'source' && value && typeof value === 'object') {
    return { path:value.path, lines:value.lines, lineCount:value.lineCount, sourceOfTruth:Boolean(value.sourceOfTruth) }
  }
  return value
}

export function traceCliResult(command, args, value) {
  const file = process.env.STELLAR_BENCH_TRACE_FILE
  if (!file || !command) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive:true })
    const row = { timestampMs:Date.now(), command, args, result:compactResult(command,value) }
    let line = JSON.stringify(row)
    if (line.length > 256_000) line = JSON.stringify({ timestampMs:row.timestampMs, command, args, truncated:true })
    fs.appendFileSync(file, line + '\n')
  } catch {}
}
