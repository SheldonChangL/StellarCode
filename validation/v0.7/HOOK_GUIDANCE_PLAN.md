# v0.8 hook guidance: plan (pre-registered before any run)

## Question

With the hook, agents searched 21.4% more than with `pull`, and cost did not fall (`HOOK_RESULT.md`). The hook carried a brief preamble and left the rest to the agent rule, which lacks the benchmarked instruction to answer at once when the evidence covers the task. Does carrying the full benchmarked guidance in the hook lower the extra searching and the cost?

## Conditions (one campaign per repository, same runtime)

| Condition | Hook preamble |
|---|---|
| `hook-brief` | the brief guidance measured in `HOOK_RESULT.md` (235 characters) |
| `hook` | the full benchmarked guidance (about 670 characters more, taken from the source budget) |

Everything else is identical: the real `stellar preflight --hook` through a `UserPromptSubmit` hook, the 9,800-character limit, the agent rule in the prompt.

## Setup

mac-kvm (Swift) and serialwrap (Rust): the two repositories where the hook kept least of the `prefetch` saving. Frozen task sets, 2 repetitions, 96 runs. Model pinned to `claude-fable-5-2` and verified in the raw events. A pair counts only if both runs exit 0 and both have `hookDelivered` true.

These task sets have been run many times; this is a development comparison, not an unseen holdout.

## Pre-registered targets (`hook` vs `hook-brief`, pooled over the two repositories)

| Target | Threshold |
|---|---|
| Search calls reduced | ≥ 15% |
| Cost reduced | > 0, with the paired-bootstrap 95% interval excluding zero |
| Input tokens not higher | reduction ≥ 0 |
| Correctness | answer and grounded success ≥ `hook-brief` on each repository |

## Reading fixed now

| Outcome | Decision |
|---|---|
| All four met | full guidance stays the default |
| Searches fall but cost does not | keep full guidance; the cost question is not answered by guidance |
| Searches do not fall | the guidance is not the cause; revert the default to brief (it leaves more room for source) |
