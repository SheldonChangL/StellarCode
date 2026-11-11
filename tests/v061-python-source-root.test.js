import test from 'node:test'
import assert from 'node:assert/strict'
import { semanticRepo, semanticEdges } from './helpers-v06.js'

const has = (edges, type, from, to) => edges.some(e => e.type === type && e.from === from && e.to === to)

test('v0.6.1 Python: an absolute import resolves from a source root above the importing file', async () => {
  const w = await semanticRepo({
    'backend/app/__init__.py': '',
    'backend/app/chat.py': `def claim_run(session):\n    return session\n`,
    'backend/previews/store.py': `def load_preview(key):\n    return key\n`,
    'backend/app/confirm.py': `from previews.store import load_preview\nfrom app import chat as chat_module\n\n\ndef confirm(key):\n    chat_module.claim_run(key)\n    return load_preview(key)\n`,
    'backend/orch/graph.py': `from previews.store import (\n    load_preview,\n)\n\n\ndef build(key):\n    return load_preview(key)\n`
  })
  try {
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'CALLS', 'backend/app/confirm.py#confirm', 'backend/previews/store.py#load_preview'), 'function imported from a sibling package under backend/')
    assert.ok(has(edges, 'CALLS', 'backend/app/confirm.py#confirm', 'backend/app/chat.py#claim_run'), 'member call on an aliased module import')
    assert.ok(has(edges, 'CALLS', 'backend/orch/graph.py#build', 'backend/previews/store.py#load_preview'), 'importer in a namespace package without __init__.py')
  } finally { await w.cleanup() }
})

test('v0.6.1 Python: the repository root wins, and an ambiguous source root resolves to nothing', async () => {
  const w = await semanticRepo({
    'util/tools.py': `def helper(x):\n    return x\n`,
    'svc/util/tools.py': `def helper(x):\n    return x\n`,
    'svc/run.py': `from util.tools import helper\n\n\ndef run(x):\n    return helper(x)\n`,
    'a/shared/core.py': `def work(x):\n    return x\n`,
    'a/b/shared/core.py': `def work(x):\n    return x\n`,
    'a/b/c/job.py': `from shared.core import work\n\n\ndef job(x):\n    return work(x)\n`
  })
  try {
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'CALLS', 'svc/run.py#run', 'util/tools.py#helper'), 'repository-root module keeps priority')
    assert.ok(!has(edges, 'CALLS', 'svc/run.py#run', 'svc/util/tools.py#helper'))
    assert.ok(!edges.some(e => e.from === 'a/b/c/job.py#job'), 'two candidate source roots: no edge')
  } finally { await w.cleanup() }
})
