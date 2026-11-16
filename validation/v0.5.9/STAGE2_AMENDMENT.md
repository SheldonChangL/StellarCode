# v0.5.9 Stage 2 amendment (2026-11-04, before any Stage 2 run)

This amendment changes the criteria for Stage 2 only. It does not change anything already recorded:

- [EXPERIMENT_PLAN.md](EXPERIMENT_PLAN.md), its Stage 1 gates and the Stage 1 result ([V0.5.9_STAGE1.md](V0.5.9_STAGE1.md), [stage1/summary.json](stage1/summary.json)) are unchanged.
- Under the original pre-registered conjunction, Stage 1 remains **FIRST-TURN DELIVERY PARTIAL**. Stage 1 is not re-judged.

## Rationale

1. **Stage 1 `prefetch` met the efficiency and correctness targets.**
   - Repo-median input reduction: 26.58%.
   - Model-turn reduction: 26.56%.
   - Median model turns: −1.5.
   - Correctness: identical to pull (answer 100%, grounded success 91.67%).
2. **The duplicate-verification rate did not fall.** It was 25.0% for pull, 27.78% for prefetch and 30.56% for prefetch-contract.
3. **That rate is not a reasonable proxy for this experiment's token cost.** Duplicate bytes are a negligible share of delivered source: 1.88% for plain prefetch (2,371 of 126,210 B).
4. **The savings come from the round trip.** Stage 1 telemetry attributes them to removing the one model round trip pull spends to obtain the Stellar context:
   - Mean turns went from 4.36 to 3.22.
   - Turns with tool use after grounded context were essentially unchanged: 2.36 versus 2.22.

**Change.** Duplicate verification stays a **diagnostic metric**. It is **not** a Stage 2 acceptance gate.

## Stage 2 design

**Modes.** `pull` and `prefetch` only. `prefetch-contract` is dropped, because Stage 1 showed no additional benefit from it.

**Confirmatory task set.** The frozen v0.5.8 task sets, minus the Stage 1 deterministic subset. That is 8 tasks per repository, 24 in all. There is no re-selection, and prompts, categories, `expectedFiles` and `expectedMatch` are unchanged.

| Repo | Confirmatory tasks |
|---|---|
| kc002-ota | edit-firmware-semver-rejection, edit-spreadsheet-import-model-column, flow-kc003-firmware-key-wrapping, flow-user-reset-queues-alerts, impact-logout-revocation-list, impact-signup-confirmation-token-store, nav-inbox-pagination-cursor, nav-startup-schema-guard |
| goodjobshare | edit-explainer-article-updated-date, edit-salary-questionnaire-company-size, flow-google-signin-forbidden-to-alert, flow-ssr-prefetch-state-hydration, impact-query-search-term-selector, impact-rest-helper-calling-convention, nav-first-visit-content-access-grant, nav-interview-share-completeness-score |
| patentskill | audit-cli-show-key-version, persist-caller-source-ip-on-attempts, shared-deployment-credential-hmac-derivation, sliding-window-decision-shape-change, taiwan-family-walk-depth-bound, taiwan-patent-number-kind-classification, tipo-claim-text-ftps-fallback-chain, worker-thread-tool-invocation-signature-change |

*Disclosure:* `kc002-ota/nav-startup-schema-guard` was used once per mode in the pre-Stage-1 pipeline smoke run (`validation/v0.5.9/smoke`, repeat 1). That run validated the harness only; its result was not used for any decision. The set rule is "frozen set minus the Stage 1 subset", so the task stays in.

**Runs.** 24 tasks × 2 modes × 3 repetitions = **144 runs**. The order is deterministic and counterbalanced by repetition, and each row records it as `conditionOrder`:

| Repetition | Order |
|---|---|
| 1 | pull → prefetch |
| 2 | prefetch → pull |
| 3 | pull → prefetch |

**Runtime freeze.** The runtime and context semantics stay identical to Stage 1:

- No change to ranking, intent, confidence, context breadth, the indexer, the query service or the prefetch envelope semantics.
- After this amendment is committed, `src/`, `bin/` and `package.json` stay frozen. Every Stage 2 campaign must record the amendment commit as its runtime commit, with `dirty: false`.
- If the runtime changes during the campaign, the campaign is invalid.

## Stage 2 primary criteria (fixed now)

Each repository is evaluated **individually**, on the 24 confirmatory tasks only. All three repositories must pass, and neither a pooled result nor the repo median substitutes for the per-repository test.

| Criterion | Requirement |
|---|---|
| Answer correctness | prefetch ≥ pull |
| Grounded success | prefetch ≥ pull |
| Input-token reduction | ≥ 15% |
| Model-turn reduction | ≥ 15% |

**Correctness** is the rate over that repository's 24 runs per mode (8 tasks × 3 repetitions).

**Reduction** is the paired reduction `1 − Σ prefetch / Σ pull` over that repository's 24 paired runs, matched by task and repetition. This is the `byRepository.<repo>.vsPull.prefetch` statistic in the delivery report: `inputReductionPct` for input and `modelTurnReductionPct` for turns.

## Decision (fixed now)

| Outcome | Condition |
|---|---|
| **FIRST-TURN DELIVERY CONFIRMED** | All three repositories pass all four criteria. |
| **FIRST-TURN DELIVERY PARTIAL** | Correctness does not regress in any repository, but at least one repository has input reduction < 15% or model-turn reduction < 15%. |
| **FIRST-TURN DELIVERY REGRESSION** | Answer correctness or grounded success for prefetch is below pull in any repository. |

These thresholds will not be changed after results are seen.

## Diagnostics (reported; not gates)

- Duplicate-verification rate and duplicate bytes
- Context reuse
- Tool calls and search calls
- Turns after grounded context
- Prefetch local latency and payload bytes
- **Secondary analysis:** top-target stratification (top target correct versus wrong), with input and model-turn reduction for each stratum

## Combined descriptive report

A 36-task descriptive report, combining the 12 Stage 1 pilot tasks with the 24 confirmatory tasks, may be produced after Stage 2. It is descriptive only. The final Stage 2 decision uses only the 24 confirmatory tasks.

## `stellar preflight`

It is implemented only after **FIRST-TURN DELIVERY CONFIRMED**:

- a generic, agent-independent `stellar preflight <task>` with `--text` and `--json`
- no Claude-specific hook
