# v0.8.6 hint campaign: result

Plan: `PLAN2.md` (pre-registered in `6fc8588`). Runtime `6fc8588` (main at `4ad8957` plus the plan; source identical). serialwrap (5 tasks) and mac-kvm (6 tasks), conditions `hook-nohints` and `hook`, four repetitions: 176 agent invocations.

## Validity

All 176 invocations exited 0; none skipped. All 1,142 model events in the raw logs carry `claude-fable-5-2`. `changedDuringCampaign=false` in both campaigns. Every task has all 16 invocations.

## Turn 2 (the follow-up)

Per task, mean of four repetitions:

| Task | `hook-nohints` | `hook` | Difference | Success (nohints / hook) |
|---|---|---|---|---|
| nav-scroll-wire-to-notches | $0.318 | $0.312 | −$0.007 | 4 / 4 |
| nav-reconnect-delay-schedule | $0.276 | $0.320 | +$0.044 | 0 / 0 |
| nav-own-injected-event-detection | $0.518 | $0.453 | −$0.065 | 4 / 4 |
| flow-force-return-chord | $0.568 | $0.486 | −$0.081 | 4 / 4 |
| edit-configurable-edge-dwell | $0.648 | $0.644 | −$0.003 | 4 / 4 |
| edit-barrier-protocol-revision | $0.353 | $0.457 | +$0.104 | 2 / 4 |
| local-socket-peer-process-lookup | $0.449 | $0.431 | −$0.017 | 4 / 4 |
| lookback-window-shorthand-parsing | $0.580 | $0.587 | +$0.006 | 4 / 4 |
| dns-rebinding-hostname-refusal | $0.434 | $0.410 | −$0.024 | 4 / 4 |
| held-agent-send-times-out | $0.797 | $0.831 | +$0.034 | 4 / 4 |
| add-mark-check-bit-scheme | $0.750 | $0.734 | −$0.017 | 4 / 4 |

| | `hook-nohints` | `hook` |
|---|---|---|
| Cost, all 44 follow-ups | $22.76 | $22.66 (−0.5%) |
| Follow-up success, of 44 | 38 | 40 |
| Tool calls | 145 | 150 |
| Characters attached by the hook | 94,740 | 105,344 |

`hook` is cheaper in 7 of 11 tasks, median difference −$0.007. By order: with `hook-nohints` first (repetitions 1 and 3) $11.35 against $11.34; with `hook` first (2 and 4) $11.41 against $11.32. Turn 1 (the same configuration in both) cost $13.76 and $13.40.

The two extra successes are both in `edit-barrier-protocol-revision`: in two `hook-nohints` runs the agent named the expected file without reading it, so the answer was not grounded. One of the four `hook` runs read that file as a hint.

## The hints

| | |
|---|---|
| Hints given | 131 in 33 of 44 follow-ups; no test files (v0.8.6) |
| In the follow-up's answer key | 14 (11%; 5% in the first campaign) |
| Read by the agent | 42, of which 12 were in the answer key |

Most hints are still files linked to everything: `lib.rs` (12), `backend.rs` (12), `mod.rs` (11), `port.rs` (8), `MacKVMApplication.swift` (8). Hints in the answer key came from five tasks (`lookback-window-shorthand-parsing`, `edit-configurable-edge-dwell`, `nav-own-injected-event-detection`, `nav-reconnect-delay-schedule`, `edit-barrier-protocol-revision`), and the agent read 12 of those 14. In the other six, no hint was the answer.

## Reading (fixed in the plan)

`hook` was cheaper in 7 of 11 tasks; the plan needs 8 for hints to stay on. That is the "anything else" row: **hints do not show a benefit, so they go off by default**, with `--session-hints on` to turn them on. The totals agree: turn-2 cost −0.5%, inside run-to-run noise, for 11% more attached characters.

What the hints do show: when a hint is the answer the agent reads it, and success was not lower with hints (40 against 38). They do not lower what the agent spends, because the reads they add elsewhere (30 of 42 not the answer) cost what the right ones save.

## Limits

- Four repetitions, 11 tasks, two repositories, one model.
- The follow-ups were written to need a file next to turn 1's files, a favorable case for hints.
- Answer keys are one person's reading of the code; `nav-reconnect-delay-schedule` failed in every run of both conditions, as in the first campaign.
