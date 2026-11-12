# v0.6.2 dev: agent A/B after the excerpt, budget and declaration changes

**Result: at `17ca062` total agent usage did not change, because six tasks returned more than the agent harness shows. With that fixed (`b605975`), those six tasks use less than before the changes. The full set has not been rerun.**

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

## Follow-up: responses over the harness output limit

Analysis of the searches in the A/B above found that the 20,000-byte budget pushed six tasks over the size Claude Code shows for one tool result.

- In 18 of the 108 `17ca062` runs (six tasks × 3 repetitions) the `stellar context` output was 29.6 to 31.7 KB. Claude Code saved it to a file and showed the agent a 2 KB preview.
- The agents then parsed the saved file with `python3` or `jq`: 25 extra calls. This never happened in the `7f69090` arm (largest output 23.8 KB).
- In those 18 runs, after vs before was +5.8% input tokens and +18.5% tool calls. In the other 90 runs it was −1.5% and −6.1%, with cost +7.1% [3.9%, 10.2%].

### Fix

| Commit | Change |
|---|---|
| `b605975` | Print `--compact --json` on one line and hold the serialized response under 29,000 bytes |

| 36 dev tasks | `17ca062` | `b605975` |
|---|---|---|
| Largest response | 32,444 bytes | 28,484 bytes |
| Responses over 30,000 bytes | 6 | 0 |
| Total source bytes returned | 443,257 | 443,257 |

No entry was dropped on the dev set; the reduction is the removed indentation.

### Rerun of the six affected tasks

- Same setup, 6 tasks × 3 repetitions, two `stellar` arms: `b605975` and `7f69090`. All 36 runs completed; `changedDuringCampaign=false` in all six manifests.
- No `b605975` run had its output saved to a file, and no run parsed a saved output.

| Arm | Input tokens | Tool calls | Search calls | Model turns | Cost | Answer / grounded |
|---|---|---|---|---|---|---|
| before (`7f69090`) | 4.08M | 97 | 36 | 90 | $4.31 | 18 / 15 |
| after (`b605975`) | 3.47M | 80 | 26 | 75 | $4.39 | 18 / 15 |
| change | −14.9% | −17.5% | −27.8% | −16.7% | +1.9% | same |

Input tokens / tool calls, summed over 3 repetitions:

| Task | before | after |
|---|---|---|
| audit-orders `flow-monthly-report-email` | 371K / 7 | 243K / 3 |
| audit-orders `flow-reconcile-to-history-record` | 373K / 8 | 244K / 3 |
| Redmine-AI-agent `flow-approve-staged-batch-update` | 1,104K / 26 | 877K / 20 |
| JetBook `flow-api-update-archived-space-refused` | 938K / 21 | 808K / 17 |
| audit-orders `edit-storage-dir-configurable` | 663K / 23 | 644K / 22 |
| JetBook `flow-autosave-version-conflict` | 631K / 12 | 658K / 15 |

- Two flow tasks are now answered from the context alone in all three repetitions. No flow run did that in the A/B above.
- These six tasks were selected because the truncation affected them. They do not represent the dev set, and six tasks do not support an interval.
- Cost did not fall: fewer turns are offset by more cache writes for the larger context.
- The 30,000-byte threshold was observed from Claude Code's truncation messages. Other harnesses were not checked.

### Remaining searches (`17ca062` arm, 141 searches, classified by rule)

| What the agent searched for | Searches |
|---|---|
| A function inside a file it already knew | 51 |
| Repository-wide, every term already in the context | 20 |
| Repository-wide, some terms in the context | 43 |
| Repository-wide, no term in the context | 19 |
| File listings | 8 |

The three gaps behind them: the body of a callee in another file, a list of every place a name is used, and tasks where the context missed the entry point.

Raw runs are under `validation/graphify/ab2-new/`, `ab2-old/`, `ab3-new/` and `ab3-old/` and are not committed.
