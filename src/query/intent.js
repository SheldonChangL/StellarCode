// Deterministic task-intent model shared by CLI, MCP and the benchmark diagnostics.
//
// Each intent accumulates weighted regex signals from the prompt text. No LLM, no
// repository state, no task IDs: the same prompt always yields the same intent.
// Benchmark task categories are author metadata and are never an input here.

export const TASK_INTENTS = ['navigation', 'flow', 'impact', 'editing-prep']

// weight 3 = the phrase alone decides the intent; weight 1-2 = supporting evidence.
const SIGNALS = {
  impact: [
    { id: 'impact-word', weight: 3, re: /\b(?:impact(?:s|ed)?|affect(?:s|ed)?|would\s+break|breaks?|ripple)\b|影響|影响/i },
    { id: 'dependents', weight: 3, re: /\b(?:what|who|which\s+\w+)\s+(?:uses|depends?\s+on|calls|consumes)\b|\bdepend(?:s|ency|encies|ents?)\b|依賴|依赖/i },
    { id: 'conditional-change', weight: 3, re: /\bif\b[^.?!;]{0,80}?\bchang(?:es|ed)\b/i },
    { id: 'consumers', weight: 1, re: /\b(?:consumers?|callers?|usages?)\b/i }
  ],
  flow: [
    { id: 'trace', weight: 3, re: /\btrac(?:e|es|ing)\b|追蹤|追踪/i },
    { id: 'flow-word', weight: 3, re: /\bflows?\b|流程/i },
    { id: 'from-to', weight: 2, re: /\bfrom\s+[^.?!;]{1,80}?\bto\b|->|→/i },
    { id: 'integration', weight: 2, re: /\bintegrat(?:e|es|ed|ion)\s+(?:into|with)\b|\bwired?\s+(?:into|to)\b/i },
    // Producer -> consumer questions ("where X constructs or consumes Y") are flows.
    { id: 'consume', weight: 3, re: /\bconsum(?:e|es|ed)\b/i },
    { id: 'transition', weight: 2, re: /\btransitions?\b|\bpropagat(?:e|es|ed|ion)\b|\bend-to-end\b/i }
  ],
  'editing-prep': [
    // "implementation"/"implemented" are descriptive, never edit actions; only bare verbs count.
    { id: 'edit-verb', weight: 3, re: /\b(?:modify|change|add|implement|refactor|adjust|tweak|extend|rewrite|rename)\b|修改|新增|實作|实现|重構|重构|調整|调整/i },
    { id: 'before-editing', weight: 3, re: /\bbefore\s+(?:adding|changing|modifying|adjusting|refactoring|extending|editing|tweaking|implementing|rewriting)\b/i },
    { id: 'edit-request', weight: 3, re: /\bi\s+(?:need|want|plan)\s+to\s+(?:modify|change|add|edit|adjust|tweak|extend|refactor|update|rewrite)\b|\bprepare\s+(?:the\s+)?files\b|\bwhere\s+should\s+i\s+(?:modify|change|edit|add)\b/i }
  ],
  navigation: [
    { id: 'locate', weight: 1, re: /\b(?:find|where|locate|which\s+file|owns?|defined)\b|哪裡|哪些|在哪/i }
  ]
}

// Question-shape vocabulary. Only these words of a matched signal are discounted as
// code evidence; content words inside a matched span ("if <pressure> changes") are not.
const SHAPE_WORD = /^(?:trac|flows?$|consum|integrat|wired?$|transition|propagat|impact|affect|break|ripple|depend|chang|consumers?$|callers?$|usages?$|uses$|calls$|modif|add|implement|refactor|adjust|tweak|extend|rewrite|rename|edit|prepar|find$|where$|locate$|owns?$|defined$)/

// When two intents score equally, the more specific one wins.
const PRECEDENCE = ['impact', 'editing-prep', 'flow']
const DECISIVE_SCORE = 3

export function classifyIntent(query) {
  const raw = String(query ?? '')
  const scores = { navigation: 0, flow: 0, impact: 0, 'editing-prep': 0 }
  const signals = []
  const signalWords = []
  for (const [intent, rules] of Object.entries(SIGNALS)) {
    for (const rule of rules) {
      const match = rule.re.exec(raw)
      if (!match) continue
      scores[intent] += rule.weight
      signals.push(`${intent}:${rule.id}`)
      // Words that describe the question's shape ("consumes", "transition", "defined"),
      // so lexical ranking can discount them as code evidence.
      signalWords.push(...(match[0].toLowerCase().match(/[a-z]+/g) ?? []).filter(word => SHAPE_WORD.test(word)))
    }
  }
  let intent = 'navigation'
  for (const candidate of PRECEDENCE) {
    if (scores[candidate] >= DECISIVE_SCORE && (intent === 'navigation' || scores[candidate] > scores[intent])) intent = candidate
  }
  const competing = PRECEDENCE.reduce((sum, candidate) => sum + (candidate === intent ? 0 : scores[candidate]), 0)
  const own = intent === 'navigation' ? DECISIVE_SCORE : scores[intent]
  return { intent, confidence: Number((own / (own + competing)).toFixed(2)), signals, signalWords: [...new Set(signalWords)] }
}

export function taskIntent(query) {
  return classifyIntent(query).intent
}
