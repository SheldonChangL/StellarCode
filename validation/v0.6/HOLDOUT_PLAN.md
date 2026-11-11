# v0.6 semantic behavior graph: unseen holdout plan (pre-registered before any holdout run)

## Question

Does a semantic behavior slice reduce the repository exploration an agent still performs after the Stellar context arrives, without losing correctness?

Delivery is held constant (pull: the agent calls `stellar context` itself). First-turn prefetch is **not** used, so the semantic effect is not confounded with the v0.5.9 delivery effect.

## Comparison architecture (fixed now)

All three conditions run in **one** campaign per repository: the same harness, the same frozen runtime commit, the same index snapshot and the same task order. This avoids cross-runtime contamination.

| Condition | What the agent gets |
|---|---|
| `baseline` | No StellarCode |
| `stellar-lexical` | The v0.5.6-style Stellar context: the same runtime, index, targets, prompt and command as `stellar`, with the semantic slice switched off (`STELLAR_SEMANTIC_SLICE=0`, set inside the stellar shim). Related evidence comes from the v0.5.6 lexical and import heuristics. |
| `stellar` | The v0.6 context: identical, plus the semantic slice (`semanticEvidence`; semantic neighbors grounded in `relatedEvidence`) |

`stellar-lexical` is not byte-identical to the released v0.5.6. The v0.6 index also resolves `export … from`, maps `./x.js` to `x.ts`, and adds interface, class-property and object-literal member symbols. Both Stellar conditions share those index changes, so the `stellar` versus `stellar-lexical` difference isolates the slice.

**Agent and order.** The agent is the Claude CLI. Each condition runs 3 repetitions, ordered by a deterministic Latin square on the repetition:

| Repetition | Order |
|---|---|
| 1 | baseline, stellar-lexical, stellar |
| 2 | stellar-lexical, stellar, baseline |
| 3 | stellar, baseline, stellar-lexical |

**Prompt.** The agent prompt for both Stellar conditions is the unchanged v0.5.6 STELLAR prompt (`benchmarkPrompt`). There are no new instructions.

## Repositories (never used in v0.5.6–v0.5.9 or v0.6 development)

| Repo | Stack | Expected semantic capability |
|---|---|---|
| audit-orders | TypeScript backend service | `semantic` |
| JetBook | TypeScript full-stack application | `semantic` |
| Redmine-AI-agent | Python service (backend) plus a small TS/JS extension | `semantic-partial` (Python) |

Each repository is used as a clean detached worktree at a fixed commit under `~/Projects/Private/stellar-holdout-v06/`, with a fresh index built by the frozen runtime.

## Tasks

Each repository gets 12 tasks: 3 navigation, 3 flow, 3 impact and 3 editing-prep.

- At least 6 of the 12 carry `expectedSemanticEdges` (`{from:"path#Symbol", relation:"CALLS|IMPLEMENTS|REGISTERS|CONSUMES", to:"path#Symbol"}`). These are only for chains that are objectively verifiable in source: a literal call, an explicit `implements`, a literal registration argument, or a literal non-call use.
- `Symbol` is the declaring class or object plus the member (`Class.method`), or the bare top-level name. A module-level registration uses `path` alone.

**Authoring integrity:**

| Rule | Detail |
|---|---|
| Author | A fresh author agent per repository that has not seen StellarCode's v0.6 code or output. It uses `git`, `rg`, `sed` and `cat` only, and never runs `stellar`. |
| Reviewer | An independent reviewer agent per repository re-verifies every `expectedFiles` and `expectedSemanticEdges` entry against source, and rejects or fixes subjective or wrong items. |
| Lint | `stellar benchmark lint-tasks` |
| Freeze | The task set's sha256 is frozen before the first run. |

## Runtime freeze

The runtime commit is recorded before the first holdout campaign, with `runtimeDirty=false`. The runner aborts and invalidates the campaign if the runtime fingerprint changes. A bad result is recorded, never tuned.

## Metrics

Reductions are paired by task and repetition: `1 − Σ condition / Σ comparison` per repository. The **repo median** is the median of the three repositories' values.

| Metric | Definition |
|---|---|
| `postContextExplorationTurns` | Model turns, after the turn that issued `stellar context`, that still call a tool (v0.5.9 per-turn telemetry; missing is n/a) |
| Correctness | Answer success and grounded success (expected files read from source) |
| Cost | Provider input tokens, search calls, tool calls, unique source bytes read, and Stellar initial source bytes (`contextSourceBytes`) |
| Required semantic-edge recall | For annotated tasks, the share of `expectedSemanticEdges` present in the context's `semanticEvidence`. This is end to end, including target selection. Index-level recall is reported alongside. It is computed deterministically by `stellar benchmark semantic-slice` on the frozen runtime and index. |

## Pre-registered targets (fixed now)

**Primary: semantic effect**

| Target | Comparison |
|---|---|
| `postContextExplorationTurns` repo-median reduction **≥ 40%** | `stellar` vs `stellar-lexical` |

**Correctness gate: per repository, no correctness regression accepted**

| Target | Comparison |
|---|---|
| Answer success ≥ baseline | `stellar` vs `baseline` |
| Grounded success ≥ baseline | `stellar` vs `baseline` |

**Semantic recall**

| Target | Scope |
|---|---|
| Required semantic-edge recall **≥ 90%** | Annotated tasks |

Pre-declared architecture limitations, excluded from the recall denominator and listed:
- edges whose resolution needs dynamic dispatch, a DI container, CommonJS `module.exports` members, or an untyped receiver without assignment evidence
- interface dispatch to a concrete implementation (only the contract edge is supported)

Every excluded edge is listed with its reason.

**Secondary (product-level, versus `baseline`)**

| Target | Comparison |
|---|---|
| Input tokens repo-median reduction **≥ 20%** | `stellar` vs `baseline` |
| Search calls repo-median reduction **≥ 30%** | `stellar` vs `baseline` |

Both are also reported for `stellar` vs `stellar-lexical`.

## Catastrophic regressions (tracked separately)

- **Standard**, `stellar` vs `baseline` per task (task-median over repetitions): input more than 25% worse, more than 2× the tool calls, or a correctness loss.
- **Semantic catastrophe:** a high-confidence semantic edge in a returned slice that is false in source, *and* the agent then grounds or cites the wrong behavior through it. All returned high-confidence edges on the holdout tasks are audited against source by an independent reviewer. False edges are listed even when they did not cause a wrong answer.

## Decision (exactly one)

| Decision | Condition |
|---|---|
| **SEMANTIC GRAPH CONFIRMED** | The correctness gate passes in all repositories, **and** the primary target passes (repo-median reduction ≥ 40%), **and** required-edge recall is ≥ 90%, **and** no high-confidence false edge repeats across repositories. |
| **SEMANTIC GRAPH REGRESSION** | Any of: correctness below baseline in any repository, attributable to the slice (stellar < baseline while stellar-lexical ≥ baseline on the same tasks); post-context exploration *increases* versus `stellar-lexical` at the repo median; or a high-confidence false relation repeats across repositories. |
| **SEMANTIC GRAPH PARTIAL** | Otherwise: correctness holds, but the exploration reduction is below 40% or recall is below 90%. Per-language capability is reported. |

The input target is reported but does not decide the semantic graph result alone.

Optional Phase 2 (semantic pull versus semantic first-turn delivery) runs only after **CONFIRMED**.

## Frozen inputs (recorded before the first holdout run)

**Runtime.** `db5af25` (`feat: build bounded semantic behavior slices`), with `src/`, `bin/` and `package.json` clean. The package version stays 0.5.6.

**Task sets and repository commits:**

| Repo | Task-set sha256 | Repository commit |
|---|---|---|
| audit-orders | `1d0b98c3…547cd0` | `e47d84c` |
| JetBook | `bdde5bbf…40c27e` | `371b82e` |
| Redmine-AI-agent | `4ed1ae56…6d1d55` | `5189f6b` |

**Annotated tasks.**

| Repo | Tasks with `expectedSemanticEdges` | Required edges |
|---|---|---|
| audit-orders | 8 of 12 | 16 |
| JetBook | 9 of 12 | 26 |
| Redmine-AI-agent | 11 of 12 | 32 |

**Review.** Independent review results:

| Repo | ok | fixed | replaced |
|---|---|---|---|
| audit-orders | 9 | 3 | 0 |
| JetBook | 4 | 8 | 0 |
| Redmine-AI-agent | 4 | 8 | 0 |

The per-task notes are in each `REVIEW.md`.

**Lint.** All three sets pass. JetBook has three warnings because its prompts contain the word "page", the stem of `src/actions/page.ts`. "Page" is the product's domain noun (a wiki page), so the warnings were accepted.

**Pipeline smoke test.** One exposed development task (kc002-ota `flow-kc003-firmware-key-wrapping`) ran under all three conditions to check the pipeline. It is not evidence.

**Run script.** `validation/v0.6/run-holdout.sh <repo> holdout baseline,stellar-lexical,stellar 3`
