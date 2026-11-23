# v0.8.7 hook against baseline over two turns: plan (pre-registered before any run)

## Question

Does the product hook, as it ships since v0.8.7 (session hints off), lower what a two-turn conversation costs against an agent without StellarCode? The first campaign (`RESULT.md`, one repetition) found the hook path without hints (`hook-nohints`, now the product default) 11.7% cheaper than `baseline` in the follow-up, cheaper in 8 of 11 tasks. One repetition cannot separate that from noise: in the hint comparison, one repetition read 4 of 11 and +4.4%, four read 7 of 11 and −0.5% (`RESULT2.md`). This campaign decides whether the saving holds.

## Setup

| | |
|---|---|
| Repositories, tasks | as `PLAN.md`: serialwrap (5) and mac-kvm (6), the same frozen task sets (`TASKSET.sha256`) |
| Conditions | `baseline` (no StellarCode), `hook` (the product hook with its defaults: session-aware delivery, no hints) |
| Runs | 11 tasks × 2 conditions × 2 turns × 4 repetitions = 176 agent invocations |
| Agent model | pinned to `claude-fable-5-2`, verified in the raw events |
| Runtime | `main` at `cf6e69d` (v0.8.7) plus this plan, `src`/`bin`/`package.json` clean |
| Order | conditions alternate by repetition, so each runs first in 2 of 4 repetitions |
| Command | `MODEL=claude-fable-5-2 MODES=baseline,hook REPEAT=4 run.sh <repo> campaign3` |

The first campaign's numbers are not pooled with this one: one repetition, and an older runtime (hints on in `hook`, test files among them).

## Measures

Primary: the cost of both turns together, paired by task: for each task, the mean over four repetitions in each condition. Turn 1 and turn 2 differ between the conditions (turn 2 carries turn 1's conversation), so the conversation is the unit, not a turn.

Also reported:

- Turn 2 alone, by the same rule, against `RESULT.md`'s −11.7%; and turn 1 alone.
- Totals over all runs; success in each turn (answer and grounding, out of 44 per condition).
- Input, cache-write and cache-read tokens, model turns, tool and search calls.
- The hook's delivery: turns with source attached, characters attached.
- The same comparison by order (which condition ran first) and on repetition 1 alone, where no earlier run of the task is in the prompt cache (`../v0.7/DELIVERY_RESULT.md`, correction).
- Without `nav-reconnect-delay-schedule`, whose follow-up failed in every StellarCode run so far.

These are descriptive; only the primary measure and success enter the reading.

## Validity

Before reading any number: count non-zero exits per condition and turn, check the model in the raw events and `changedDuringCampaign=false`. A task counts only if all 16 of its invocations completed.

## Reading fixed now

| Outcome | Reading |
|---|---|
| `hook` cheaper in at least 8 of 11 tasks, total two-turn cost lower, and success in each turn at most 1 below `baseline` | the hook lowers what a two-turn conversation costs on these tasks |
| `hook` more expensive in at least 8 of 11 tasks and total cost higher, or success in either turn at least 3 below `baseline` | the hook costs more than it saves: find where before adding features |
| anything else | a saving is not shown: no cost claim for the hook; the measured claims stay at tokens and model turns (`../v0.7/HOOK_RESULT.md`) |

8 of 11 is the smallest count a coin would reach less than 12% of the time (one-sided sign test, p = 0.11), the same bar as `PLAN2.md`. If the repetition-1 comparison points the other way from the reading, the result says so; it does not change the reading.
