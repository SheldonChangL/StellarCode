# v0.8.6 hint campaign: plan (pre-registered before any run)

## Question

Do session hints lower what an agent spends in a follow-up turn? The first campaign (`RESULT.md`, one repetition) fell in the "no consistent difference" row: `hook` was cheaper than `hook-nohints` in 4 of 11 tasks, +4.4% in total. That row says a larger campaign decides whether hints stay on by default. This is that campaign, and its reading is binary.

## Setup

| | |
|---|---|
| Repositories, tasks | as `PLAN.md`: serialwrap (5) and mac-kvm (6), the same frozen task sets (`TASKSET.sha256`) |
| Conditions | `hook-nohints`, `hook` (baseline is not rerun; it does not bear on the hints) |
| Runs | 11 tasks × 2 conditions × 2 turns × 4 repetitions = 176 agent invocations |
| Agent model | pinned to `claude-fable-5-2`, verified in the raw events |
| Runtime | `main` at `4ad8957` (v0.8.6: hints leave out test files), `src`/`bin`/`package.json` clean |
| Order | conditions alternate by repetition, so each runs first in 2 of 4 repetitions |
| Command | `MODEL=claude-fable-5-2 MODES=hook-nohints,hook REPEAT=4 run.sh <repo> campaign2` |

The first campaign's numbers are not pooled with this one: its runtime still gave test files as hints.

## Measure

Turn-2 cost, paired by task: for each task, the mean over four repetitions in each condition. Also reported: the total over all runs, follow-up success (answer and grounding, out of 44 per condition), hints given, `hintsExpected`, `hintsRead`, and the same comparison by order (which condition ran first).

## Validity

Before reading any number: count non-zero exits per condition and turn, check the model in the raw events and `changedDuringCampaign=false`. A task counts only if all 16 of its invocations completed.

## Reading fixed now

| Outcome | Decision |
|---|---|
| `hook` cheaper in at least 8 of 11 tasks, total turn-2 cost lower, and follow-up success at most 1 below `hook-nohints` | hints help an agent: they stay on by default |
| anything else | hints do not show a benefit: switch them off by default (`--session-hints on` keeps them available) |

8 of 11 is the smallest count a coin would reach less than 12% of the time (one-sided sign test, p = 0.11). The bar is set for a default that costs every follow-up turn: without a clear benefit, hints go off.
