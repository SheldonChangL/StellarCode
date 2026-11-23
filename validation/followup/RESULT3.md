# v0.8.7 hook against baseline over two turns: result

Plan: `PLAN3.md` (pre-registered in `e8f8fc6`, which is also the runtime: `main` at `cf6e69d` plus the plan). serialwrap (5 tasks) and mac-kvm (6 tasks), conditions `baseline` and `hook` (v0.8.7 defaults: session hints off), four repetitions: 176 agent invocations.

## Validity

All 176 invocations exited 0; none skipped. All 1,206 model events in the raw logs carry `claude-fable-5-2`. `changedDuringCampaign=false` in both campaigns. Every task has all 16 invocations.

No `baseline` run used StellarCode: its MCP server list is empty, and no tool call names StellarCode once the benchmark's temporary checkout path (`stellar-bench-…`) is removed. That path is also why the harness's `stellarCalls` counts are not zero for `baseline`; they are not reported here.

## Two-turn cost (primary)

Per task, mean of four repetitions, both turns together:

| Task | `baseline` | `hook` | Difference |
|---|---|---|---|
| nav-scroll-wire-to-notches | $0.708 | $0.503 | −28.9% |
| nav-reconnect-delay-schedule | $0.607 | $0.474 | −22.0% |
| nav-own-injected-event-detection | $0.811 | $0.711 | −12.3% |
| flow-force-return-chord | $0.993 | $0.884 | −11.0% |
| edit-configurable-edge-dwell | $1.113 | $1.063 | −4.6% |
| edit-barrier-protocol-revision | $1.082 | $0.617 | −43.0% |
| local-socket-peer-process-lookup | $0.622 | $0.684 | +9.9% |
| lookback-window-shorthand-parsing | $0.782 | $0.806 | +3.1% |
| dns-rebinding-hostname-refusal | $0.560 | $0.702 | +25.3% |
| held-agent-send-times-out | $1.559 | $1.529 | −1.9% |
| add-mark-check-bit-scheme | $1.110 | $1.177 | +6.0% |

`hook` is cheaper in 7 of 11 tasks, median difference −$0.051. Total over all 88 conversations: $39.79 against $36.60 (−8.0%).

| | `baseline` | `hook` |
|---|---|---|
| Turn 1 success, of 44 | 44 | 44 |
| Turn 2 success, of 44 | 41 | 39 |

The turn-2 failures: `nav-reconnect-delay-schedule` in 3 `baseline` runs and all 4 `hook` runs (all seven named `ReconnectManager.swift` without the recovery coordinator the key expects; the `hook` runs had not read the coordinator in either turn), and one `hook` run of `edit-barrier-protocol-revision` that answered with the right file without reading it.

## By turn (descriptive)

| | Cheaper in | Total | Change |
|---|---|---|---|
| Turn 1 | 8 of 11 | $15.83 → $13.74 | −13.2% |
| Turn 2 | 6 of 11 | $23.96 → $22.86 | −4.6% |

| Totals, `baseline` → `hook` | Turn 1 | Turn 2 |
|---|---|---|
| Input tokens | 7.47M → 6.50M | 6.29M → 6.72M |
| Cache-write tokens | 762k → 656k | 295k → 345k |
| Tool calls | 239 → 170 | 151 → 155 |
| Search calls | 115 → 60 | 50 → 59 |
| Files read | 469 → 272 | 190 → 222 |
| `hook` turns with source attached | 12 of 44 | 12 of 44 |

The saving is in turn 1. In turn 2, the hook attached source in three serialwrap tasks (`local-socket-peer-process-lookup`, `dns-rebinding-hostname-refusal`, `add-mark-check-bit-scheme`): the vague follow-ups that pass the strict gate on common-word file stems (`RESULT.md`; the tried fix did not hold on the holdout, `../realprompt/HINT_PRECISION_RESULT.md`). Those three are three of the four tasks where `hook` costs more over the conversation, and turn 2 costs 9% to 34% more in each.

`RESULT.md`'s turn-2 figure (path without hints against `baseline`, one repetition: 8 of 11, −11.7%) is not reproduced: 6 of 11, −4.6%.

Other cuts of the primary measure: repetition 1 alone 6 of 11, −8.1%; `baseline` first (repetitions 1 and 3) 6 of 11, −8.2%; `hook` first (2 and 4) 7 of 11, −7.8%; without `nav-reconnect-delay-schedule` 6 of 10, −7.1%.

## Reading (fixed in the plan)

`hook` was cheaper in 7 of 11 tasks; the saving row needs 8. It was not more expensive in 8, and turn-2 success is 2 below `baseline` (the costs-more row needs 3). That is the "anything else" row: **a saving is not shown**. StellarCode makes no cost claim for the hook; the measured claims stay at tokens and model turns.

The direction is consistent (−8% in total, in every order and in repetition 1), but it does not hold in most tasks: cheaper in 7 of 11 here, and in 6 or 7 in every other cut. It comes from a few large differences (`edit-barrier-protocol-revision` −43%, `nav-scroll-wire-to-notches` −29%).

## Limits

- Four repetitions, 11 tasks, two repositories, one model.
- The follow-ups name no code and were written to need a file next to turn 1's files.
- Answer keys are one person's reading of the code; `nav-reconnect-delay-schedule` fails in nearly every run of every condition.
