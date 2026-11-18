# v0.8.5 two-turn campaign: result

Plan: `PLAN.md` (pre-registered in `0a368dd`). Runtime `0a368dd` (main at `c8cbba6` plus the plan; source identical). serialwrap (5 tasks) and mac-kvm (6 tasks), conditions `baseline`, `hook-nohints`, `hook`, one repetition: 66 agent invocations.

## Validity

All 66 invocations exited 0. All 441 model events in the raw logs carry `claude-fable-5-2`. `changedDuringCampaign=false` in both campaigns. Every task has all six invocations. A smoke run of one task before the campaign is not counted.

## Turn 2 (the follow-up)

| | baseline | hook-nohints | hook |
|---|---|---|---|
| Cost, sum of 11 tasks | $6.24 | $5.51 | $5.75 |
| Follow-up success (answer and grounding) | 11 | 10 | 10 |
| Tool calls | 38 | 37 | 40 |
| Cache-write tokens | 81,274 | 82,600 | 88,343 |

Paired by task:

| Comparison | Median difference | Cheaper in | Sum |
|---|---|---|---|
| `hook` vs `hook-nohints` (the hints alone) | +$0.017 | 4 of 11 | +$0.24 (+4.4%) |
| `hook` vs `baseline` | −$0.046 | 8 of 11 | −$0.49 (−7.8%) |
| `hook-nohints` vs `baseline` | −$0.059 | 8 of 11 | −$0.73 (−11.7%) |

The conditions differ in turn 1 as well (the StellarCode condition and the first hook), and turn 2 carries turn 1's conversation, so `hook` and `hook-nohints` against `baseline` measure the whole path, not turn 2 alone. `hook` against `hook-nohints` is the clean comparison: both turn 1s ran the same configuration, and the conditions differ only in the second turn's hints.

## The hints

| | |
|---|---|
| Hints given | 37 in 8 of 11 follow-ups |
| In the follow-up's answer key | 2 (5%) |
| Read by the agent | 11, of which 10 were not in the answer key |

On the real-prompt set, 24% to 33% of hints were touched later in the session. Here 5% were the answer. Most hints were files linked to everything: the app's composition root (`MacKVMApplication.swift` in 3 of 6 mac-kvm follow-ups, `lib.rs` in 3 of 5 serialwrap ones), the runtime that wires services, and test files (6 of 37). The agent read 10 such files that did not answer the question. In the one task where a hint was the answer (`nav-reconnect-delay-schedule`, the fourth hint), the agent read a different hint and answered without it.

## Found: the strict gate passes vague follow-ups

In three serialwrap follow-ups, both hook conditions attached 6,000 to 9,400 characters of source (3 to 4 files) in turn 2, and the answer file was in none of them. The follow-ups name no code, but common words in them are file stems ("daemon", "device", "server", "request": `daemon.ts`, `device.rs`, `server.rs`, `request.rs` were attached): `namedInPrompt` takes a word that matches an attached file's stem as the prompt naming the code. Turn 1 shows the same in the smoke run.

## Reading (fixed in the plan)

`hook` against `hook-nohints`: cheaper in 4 of 11, median +$0.017, the same success. This is the "no consistent difference" row: hints are reached but not used to advantage, and one repetition cannot separate a small effect from noise. The hint figures point the same way: with 5% precision on these tasks, a hint is more often an extra read than a saved search.

Session-aware delivery and the hook path together (`hook-nohints` against `baseline`) cost 11.7% less over the follow-up, cheaper in 8 of 11, with one follow-up answered wrongly (`nav-reconnect-delay-schedule`, where both StellarCode conditions named `ReconnectManager.swift` alone and the key expects the recovery coordinator that drives it; baseline named both).

## Next, not done here

- Hints: leave out test files and files linked to most of the project (composition roots), then measure again on the real-prompt set; until then, whether hints stay on by default is open.
- Gate: a word that matches a file stem should count as naming code only if the stem is specific to the repository (not "server", "request", "mod", "lib").

## Limits

- One repetition, 11 tasks, two repositories, one model.
- The follow-ups were written to need a file next to turn 1's files, a favorable case for hints, and still the hints did not help.
- Answer keys are one person's reading of the code; `nav-reconnect-delay-schedule` is arguable.
