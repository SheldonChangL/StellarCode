# v0.6.1 dev: agent A/B after the import, budget and hint changes

**Result: index and delivery improved; agent usage did not change.**

This is a dev-set measurement on the three repositories that v0.6.1 was tuned on. It is not an unseen holdout.

## What changed

| Commit | Change |
|---|---|
| `2e1b2b3` | Resolve Python absolute imports from a nested source root |
| `b7b54f4` | Discount widely registered callbacks in the slice edge budget |
| `d87e47b` | Report admitted relations beyond the edge budget as `semanticHints` |

## Deterministic effect (74 annotated required edges)

| Stage | Before (`87a5edb`) | After (`d87e47b`) |
|---|---|---|
| In the index | 58 | 71 |
| Delivered to the agent | 36 | 40 (36 grounded + 4 hinted) |

Redmine-AI-agent index recall went from 19/32 to 32/32.

## Agent A/B

- Claude CLI, pull delivery, 3 repositories × 12 tasks × 3 repetitions.
- Three arms: `baseline` and `stellar` on `d87e47b`, and `stellar` on the pre-change runtime `87a5edb`.
- `changedDuringCampaign=false` in all six manifests.
- 19 of 324 runs failed to launch (exit 1, 0 tokens, about 2.5 s; cause not identified). The numbers below use the 96 task-repetition pairs that are valid in all three arms.

| Arm | Input tokens | Tool calls | Search calls | Cost | Answer / grounded |
|---|---|---|---|---|---|
| `baseline` | 18.44M | 628 | 277 | $25.96 | 96 / 87 |
| `stellar` before | 15.98M | 391 | 121 | $26.06 | 96 / 86 |
| `stellar` after | 16.05M | 390 | 117 | $24.65 | 96 / 87 |

Intervals are 95% bootstrap intervals over tasks. Positive means a reduction.

| Comparison | Input tokens | Tool calls | Cost |
|---|---|---|---|
| after vs `baseline` | 13.0% [0.5%, 24.9%] | 37.9% [26.2%, 48.9%] | 5.0% [−3.2%, 13.3%] |
| after vs before | −0.4% [−5.6%, 5.3%] | 0.3% [−7.0%, 7.8%] | 5.4% [0.6%, 9.6%] |

- Stellar against `baseline`: the tool-call reduction is reliable, the input reduction is real but imprecise, and the cost difference is not established.
- After against before: no measurable difference in input tokens or tool calls. Per task, input fell in 17 and rose in 19.
- Cost varies between repetitions with cache writes (pooled $6 to $11 per repetition), so the cost interval is not used as a finding.

## Reading

More required edges reach the agent, but the agent explores as much as before. The next question is why delivered edges do not replace reads and searches, not how to raise recall further.

## Graphify comparison (single repetition, runtime `87a5edb`)

Graphify 0.9.106 was run as an external condition through a benchmark shim on the branch `bench/graphify-condition` (not merged).

| Condition | Input tokens | Tool calls | Cost vs `baseline` |
|---|---|---|---|
| `baseline` | 7.19M | 230 | — |
| `stellar` | 6.60M | 157 | +2.4% |
| `graphify` | 8.23M | 222 | +16.8% |

- Answers were correct in 36/36 runs for every condition.
- Graphify's index holds 72 of the 74 required edges. That gap motivated the Python import change above.

Raw runs are under `validation/graphify/` and are not committed.
