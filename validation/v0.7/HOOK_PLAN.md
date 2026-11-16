# v0.8 hook delivery on Rust / Kotlin / Swift: plan (pre-registered before any run)

## Question

`prefetch` (context in the first prompt, built by the harness) lowered input by 20.9% against `pull` on these four repositories (`DELIVERY_RESULT.md`). The product path is different: a Claude Code `UserPromptSubmit` hook, capped at 10,000 characters, with a short preamble and the guidance in the agent rule. How much of the saving does the product path keep?

## Conditions

| Condition | What the agent gets |
|---|---|
| `pull` | The agent calls `stellar context` itself (unchanged) |
| `hook` | The Claude CLI runs the real `stellar preflight --hook` through a `UserPromptSubmit` hook passed with `--settings`. The prompt carries the task and the agent rule text (what a project has in `CLAUDE.md` after `stellar init --install-hook`), and no context. |

One harness adaptation: the benchmark prompt wraps the task in instructions, and a hook sees the whole prompt. A wrapper hands the product hook the task text alone, as a user's own message would be. Retrieval therefore uses the same query as `pull`.

Each `hook` run is checked afterwards in the CLI's own session transcript: `hookDelivered` is true only if a `UserPromptSubmit` attachment containing the context is there. Runs where it is false or unknown are reported and excluded from the paired comparison.

## Setup

| | |
|---|---|
| Repositories and tasks | mac-kvm, serialwrap, vigorplus, motocam at the holdout commits, frozen task sets (hashes checked at campaign start) |
| Repetitions | **2**, not 3: 192 runs. The account's 5-hour usage limit ended the last campaign at about 210 runs. |
| Order | two repositories at a time; the second pair starts after the first finishes |
| Runtime | this branch, recorded per campaign, `src`/`bin`/`package.json` clean |
| Agent model | pinned to `claude-fable-5-2`, verified in the raw events |
| Validity | a pair counts only if both runs exit 0; the count of failed runs is reported before any number is read |

These task sets have been run before (three times; vigorplus four). Both conditions share the runtime.

## Pre-registered targets (`hook` vs `pull`)

| Target | Threshold |
|---|---|
| Correctness gate, per repository: answer and grounded success of `hook` ≥ `pull` | no loss |
| Primary: input tokens, repo-median reduction | ≥ 10% |
| Delivery check: `hookDelivered` true | ≥ 95% of `hook` runs where the hook had something to attach |

The 10% line is half of the `prefetch` result: the hook attaches at most 9,800 characters where `prefetch` attached up to 20 KB of source, so a smaller effect is expected. Also reported without a threshold: the `hook` reduction next to the `prefetch` reduction of `DELIVERY_RESULT.md` per repository (across campaigns).

## Reading fixed now

| Outcome | Reading |
|---|---|
| Primary met and correctness held | the product path keeps a useful share of the saving; ship as is |
| Input reduction between 0 and 10% | the character cap or the short guidance costs most of the saving; look at which before shipping |
| Input not reduced, or a correctness loss | do not ship the hook as the default |
