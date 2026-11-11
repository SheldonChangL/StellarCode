# StellarCode v0.5.9 first-turn context delivery experiment (written before any delivery run)

## Question

StellarCode already cuts search calls. Why does input not fall with them?

In v0.5.8:

- Searches fell 37% at the repo median, but input fell only 6.5%.
- Estimated model turns fell only 8% (9.50 → 8.78 per run).
- Each model turn re-reads the cached context, about 35–40K tokens.

**Hypothesis:** delivering grounded source before the first model turn removes model turns, and saves more input than shrinking the payload would.

## Design

This is a causal experiment on delivery, not a generalization claim.

- Runtime: the v0.5.7 runtime `7691bbc`, on branch `exp/v0.5.9-first-turn-context`.
- Ranking, scoring, confidence, intent, breadth, evidence and indexing are unchanged. The frozen runtime trees (`src/query`, `src/indexer`, `src/core`, `src/storage`, `src/mcp`, `src/platform`, `src/web`) have zero diff from `7691bbc`. Only the benchmark harness changes.
- The v0.5.8 code (`657b621`) is not used.

| Condition | Delivery |
|---|---|
| `pull` | The existing STELLAR condition, byte-identical prompt to v0.5.7. The agent's first action is `stellar context …`. |
| `prefetch` | Before the agent starts, the runner runs the exact same `stellar context` command (task prompt only, same frozen index snapshot). The result goes into the initial message as a `<stellar-grounded-context>` envelope. The instructions equal pull's, except that the first-action sentence becomes "the output of that command is already attached; do not run it again". |
| `prefetch-contract` | The same as `prefetch`, plus an explicit grounding contract. Supplied excerpts are live source; do not re-read the same path and range merely to verify; inspect more source when it is missing or insufficient; hints are not inspected source. It never forbids inspection. |

Prefetch input comes only from the task prompt, the repository index and source, and the StellarCode runtime. Tests assert that category, expected files, match mode and answer-key data never reach the prompt.

**Grounding.** Delivered excerpts count as inspected source only where they match the working tree verbatim. This is the same check a pull-mode `stellar context` result gets. Related hints never count as grounding.

**Repositories and tasks.** The already-exposed v0.5.8 holdouts are used as frozen task sets. They are restored byte-identically from `f93a541`:

| Repo | sha256 |
|---|---|
| kc002-ota | `abff601f…` |
| goodjobshare | `b419cc7c…` |
| patentskill | `ebf6d691…` |

Each repository runs in the clean detached worktree from v0.5.8, at the same commit.

## Stage 1 (diagnostic subset, fixed before any delivery result)

**Selection rule.** For each repository and each category, take the lexicographically lowest task id (12 tasks).

| Repo | navigation | flow | impact | editing-prep |
|---|---|---|---|---|
| kc002-ota | nav-fixed-window-request-throttle | flow-admin-delete-revokes-mobile-jwt | impact-fcm-registration-store | edit-android-alert-channel |
| goodjobshare | nav-company-rating-structured-data | flow-card-checkout-to-3ds-redirect | impact-countdown-hook-signature | edit-add-success-toast-severity |
| patentskill | audit-looked-up-case-phrase | http-caller-identity-to-attempt-json | provider-override-resolver-signature-change | add-basis-to-per-provider-capability-declaration |

The patentskill editing task is the known v0.5.8 answer-key defect: its JSON schema file was never read by any run in either condition. The rule selects it, so it stays in. It is expected to fail grounding in every mode, and correctness is compared between modes.

**Run.** Claude, conditions `pull`, `prefetch` and `prefetch-contract`, repeat 3. That is 12 × 3 × 3 = 108 runs. Order is a deterministic Latin square by repetition:

| Repetition | Order |
|---|---|
| 1 | pull, prefetch, prefetch-contract |
| 2 | prefetch, prefetch-contract, pull |
| 3 | prefetch-contract, pull, prefetch |

There is no baseline condition in Stage 1.

### Stage 1 criteria (fixed now)

**Correctness.** For both prefetch modes, answer correctness and grounded success must be at least pull's.

**Primary delivery target.** The best first-turn mode, versus pull, must reach:

- input reduction ≥ 15% (repo median of paired reductions)
- **and** either model-turn reduction ≥ 15%, or median model turns at least 1.0 lower
- **and** a materially lower duplicate-verification rate

Exploratory (not a gate): for `prefetch-contract`, duplicate-read bytes ≤ 25% of delivered source bytes.

**Early stop.** If neither prefetch mode reaches ≥ 10% input reduction versus pull while preserving correctness, the experiment stops with **FIRST-TURN DELIVERY NOT SUFFICIENT**. There is then no Stage 2 and no production integration, and the analysis turns to why the agent still spends turns.

**Best mode.** The best first-turn mode is the one with the larger repo-median input reduction among the modes that pass correctness.

## Stage 2 (only if Stage 1 meets the primary target)

- All 36 tasks, `pull` versus the best first-turn mode, repeat 3: 216 runs, in Latin-square order.
- Target: input ≥ 15% lower, model turns ≥ 15% lower and correctness ≥ pull. Report per repository, with the repo median as primary.

## Instrumentation (definitions)

| Metric | Definition |
|---|---|
| `modelTurns` | One per distinct assistant `message.id` in Claude's stream (one provider call). Cross-checked against `result.num_turns`. |
| Per-turn input | That call's `input + cache_read + cache_creation` tokens. Summed over turns, it equals the run's reported input. |
| `initialTurnInputTokens`, `subsequentTurnInputTokens` | The first turn's per-turn input, and the sum over the remaining turns. Missing telemetry is null, never estimated. |
| `turnsAfterGroundedContextAvailable` | Model turns that still call a tool after the delivered context is visible: after turn 0 for prefetch, after the turn that issued `stellar context` for pull. |
| `turnsBeforeFirstRelevantSource`, `turnsAfterFirstRelevantSource` | Turn index at which an expected file's source first arrived (0 when delivered before turn 1), and the turns after it. Computed after the run. |
| `duplicateReadFiles`, `duplicateReadRanges`, `duplicateReadBytes`, `duplicateReadPct` | Later reads that overlap delivered line ranges. Partial overlaps count their overlapping line share. |
| `prefetchVerificationRate` | Runs with at least one duplicate range, divided by runs with delivered context. |
| `solvedWithoutAdditionalRepoInspection` | No tool call after the context became visible. |
| `verificationClass` | Mechanical: **A** no post-context tool call; **C** re-read delivered source; **D** two or more post-context searches; **B** otherwise (read missing source). |
| `contextReuseRate` | Delivered bytes of cited files not re-read, over delivered bytes of cited files. File-level; null when not measurable. |
| `prefetchLocalMs`, `prefetchSourceBytes`, `prefetchPayloadBytes` | Cost of the prefetch itself. Delivered tokens are part of the model's input and stay in every token total. |
| Top-target stratification | The context's first target compared with `expectedFiles` after the run. |

Raw JSONL, per-run diagnostics, envelopes and logs stay local. Repository remote URLs are removed from committed files.
