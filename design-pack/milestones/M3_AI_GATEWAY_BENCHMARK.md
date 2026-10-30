# M3 — AI Gateway & MVP Validation

## Objective

讓 Claude/Codex/其他 MCP-compatible agent 先查 StellarCode 再開原始碼，並用 A/B benchmark 證明是否真的省 discovery token/tool calls。

## Deliverables

- MCP server.
- `stellar_search`.
- `stellar_file`.
- `stellar_symbol`.
- `stellar_related`.
- `stellar_impact`.
- `stellar_context`.
- Compact response serializer.
- Agent instruction installer/snippet.
- Benchmark harness.
- Baseline vs StellarCode report.

## Work packages

### M3-001 MCP transport
Local-only server with project resolution from cwd/project UUID.

### M3-002 Search/file/symbol tools
Strict schemas and bounded payload sizes.

### M3-003 Related/impact tools
Graph traversal with depth/result limits.

### M3-004 Context recommender
Task string -> candidate files/symbols/tests using deterministic ranking first.

Initial ranking signals:

- lexical/query match;
- symbol match;
- graph proximity;
- file importance;
- test relation;
- recent-change relevance.

No LLM required for ranking in MVP.

### M3-005 Agent rule
Provide minimal rule to query StellarCode before broad repository search.

### M3-006 Benchmark harness
Capture tool calls, input token estimates/telemetry when available, files opened, timestamps, task result.

## Token compactness budgets

Suggested default MCP payload limits:

- search: <= 10 results;
- file detail: <= 20 symbols, <= 10 relations/type;
- related: <= 30 edges;
- context: <= 8 recommended files total;
- no source body in responses.

## Benchmark suite

At least 12 tasks across 2–3 repositories, covering:

- locate behavior;
- bug fix;
- small feature;
- dependency trace;
- test impact;
- recent regression.

## MVP acceptance thresholds

Across the suite:

- discovery tool calls reduced >= 50%;
- discovery input tokens reduced >= 40%;
- median time to first relevant file reduced >= 50%;
- task success is not lower than baseline by more than 5 percentage points;
- StellarCode query failures < 2%.

## Exit criteria — MVP COMPLETE

M0–M3 gates all pass and benchmark results meet threshold or produce a documented decision showing which hypothesis failed and why.
