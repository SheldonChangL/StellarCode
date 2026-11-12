# v0.6.2 dev: agent A/B after the excerpt, budget and declaration changes

**Result: at `17ca062` total agent usage did not change, because six tasks returned more than the agent harness shows. With that fixed and body evidence added to file ranking (`6c4097d`), the full dev set uses 14.3% fewer input tokens and 23.5% fewer tool calls than `7f69090`, with the same number of correct answers.**

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

## Follow-up: entry points the context missed

### A name-usage list was prototyped and not shipped

The idea was to list where the names in the returned source appear elsewhere, so the agent would not search to confirm it. Replayed against the 84 repository-wide searches in the `17ca062` arm:

| List | Searches answered in full | In part | Not at all |
|---|---|---|---|
| 16 names, 3 KB | 6 to 7 | 25 to 34 | 43 to 53 |
| No limit (about 17 KB per response) | 19 | 36 | 29 |

The agents' patterns pair one name from the context with names they guess (`editComment|canEdit|canDelete`). They are looking for what the context did not return. The prototype is on the local branch `exp/v0.6.2-name-usages`.

### What the context missed

Deterministic check, no agent runs: is each task's `expectedFiles` entry returned with source?

- On the dev set 33 of 91 expected files were missing, in 19 of 36 tasks. The agent searched 0 to 2 times per 3 repetitions in most fully covered tasks and 3 to 21 times in the others.
- Ranking the repository by the task's terms in file bodies puts 15 of the 33 missing files in the top 3 and 22 in the top 10. File ranking used only paths, summaries and symbol names.

### Fix

| Commit | Change |
|---|---|
| `75a4e4c` | Leave the benchmark's diagnostic trace out of the response size limit |
| `a34e0db` | Credit files whose body carries the task's rare terms in file ranking |

Expected files returned with source, before (`f63d4e0`) and after:

| Set | Tasks | Expected files | Tasks fully covered | First target is an expected file |
|---|---|---|---|---|
| dev (3 repositories) | 36 | 58 → 70 of 91 | 17 → 23 | 10 → 23 |
| regression (6 repositories) | 70 | 110 → 130 of 167 | 37 → 46 | 30 → 41 |

The two parameters were chosen on both sets together, from five settings, so neither set is an unseen holdout for them. The mechanism was designed from the dev set only.

Per repository:

| Repository | Expected | Before | After |
|---|---|---|---|
| audit-orders | 30 | 20 | 24 |
| JetBook | 34 | 20 | 26 |
| Redmine-AI-agent | 27 | 18 | 20 |
| goodjobshare | 33 | 9 | 22 |
| jetchat-admin | 30 | 22 | 24 |
| kc002-ota | 28 | 23 | 26 |
| patentskill | 27 | 15 | 19 |
| nestmind | 30 | 22 | 20 |
| reefmori | 19 | 19 | 19 |

- Five tasks lost an expected file (2 dev, 3 regression); 25 gained at least one. nestmind is lower overall.
- Required semantic edges delivered on the dev set fell from 36 to 33 of 71 (candidate pool 58 → 70, seed-reachable 49 → 44). Two tasks gained edges and three lost them; in `impact-schema-check-decorator` the three edges are gone but all three expected files are now returned with source.
- Query time on JetBook rose from about 0.18 s to about 0.29 s.

The agent measurement for this change is in the next section.

## Full A/B of the branch (`6c4097d` vs `7f69090`)

- Same setup as the first A/B: Claude CLI, pull delivery, 3 repositories × 12 tasks × 3 repetitions, two `stellar` arms, no `baseline` arm.
- The `after` arm has every change in this document: symbol-bound ranges, the 20,000-byte budget, same-file declarations, the response size limit and body evidence.
- All 216 runs completed (exit 0). `changedDuringCampaign=false` in all six manifests. No run in either arm had its output saved to a file.

| Arm | Input tokens | Tool calls | Search calls | Model turns | Cost | Answer / grounded | Answered with no further inspection |
|---|---|---|---|---|---|---|---|
| before (`7f69090`) | 17.96M | 434 | 134 | 423 | $28.06 | 108 / 96 | 11 |
| after (`6c4097d`) | 15.39M | 332 | 93 | 361 | $24.86 | 108 / 97 | 38 |

Intervals are 95% bootstrap intervals over tasks. Positive means a reduction.

| Measure | After vs before | Tasks lower / higher |
|---|---|---|
| Input tokens | 14.3% [6.1%, 22.5%] | 24 / 12 |
| Tool calls | 23.5% [10.1%, 36.4%] | 22 / 6 |
| Search calls | 30.6% [9.5%, 49.0%] | 14 / 5 |
| Model turns | 14.7% [7.7%, 22.0%] | 22 / 4 |
| Cost | 11.4% [4.9%, 17.8%] | 24 / 12 |

| Repository | Input tokens | Tool calls | Search calls | Cost | Answered directly, before → after |
|---|---|---|---|---|---|
| audit-orders | 16.9% | 31.7% | 30.6% | 6.5% | 6 → 14 |
| JetBook | 12.4% | 21.0% | 30.8% | 26.5% | 4 → 12 |
| Redmine-AI-agent | 14.0% | 17.6% | 30.3% | 1.1% | 1 → 12 |

| Category | Input tokens | Tool calls | Search calls | Cost | Answered directly, before → after |
|---|---|---|---|---|---|
| navigation | 24.2% | 33.3% | 31.8% | 13.9% | 3 → 15 |
| impact | 14.6% | 19.5% | 36.8% | 5.0% | 8 → 15 |
| flow | 11.8% | 18.8% | 27.5% | 9.0% | 0 → 5 |
| editing-prep | 9.5% | 25.4% | 30.2% | 17.2% | 0 → 3 |

| After the context | Before: runs (mean input) | After: runs (mean input) |
|---|---|---|
| Answered directly | 11 (76K) | 38 (78K) |
| Read more, no search | 29 (126K) | 15 (145K) |
| Searched | 68 (198K) | 55 (186K) |

- Cache writes are level (1.74M → 1.75M tokens); cached input fell from 16.22M to 13.65M.
- 55 of 108 runs still search, and input rose in 12 of 36 tasks.

Limits:

- This is the dev set. All three repositories were used to design and tune these changes; it is not an unseen holdout.
- The two arms differ by the whole branch. This run does not separate the response size limit from body evidence.
- One agent (Claude CLI) and one delivery mode were measured.

Raw runs are under `validation/graphify/ab2-new/`, `ab2-old/`, `ab3-new/`, `ab3-old/`, `ab4-new/` and `ab4-old/` and are not committed.
