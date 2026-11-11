// Deterministic task-intent model shared by CLI, MCP and the benchmark diagnostics.
//
// Each intent accumulates weighted regex signals from the prompt text. No LLM, no
// repository state, no task IDs: the same prompt always yields the same intent.
// Benchmark task categories are author metadata and are never an input here.

export const TASK_INTENTS = ['navigation', 'flow', 'impact', 'editing-prep']

// weight 3 = the phrase alone decides the intent; weight 1-2 = supporting evidence.
// `relation: true` marks an explicit relation question ("what uses X", "if X changes,
// which code must be reviewed"): the relation is the question itself, so it outranks an
// editing verb that merely names the change.
const CHANGE_VERB = String.raw`(?:chang(?:e|es|ed|ing)|renam(?:e|es|ed)|modif(?:y|ies|ied)|remov(?:e|es|ed)|stop(?:s|ped)?|gains?|re-?key(?:s|ed)?)`
const SIGNALS = {
  impact: [
    { id: 'impact-word', weight: 3, relation: true, re: /\b(?:impact(?:s|ed)?|affect(?:s|ed)?|would\s+break|breaks?|ripple)\b|影響|影响/i },
    { id: 'dependents', weight: 3, relation: true, re: /\b(?:what|who|which)(?:\s+[\w-]+){0,3}\s+(?:uses|use|depends?\s+on|calls|call|consumes|relies\s+on|rely\s+on|imports)\b|\bdepends?\s+on\b|\bdependents?\b|\brel(?:y|ies)\s+on\b|依賴|依赖/i },
    // "If X changes / is renamed / stops returning …, which/what …?": a conditional change
    // followed by a question about other code.
    { id: 'conditional-change', weight: 3, relation: true, re: new RegExp(String.raw`\bif\b[^.?!;]{0,220}?\b${CHANGE_VERB}\b[^.?!;]{0,220}?[,(]?\s*(?:what|which|who|identify|list|find|show|name)\b`, 'i') },
    { id: 'conditional-change-short', weight: 3, relation: true, re: /\bif\b[^.?!;]{0,220}?\bchang(?:es|ed)\b/i },
    // "which files must be reviewed / what needs review": review scope, not an edit request.
    { id: 'review-scope', weight: 3, relation: true, re: /\b(?:what|which)\b[^.?!;]{0,120}?\b(?:needs?|must|should)\s+(?:to\s+)?(?:be\s+)?(?:review(?:ed)?|re-?check(?:ed)?|revisit(?:ed)?|audit(?:ed)?)\b|\b(?:what|which)\b[^.?!;]{0,60}?\bneeds?\s+review\b/i },
    { id: 'consumer-question', weight: 3, relation: true, re: /\b(?:which|what|who)\s+(?:[\w-]+\s+){0,3}(?:consumers?|callers?|call\s+sites?|dependents?|importers?)\b/i },
    { id: 'consumers', weight: 1, re: /\b(?:consumers?|callers?|usages?)\b/i }
  ],
  flow: [
    // The verb ("trace how…"), not the noun ("trace ids").
    { id: 'trace', weight: 3, relation: true, re: /\btrac(?:e|ing)\b(?!\s+(?:ids?|logs?|files?|data|events?|outputs?|spans?)\b)|\btraces\s+(?:what|how|where|when|which|the|a|an|each|every|through|from|back)\b|追蹤|追踪/i },
    { id: 'flow-word', weight: 3, re: /\bflows?\b|流程/i },
    { id: 'from-to', weight: 2, re: /\bfrom\s+[^.?!;]{1,80}?\bto\b|->|→/i },
    { id: 'what-happens', weight: 3, relation: true, re: /\bwhat\s+happens\s+(?:after|when|next|once|before)\b|\bhow\s+(?:does|do|is|are)\b[^.?!;]{1,80}?\b(?:reach(?:es)?|get\s+(?:persisted|saved|stored|sent|delivered)|end\s+up)\b/i },
    { id: 'integration', weight: 2, re: /\bintegrat(?:e|es|ed|ion)\s+(?:into|with)\b|\bwired?\s+(?:into|to)\b/i },
    // Producer -> consumer questions ("where X constructs or consumes Y") are flows.
    { id: 'consume', weight: 3, re: /\bconsum(?:e|es|ed)\b/i },
    { id: 'transition', weight: 2, re: /\btransitions?\b|\bpropagat(?:e|es|ed|ion)\b|\bend-to-end\b/i }
  ],
  'editing-prep': [
    // Bare verbs only: "implementation" is descriptive, and "the last change" is a noun.
    { id: 'edit-verb', weight: 3, re: /(?<!\b(?:the|a|an|last|any|each|every|this|that|no|first|next|recent|state|code)\s)\b(?:modify|change|add|implement|refactor|adjust|tweak|extend|rewrite|rename|introduce)\b|修改|新增|實作|实现|重構|重构|調整|调整/i },
    { id: 'before-editing', weight: 3, re: /\bbefore\s+(?:changing|modifying|adjusting|refactoring|editing|tweaking|rewriting)\b|\bbefore\s+making\s+(?:this|the|that|a|these|such)\s+changes?\b/i },
    // Adding something new is an edit plan even when the prompt asks what to check first.
    { id: 'before-adding', weight: 3, additive: true, re: /\bbefore\s+(?:adding|extending|implementing|introducing|exposing)\b/i },
    { id: 'edit-request', weight: 3, re: /\bi\s+(?:need|want|plan)\s+to\s+(?:modify|change|add|edit|adjust|tweak|extend|refactor|update|rewrite)\b|\bprepare\s+(?:the\s+)?files\b|\bwhere\s+should\s+i\s+(?:modify|change|edit|add)\b/i },
    { id: 'edit-scope', weight: 3, re: /\b(?:must|need(?:s)?\s+to|should)\s+be\s+(?:edited|modified|touched|changed|updated)\b|\bwhich\s+(?:[\w-]+\s+){0,3}files?\s+(?:must|should|do\s+i\s+need\s+to|to)\s+(?:edit|modify|touch)\b|\bfiles?\s+(?:should\s+i|to)\s+inspect\s+before\s+implementing\b/i }
  ],
  navigation: [
    { id: 'locate', weight: 1, re: /\b(?:find|where|locate|which\s+file|owns?|defined)\b|哪裡|哪些|在哪/i }
  ]
}

// Question-shape vocabulary. Only these words of a matched signal are discounted as
// code evidence; content words inside a matched span ("if <pressure> changes") are not.
const SHAPE_WORD = /^(?:review|check|revisit|audit|imports$|importers?$|dependents?$|renam|gains?$|remov|rel(?:y|ies)$|trac|flows?$|consum|integrat|wired?$|transition|propagat|impact|affect|break|ripple|depend|chang|consumers?$|callers?$|usages?$|uses?$|calls?$|modif|add|implement|introduc|refactor|adjust|tweak|extend|rewrite|rename|edit|prepar|find$|where$|locate$|owns?$|defined$|happens$|reach)/

// When two intents score equally, the more specific one wins.
const PRECEDENCE = ['impact', 'editing-prep', 'flow']
const DECISIVE_SCORE = 3

// Semantic seed role: which symbol kinds may start the semantic slice. It is decided
// from the query text only and never rewrites lexical scoring.
//   definition: "where is X defined", "what fields does X have" -> types are valid seeds
//   behavior:   "where is X handled / validated / computed"      -> executable seeds
//   flow:       trace / how does X reach Y                       -> executable chain seeds
//   consumer:   what uses X / if X changes                       -> contracts are valid seeds
const DEFINITION_RE = /\bwhere\s+(?:is|are)\b[^.?!;]{1,80}?\b(?:defined|declared)\b(?!\s+and\s+(?:used|applied|enforced|checked))|\bwhat\s+(?:is|are)\s+the\s+(?:type|types|shape|schema|fields?|properties|members)\b|\bwhat\s+(?:fields|properties|members)\b|\b(?:schema|interface|type\s+definition|data\s+shape)\s+(?:for|of)\b|\btype\s+for\b|\bdefinition\s+of\b/i

export function seedRoleFor(intent, query) {
  if (intent === 'impact') return 'consumer'
  if (intent === 'flow') return 'flow'
  return DEFINITION_RE.test(String(query ?? '')) ? 'definition' : 'behavior'
}

export function classifyIntent(query) {
  const raw = String(query ?? '')
  const scores = { navigation: 0, flow: 0, impact: 0, 'editing-prep': 0 }
  const signals = []
  const signalWords = []
  let impactRelation = false
  let flowRelation = false
  let additive = false
  const impactRelationIds = []
  for (const [intent, rules] of Object.entries(SIGNALS)) {
    for (const rule of rules) {
      const match = rule.re.exec(raw)
      if (!match) continue
      if (rule.relation && intent === 'impact') { impactRelation = true; impactRelationIds.push(rule.id) }
      if (rule.relation && intent === 'flow') flowRelation = true
      if (rule.additive) additive = true
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
  // Explicit precedence. "If X changes, what else is affected" / "before changing X, which
  // consumers need review" is impact even with editing verbs present; "I need to change X"
  // has no impact relation and stays editing-prep. A review question about something being
  // added ("before adding X, which files should be reviewed") is still an edit plan.
  const additiveReview = additive && impactRelation && impactRelationIds.every(id => id === 'review-scope')
  if (impactRelation && !additiveReview && intent !== 'impact') {
    if (intent === 'editing-prep' || intent === 'navigation' || (intent === 'flow' && !flowRelation)) {
      intent = 'impact'
      signals.push('precedence:impact-relation')
    }
  }
  if (additiveReview && intent === 'impact') { intent = 'editing-prep'; signals.push('precedence:adding-over-review-scope') }
  // An explicit trace / "what happens after" outranks navigation words ("where", "which
  // file") and an editing verb used as a noun.
  if (flowRelation && intent === 'editing-prep' && !impactRelation && scores['editing-prep'] <= scores.flow) {
    intent = 'flow'
    signals.push('precedence:trace-over-edit-verb')
  }
  const competing = PRECEDENCE.reduce((sum, candidate) => sum + (candidate === intent ? 0 : scores[candidate]), 0)
  const own = intent === 'navigation' ? DECISIVE_SCORE : scores[intent]
  // Categorical confidence: high = one decisive intent; medium = decided by precedence
  // over another decisive intent, or navigation with only weak competing evidence;
  // low = no decisive evidence at all (the slice then uses a small mixed-direction plan).
  const decisiveOthers = PRECEDENCE.filter(candidate => candidate !== intent && scores[candidate] >= DECISIVE_SCORE).length
  let intentConfidence
  if (intent === 'navigation') intentConfidence = scores.navigation > 0 && competing === 0 ? 'high' : scores.navigation > 0 && competing < DECISIVE_SCORE ? 'medium' : 'low'
  else intentConfidence = decisiveOthers ? 'medium' : 'high'
  return {
    intent,
    confidence: Number((own / (own + competing)).toFixed(2)),
    intentConfidence,
    seedRole: seedRoleFor(intent, raw),
    signals,
    signalWords: [...new Set(signalWords)]
  }
}

export function taskIntent(query) {
  return classifyIntent(query).intent
}
