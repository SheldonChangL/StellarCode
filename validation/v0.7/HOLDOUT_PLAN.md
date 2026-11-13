# v0.7 Rust / Kotlin / Swift lexical tier: unseen holdout plan (pre-registered before any holdout run)

## Question

Does the lexical tier for Rust, Kotlin and Swift (symbols, ranges and file dependencies; no semantic slice) reduce what an agent spends to answer repository questions, without losing correctness?

## Conditions

One campaign per repository: the same harness, frozen runtime commit, index snapshot and task order.

| Condition | What the agent gets |
|---|---|
| `baseline` | No StellarCode |
| `stellar` | The unchanged STELLAR prompt; the agent calls `stellar context` itself (pull delivery, no prefetch) |

The agent is the Claude CLI. Each condition runs 3 repetitions, in the runner's deterministic order.

## Repositories

Never used to develop or tune any query behavior. They were used during v0.7 development only to check that parsing is correct (symbol counts against `grep`, brace balance of ranges, import resolution) and for three ad-hoc smoke queries; no ranking or budget rule was changed in response.

| Repo | Target language | Files of that language | Commit |
|---|---|---|---|
| serialwrap | Rust | 77 | `fd1314c7f7c0edb183f94ba73911750883b3bd31` |
| vigorplus | Kotlin | 203 | `4628eb392914122d762de38a5c3ba44f30e58f10` |
| mac-kvm | Swift | 173 | `b80270e963e0685e7063d16ac28cee0861b5fbb1` |

Each is a clean detached clone at that commit under `~/Projects/Private/stellar-holdout-v07/`, indexed fresh by the frozen runtime.

## Tasks

12 per repository: 3 navigation, 3 flow, 3 impact, 3 editing-prep. Every expected file is of the target language. No `expectedSemanticEdges`: these languages have no semantic tier.

| Rule | Detail |
|---|---|
| Author | A fresh agent per repository, given only `AUTHORING.md` and the repository. Tools: `git`, `rg`, `sed`, `cat`, `ls`, `find`. Never runs `stellar`. |
| Reviewer | An independent agent per repository re-verifies every answer key against source and fixes or replaces bad tasks. |
| Lint | `stellar benchmark lint-tasks`, no errors |
| Freeze | `TASKSET.sha256` is written before the first run. |

## Runtime freeze

The runtime commit is recorded in `campaign.env` before the first run, with `src`, `bin` and `package.json` clean. A bad result is recorded, never tuned.

## Metrics

Reductions are paired by task and repetition: `1 − Σ stellar / Σ baseline` per repository. The **repo median** is the median of the three repositories' values. A pooled 95% interval comes from a paired bootstrap over tasks.

## Pre-registered targets

**Correctness gate, per repository:** answer success and grounded success of `stellar` ≥ `baseline`.

**Primary:** input tokens, repo-median reduction **≥ 10%**.

**Secondary:** tool calls repo-median reduction **≥ 15%**; search calls repo-median reduction **≥ 15%**; model turns and cost reported.

These thresholds are lower than v0.6's (20% input, 30% search) because there is no semantic slice. There is no prior measurement on these languages, so they are a stated expectation, not a calibrated one.

**Per-language reading (reported, no threshold):** each repository's own reductions. Swift links files only by type mentions and Kotlin has no same-package edges, so the three may differ.

## Catastrophic regressions (tracked separately)

Per task, on the task median over repetitions: input more than 25% worse than `baseline`, more than 2× the tool calls, or a correctness loss.

## Not covered

One repository per language, so a language effect cannot be separated from a repository effect. One agent (Claude CLI).
