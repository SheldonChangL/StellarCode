# First-relevant investigation — working notes (pre-holdout)

Source: v0.5.5 Reefmori holdout-final (Claude 2.1.317, 30 pairs), retroactive decomposition via
`stellar benchmark first-relevant`, plus all stored Claude interactions.jsonl in validation/.

Medians (ms from agent process spawn):

| component | baseline | stellar |
|---|---:|---:|
| first stream event | 740 | 754 |
| first model (assistant) event | 3184 | 3308 |
| first tool start | 3225 | 3555 |
| first tool duration | 41 | 1002 |
| relevant tool start | 5528 | 3555 |
| relevant tool sequence | 2 | 1 |
| firstRelevantMs | 5625 | 4552 |

Tool durations across all stored Claude runs (n in brackets):
- first Bash call of a session, `stellar context`: p50 1008 (249)
- first Bash call, native source read: p50 863 (25)
- later Bash call, native source read: p50 43 (61)
- later Bash call, `stellar context`: p50 123 (32)
- later Bash call, `stellar source`: p50 104 (63)

Local deterministic latency (v0.5.6 `benchmark latency`, Reefmori 6f2b9a5, 10 tasks x 7):
- `stellar context` cold p50 128 / p95 179 ms; warm p50 131 / p95 168 ms
- node CLI floor (`--version`) p50 58 ms; full index build 362 ms; no-op sync p50 95 ms

Interpretation:
- ~3.2–3.5 s before ANY tool runs is agent startup + first provider turn; it is identical in both
  conditions and cannot be reduced by StellarCode.
- ~0.75–0.88 s is a one-time Claude Code cost on the first Bash call of a session, whatever it runs.
  Stellar always pays it (its first action is a Bash command); baseline usually avoids it because
  its first tools are built-in Grep/Glob/Read.
- StellarCode's own computation is ~0.13 s.
- Upper bound if Stellar's first call cost 0 ms: (5625 − 3555) / 5625 ≈ 37% < 40% gate.
  The 40% firstRelevant gate is structurally unreachable under this metric definition with this agent.
