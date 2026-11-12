# v0.6.2 dev: agent A/B after the excerpt, budget and declaration changes

**Result: the returned context is more complete; total agent usage did not change.**

This is a dev-set measurement on the three repositories that v0.6.1 was tuned on. It is not an unseen holdout.

## What changed

| Commit | Change |
|---|---|
| `7317d56` | Grow narrowed source ranges back to their symbol bounds |
| `eb42479` | Raise the default context source budget from 12,000 to 20,000 bytes |
| `17ca062` | Attach same-file declarations the returned ranges name |

## Deterministic effect (36 dev tasks)

| Measure | Before (`7f69090`) | After (`17ca062`) |
|---|---|---|
| Returned ranges cut inside a symbol | 101 | 28 |
| Lines agents read after context in earlier runs that the context now already contains | 1.2% | 9.6% |
| `same-file-declaration` entries | 0 | 126 (in 22 of 36 tasks) |

- The semantic-slice funnel is unchanged (71 indexed, 40 delivered).
- The largest task response is 19,989 source bytes.

## Agent A/B

- Claude CLI, pull delivery, 3 repositories × 12 tasks × 3 repetitions.
- Two arms, both `stellar`: the runtime at `17ca062` (20,000-byte budget) and the runtime at `7f69090` (12,000-byte budget). No `baseline` arm.
- `changedDuringCampaign=false` in all six manifests.
- All 216 runs completed (exit 0). The numbers below use all 108 task-repetition pairs.

| Arm | Input tokens | Tool calls | Search calls | Model turns | Cost | Answer / grounded | Answered with no further inspection |
|---|---|---|---|---|---|---|---|
| before | 19.28M | 439 | 150 | 458 | $20.04 | 108 / 97 | 9 |
| after | 19.29M | 435 | 150 | 458 | $20.70 | 108 / 97 | 19 |

Intervals are 95% bootstrap intervals over tasks. Positive means a reduction.

| Measure | After vs before |
|---|---|
| Input tokens | 0.0% [−5.8%, 6.1%] |
| Tool calls | 0.9% [−8.2%, 9.9%] |
| Search calls | 0.0% [−13.2%, 14.1%] |
| Model turns | 0.0% [−5.9%, 6.4%] |
| Cost | −3.3% [−7.4%, 1.0%] |

Per repository, input tokens changed by −4.3% (audit-orders), −4.5% (JetBook) and +8.6% (Redmine-AI-agent). Per task, input fell in 12 and rose in 24.

### Runs by what the agent did after the context

| After the context | Before: runs (mean input) | After: runs (mean input) |
|---|---|---|
| Answered directly | 9 (75K) | 19 (77K) |
| Read more, no search | 26 (126K) | 21 (138K) |
| Searched | 73 (210K) | 68 (220K) |

| Category | Answered directly, before → after |
|---|---|
| navigation | 3 → 9 |
| impact | 6 → 10 |
| flow | 0 → 0 |
| editing-prep | 0 → 0 |

## Reading

- More runs answer from the context alone, in navigation and impact tasks only.
- 68 of 108 runs still search. Each of their turns now carries a larger context, which offsets the saving from the direct answers.
- Cache writes rose from 1.70M to 1.77M tokens. The cost interval includes zero, so the cost increase is not established.
- The replay coverage gain did not predict agent behavior: the extra lines are not what decides whether the agent searches.

The changes are kept because correctness did not regress, but they are not a usage reduction. The open question is the searching runs, especially editing-prep, where every run searches to confirm it has found all references.

Raw runs are under `validation/graphify/ab2-new/` and `validation/graphify/ab2-old/` and are not committed.
