# v0.7 first-turn delivery on Rust / Kotlin / Swift: plan (pre-registered before any run)

## Question

In the v0.7 holdouts every `stellar` run spent its first model turn calling `stellar context` (144 of 144 runs, 36K input each, 18–24% of the condition's input). Does delivering the same context in the first turn (`prefetch`) remove that cost on these languages, without losing correctness?

## Setup

| | |
|---|---|
| Conditions | `pull` (the agent calls `stellar context`; the `stellar` condition of the holdouts) and `prefetch` (the harness runs the same command and puts the result in the first prompt), 3 repetitions, the runner's Latin-square order |
| Repositories and tasks | mac-kvm, serialwrap, vigorplus, motocam at the holdout commits, with their frozen task sets (hashes checked at campaign start). 12 tasks each, 288 runs. |
| Runtime | `f9aa63a` source, recorded per campaign, `src`/`bin`/`package.json` clean |
| Agent model | pinned to `claude-fable-5-2` and verified in the raw events after the run |

These task sets are no longer unseen: each has been run once (vigorplus twice). No query behavior was changed in response to them except the Kotlin same-package edges, which changed delivery by one file on motocam and none on vigorplus. Both conditions use the same runtime, so that history affects them equally.

## Estimate made before the run (from existing data)

Removing the first turn outright gives an upper bound; scaling by the v0.5.9 Stage 2 measurement (13.6–24.9% input reduction, prefetch versus pull, on three TS/JS/Python repositories) gives the expected range.

| Repo | Upper bound, prefetch vs pull | Expected range |
|---|---|---|
| mac-kvm | 23.6% | 13.6–24.9% |
| serialwrap | 19.5% | 13.6–24.9% |
| vigorplus | 18.0% | 13.6–24.9% |
| motocam | 19.3% | 13.6–24.9% |

## Pre-registered targets

| Target | Comparison |
|---|---|
| Correctness gate, per repository: answer and grounded success of `prefetch` ≥ `pull` | `prefetch` vs `pull` |
| Primary: input tokens, repo-median reduction ≥ 13.6% (the low end of the estimate) | `prefetch` vs `pull` |
| Secondary: every repository ≥ 10% | `prefetch` vs `pull` |

Also reported, without a threshold: `prefetch` against the holdout `baseline` of the same repository. That comparison is across campaigns, same pinned model, and is descriptive only (the first three baselines ran with the model unpinned; they were verified to be `claude-fable-5-2` except 11 of 688 events on vigorplus).

## Known harness limit

Source-read attribution does not expand shell globs or follow `cd` (v0.5.9 Stage 2). A grounding failure is checked against the raw events before it is counted as a regression; the raw count is reported either way.

## Not covered

`prefetch` exists only in the benchmark harness. This run measures whether the effect is there on these languages; it does not ship a delivery path.
