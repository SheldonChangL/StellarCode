# v0.8.5 two-turn campaign: plan (pre-registered before any run)

## Question

In the second turn of a conversation, do session-aware delivery and session hints change what the agent spends? The real-prompt set says hints reach a file the turn needs in about a quarter of follow-ups (`../realprompt/DEPENDENCY_HINTS_RESULT.md`); it cannot say whether an agent uses them.

## Setup

| | |
|---|---|
| Repositories | serialwrap (Rust, 5 tasks), mac-kvm (Swift, 6 tasks), at the v0.7 holdout commits |
| Tasks | `tasksets/<repo>/tasks.json`: a subset of the v0.7 task sets, each with a follow-up, frozen by `TASKSET.sha256` |
| Conditions | `baseline`, `hook-nohints`, `hook` (`README.md`) |
| Runs | 11 tasks × 3 conditions × 2 turns = 66 agent invocations, one repetition |
| Agent model | pinned to `claude-fable-5-2` (as the v0.7 hook campaigns), verified in the raw events |
| Runtime | `main` at the commit that merged the harness, recorded per campaign, `src`/`bin`/`package.json` clean |
| Order | Latin square over conditions; one repository at a time |

The follow-ups are short and name no code ("Where is that check hooked into the server so it runs on every request?"). Their answer keys were found with grep and by reading source, without running StellarCode. Every follow-up asks for a file next to the turn-1 files (a caller, a configuration source, the next step of a flow): the kind of follow-up hints are built for, so this is a favorable case for them, not a sample of real follow-ups.

## Measures (turn 2)

Primary: turn-2 cost, `hook` against `hook-nohints` (the hints alone), then `hook` against `baseline`. Paired by task; one repetition, so differences are read per task and as a median, with no significance claim.

Also reported: turn-2 input and cache-write tokens, model turns, tool and search calls, files read, rereads of turn-1 files, follow-up answer and grounding success, and for `hook`: hints given, `hintsExpected` (a hint is in the answer key), `hintsRead` (the agent read a hint).

## Validity

Before reading any number: count non-zero exits per condition and turn, check the model in the raw events and `changedDuringCampaign=false`. A task counts only if all six of its invocations completed.

## Reading fixed now

| Outcome | Reading |
|---|---|
| `hook` turn 2 cheaper than `hook-nohints` in most tasks, no loss in follow-up success | hints help an agent; keep them on |
| No consistent difference | hints are reached but not used, or the saving is below the noise of one repetition; a larger campaign decides whether they stay |
| `hook` more expensive or less correct | hints cost more than they save; switch them off by default |

Turn 1 is not a measure here: its conditions differ only by the hook, already measured in `../v0.7/HOOK_RESULT.md`.
