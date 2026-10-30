# M5 — Advanced Code Intelligence & Productization

## Objective

在核心價值驗證後，加入 AST 之外的工程記憶：co-change、change intent、architecture decisions、timeline、多 repo universe。

## Deliverables candidates

### Co-change graph
Infer relationships from files repeatedly changed together in commits/working sessions.

### Change memory
Record optional human/agent reason while deriving files/diffs automatically.

### Architecture decisions
Attach explicit decisions to files/symbols; warn agents when proposed changes conflict.

### Timeline universe
Visualize repository growth/change over time.

### Cross-repository graph
Connect backend/mobile/infra repositories through explicit API/schema/config relationships.

### More languages
Parser plugin SDK and language-specific analyzers.

### Semantic summaries
Optional local/remote LLM summaries with secret filtering and hash-based caching.

## Guardrails

- Advanced intelligence must not become required to keep the base index fresh.
- Semantic features must be clearly labeled by confidence/source.
- Deterministic graph facts and inferred/AI facts must be distinguishable.

## Validation

Each advanced feature requires a separate measurable hypothesis, e.g. co-change improves relevant-file recall without materially increasing false positives.

## Exit criteria

No single M5 feature is mandatory for initial product release. Promote only features with measurable navigation/reasoning value.
