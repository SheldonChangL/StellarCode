# v0.7 first-turn delivery on Rust / Kotlin / Swift: result

Plan: `DELIVERY_PLAN.md` (pre-registered in `abd6351`). Runtime source `f9aa63a`, `changedDuringCampaign=false` for all four campaigns. Model pinned to `claude-fable-5-2` and verified: every model event in the raw logs carries it (405, 428, 464 and 470 events).

## Correction (2026-11-16): the cost result is mostly a cache artifact

The cost numbers below (−17.3% pooled, −15.8% to −18.5% per repository) overstate what `prefetch` saves. Input tokens, model turns and tool calls are not affected.

- Cost is 75% cache writes. Fitting the reported cost of all runs to their token counts gives an exact fit: cache writes $16, output $40 and cache reads $0.2 per million tokens. In `pull`, cache writes are 75% of cost, output 17%, cache reads 8%.
- `prefetch` sends the task and the context as one long prompt, identical in every repetition. Repetition 2 ran within the one-hour cache lifetime of repetition 1, read that prompt from cache instead of writing it, and wrote 31% less than `pull`. The other conditions do not repeat a long prompt and gain far less this way.
- Split by repetition, `prefetch` against `pull`: repetition 1 cost −6.4% [2.3, 10.3] (48 tasks), repetition 2 cost −26.6% [22.3, 30.4]. Repetition 1 starts with no earlier run in cache, as real use does, where no prompt is sent twice. Per repository, repetition 1: mac-kvm −4.2%, serialwrap −9.5%, vigorplus −10.2%, motocam −0.4%.
- **Corrected reading: first-turn delivery lowers cost by about 6% [2.3, 10.3], not 17%.** Removing a turn removes cache reads, the cheapest tokens; the context itself is written once whether it is attached or fetched.

Benchmark runs now start their prompt with a unique line so that runs cannot share a prompt cache (`isolatedPrompt` in `src/benchmark/agents.js`; rows carry `runId`).

## Deviation from the plan: 104 of 144 pairs are valid

The account's 5-hour usage limit was reached during the campaigns. 79 of 288 runs ended at once with the CLI message "You've hit your 5-hour limit", zero tokens, non-zero exit. All but two are in repetition 3.

A pair is used only if both of its runs completed. Nothing was selected by outcome: the cut is by time. Repetitions 1 and 2 are complete for every task except one vigorplus pair.

| Repo | Valid pairs | Repetition 1 / 2 / 3 | Tasks covered |
|---|---|---|---|
| mac-kvm | 28 of 36 | 12 / 12 / 4 | 12 of 12 |
| serialwrap | 26 of 36 | 12 / 12 / 2 | 12 of 12 |
| vigorplus | 23 of 36 | 12 / 11 / 0 | 12 of 12 |
| motocam | 27 of 36 | 12 / 12 / 3 | 12 of 12 |

The missing runs were not re-run.

## Verdict against the pre-registered targets (`prefetch` vs `pull`)

| Target | Result | Verdict |
|---|---|---|
| Correctness gate per repository: answer and grounded success ≥ `pull` | 28→28, 26→26, 22→23, 27→27 (both measures) | met |
| Primary: input tokens, repo-median reduction ≥ 13.6% | 21.8% | met |
| Secondary: every repository ≥ 10% | lowest 13.5% (vigorplus) | met |

## Per repository (valid pairs)

| | mac-kvm (Swift) | serialwrap (Rust) | vigorplus (Kotlin) | motocam (Kotlin) |
|---|---|---|---|---|
| Input tokens | −27.0% | −26.8% | −13.5% | −16.9% |
| Model turns | −29.3% | −28.8% | −14.4% | −19.6% |
| Tool calls | −14.9% | −15.6% | −1.4% | −15.0% |
| Search calls | +8.8% | −2.5% | +17.0% | +16.3% |
| Cost | −15.8% | −17.6% | −17.2% | −18.5% |
| `prefetch` runs with no tool call at all | 6 of 28 | 0 of 26 | 0 of 23 | 3 of 27 |
| `prefetch` runs that still call `stellar` | 19 of 28 | 17 of 26 | 14 of 23 | 15 of 27 |
| Tasks where `prefetch` costs more input (task median) | 0 of 12 | 0 of 12 | 2 of 12 | 4 of 12 |

Pooled over the 48 tasks (paired bootstrap over tasks, 95%): input −20.9% [16.5, 25.0], model turns −22.9% [18.7, 26.9], tool calls −11.6% [4.6, 18.3], cost −17.3% [14.9, 19.9] ($40.61 → $33.57), search calls +10.4% [−2.9, +25.2].

The estimate made before the run was 13.6–24.9% per repository; three repositories fall inside it and vigorplus is at its lower edge (13.5%).

## Against the holdout baseline (descriptive, across campaigns)

Mean input per run. The `pull` condition of this run reproduces the holdout's `stellar` condition within 4% on every repository, which supports comparing across the two campaigns.

| Repo | Holdout `baseline` | Holdout `stellar` (pull) | This run `pull` | This run `prefetch` | `prefetch` vs `baseline` |
|---|---|---|---|---|---|
| mac-kvm | 199K | 153K | 148K | 108K | −45.6% |
| serialwrap | 201K | 186K | 189K | 139K | −30.9% |
| vigorplus | 205K | 201K | 209K | 181K | −12.0% |
| motocam | 175K | 187K | 181K | 150K | −14.3% |

motocam, where `pull` cost more than no StellarCode at all (+6.8%), is below the baseline with `prefetch`.

## Reading

- The first-turn cost was the main reason the lexical tier did not lower input on Rust and Kotlin. With the same context delivered in the first prompt, all four repositories are below their baseline.
- The saving is one model turn, not less exploration: search calls do not fall and rise on three repositories, and more than half of the `prefetch` runs still call `stellar` afterwards.
- The two Kotlin repositories gain least and hold all six tasks where `prefetch` costs more. They are also the two where the context delivers the fewest expected files.

## Limits

- 104 of 144 pairs; repetition 3 is mostly missing.
- The four task sets had been run before this campaign. Both conditions share the runtime, so this affects them equally.
- `prefetch` exists only in the benchmark harness. No delivery path ships it.
- The four campaigns ran concurrently on one machine.

Raw runs: `validation/v0.7/delivery/<repo>/claude-20261113-*/` (not committed).
