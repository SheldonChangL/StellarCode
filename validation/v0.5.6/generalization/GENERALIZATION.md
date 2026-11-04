# StellarCode v0.5.6 — Cross-repository generalization

Runtime under test: frozen v0.5.5 runtime (`package.json` 0.5.5) at commit `6c9eb49`, content hash
`85f9675e…2485095`, `runtimeDirty=false` and `changedDuringCampaign=false` in every campaign manifest.
Frozen trees (src/query, indexer, mcp, core, storage, platform, web) are byte-identical to v0.5.5 (`50dbe73`).

Machine-readable output: `summary.json` (Claude-only, 3 valid campaigns) and `summary.html`.
Per-campaign reports: `../holdout/<repo>/claude-*/report.json`.

## Executive summary

- **Decision: PARTIAL GENERALIZATION (Claude only).** This is the mechanical `suggestedDecision`, with the rules fixed before any results.
  - The decision is driven by two misses: repo-median input reduction is 13.96%, below the 20% directional target, and 1 of 3 repos is below 100% grounded correctness.
- The direction of the effect generalizes:
  - All 3 repos show lower input, tool calls, search calls and source bytes.
  - Search reduction meets the *strong* target (50% or more) in 3/3 repos.
  - Stellar grounded success is equal to or higher than baseline in every repo.
- The size of the effect does not generalize. Reefmori (the tuning repo) reduces input by 43.6%; the two holdouts reduce it by 14.0% and 10.8%.
- 2 catastrophic regressions, both in jetchat-admin and both on input tokens. Neither repeats across repos.
- Codex is **unavailable**. The workspace ran out of credits after 8 of 30 Reefmori pairs. No Codex conclusion is drawn.

## Repository matrix

| Repo | Role | Commit | Indexed files | Stack | Tasks | Prior exposure |
|---|---|---|---:|---|---:|---|
| reefmori | A, tuning reference | 6f2b9a5 | 100 | Phaser / TS game | 10 | v0.5.x tuning set |
| jetchat-admin | B, holdout | c9256c0 | 186 | Next.js admin, Firebase | 12 | used in v0.5.3/v0.5.4 validation |
| nestmind | C, unseen holdout | 3dc749f | 223 | NX monorepo, NestJS API, Prisma | 12 | never indexed or tuned |

- Every campaign ran in a clean detached worktree with a private data dir and a fresh index.
- Every campaign used repeat=3 and mode=both.
- Task sets were frozen with a sha256 before the first Stellar run, and the hash was verified again at campaign start.

## Agent matrix

| Agent | Version | reefmori | jetchat-admin | nestmind |
|---|---|---|---|---|
| Claude Code | 2.1.317 | 30/30 pairs | 36/36 pairs | 36/36 pairs |
| Codex CLI | 0.166.0 | 8/30 pairs (22 coverage gaps, out of credits) | aborted, no manifest (invalid) | not run |

Partial Codex Reefmori result, for information only (not evidence):

| Metric | Reduction |
|---|---:|
| Input | 30.0% |
| Search | 92.9% |
| Bytes | 56.4% |
| Tools | −26.7% |
| Input win/loss | 7/1/0 |

## Correctness

| Repo | Discovery B/S | Grounding B/S | Answer B/S | Grounded success B/S |
|---|---|---|---|---|
| reefmori | 100/100 | 100/100 | 100/100 | 100/100 |
| jetchat-admin | 100/100 | 88.9/91.7 | 100/100 | 88.9/91.7 |
| nestmind | 100/100 | 100/100 | 100/100 | 100/100 |

jetchat-admin misses the 100% target in **both** conditions:

- `flow-member-disable-and-enable`: 0/3 grounded in both conditions.
  - Neither condition ever reads the expected `src/lib/constants/api-endpoints.ts`; both read `src/lib/services/api.ts` instead.
  - The answer is still correct 6/6. This is a task-authoring defect: an expected file that is not needed to answer.
  - The task set is frozen, so it stays in and the miss stands.
- `impact-ai-generation-settings-shape`: baseline 2/3, Stellar 3/3.

No Stellar-specific correctness regression was observed.

## Efficiency

All values are Claude, same-campaign paired reductions (higher is better).

| Repo | Input | Tools | Search | Bytes | Files opened | firstRelevant |
|---|---:|---:|---:|---:|---:|---:|
| reefmori | 43.6 | 56.5 | 76.8 | 71.8 | 21.3 | 20.0 |
| jetchat-admin | 14.0 | 25.6 | 50.0 | 25.5 | −56.9 | 16.8 |
| nestmind | 10.8 | 18.8 | 50.6 | 24.7 | −63.5 | 10.2 |
| **run-weighted (102 pairs)** | 23.2 | 34.0 | 58.9 | 49.2 | −33.0 | 18.0 |
| **repo-weighted mean** | 22.8 | 33.7 | 59.1 | 40.7 | −33.0 | 15.7 |
| **repo median (primary)** | **14.0** | **25.6** | **50.6** | **25.5** | −56.9 | 16.8 |

Targets met, out of 3 repos:

| Metric | Directional | Strong |
|---|---|---|
| Input | 1/3 | 1/3 |
| Tools | 2/3 | 1/3 |
| Search | 3/3 | 3/3 |
| Bytes | 1/3 | 1/3 |

v0.5.5 Reefmori reference: input −45.27%, tools −58.15%, search −77.27%, bytes −72.97%, precision 0.782, correctness 100%. The v0.5.6 Reefmori re-run reproduces it within about 2 points (43.6 / 56.5 / 76.8 / 71.8, precision 0.791).

Absolute provider tokens are not compared across campaigns (provider drift).

## Context precision

Expected-file source precision (a focus proxy, not a gate):

| Repo | Baseline | Stellar |
|---|---:|---:|
| reefmori | 0.781 | 0.791 |
| jetchat-admin | 0.823 | 0.702 |
| nestmind | 0.975 | 0.724 |

On the holdouts the baseline agent is already very focused; it often reads one file with grep-guided line ranges. Stellar's fixed context budget (`--max-files 6 --max-bytes 12000`) embeds secondary files no matter how confident the top hit is. That raises non-expected bytes and "files opened" (−57% / −64%) even when total bytes fall.

## Category analysis (Claude)

| Category | Tasks | Pairs | Input RW / repo median | Tools | Search | Bytes | Grounded B/S |
|---|---:|---:|---|---|---|---|---|
| navigation | 8 | 24 | 24.3 / 26.8 | 36.6 / 34.8 | 76.8 / 75.9 | 34.5 / 9.9 | 100/100 |
| flow | 11 | 33 | 31.2 / 17.2 | 41.8 / 35.2 | 63.7 / 51.7 | 54.8 / 35.6 | 90.9/90.9 |
| impact | 7 | 21 | 10.5 / 17.6 | 26.6 / 28.6 | 43.8 / 42.9 | 36.1 / 39.8 | 95.2/100 |
| editing-prep | 8 | 24 | 19.3 / 11.5 | 25.0 / 25.4 | 48.3 / 36.0 | 55.8 / 46.9 | 100/100 |

- Every category has a positive median input reduction (4/4).
- Every category is represented in at least 2 repos (4/4).
- Impact and editing-prep are the weakest on input.

## Win/loss

Task-level, per-task medians, ±5% neutral band, 34 tasks:

| Metric | Win | Neutral | Loss |
|---|---:|---:|---:|
| Input tokens | 20 | 7 | 7 |
| Tool calls | 22 | 8 | 4 |
| Search calls | 31 | 2 | 1 |
| Source bytes | 24 | 1 | 9 |

Input losses:

- jetchat-admin: `flow-sign-in-to-session-cookie` (−41%), `impact-shared-date-picker-props` (−28%)
- nestmind: `ci-hook-to-recorded-outcome` (−9%), `vector-similarity-result-consumers` (−8%), `live-update-stream-fanout` (−7%), `structured-json-retry-and-call-timeout` (−6%)
- reefmori: `rush-spawn-flow` (−6%)

## Catastrophic regressions

| Repo | Task | Metric | Baseline median | Stellar median | Δ | Stellar grounded |
|---|---|---|---:|---:|---:|---:|
| jetchat-admin | flow-sign-in-to-session-cookie | input | 202,931 | 285,582 | +40.7% | 100% |
| jetchat-admin | impact-shared-date-picker-props | input | 146,404 | 186,805 | +27.6% | 100% |

- `flow-sign-in-to-session-cookie`: the context pulled in AI-side Firebase modules (`lib/ai/firebase-ai-client.ts`, `lib/firebase/remote-config.ts`) and `route-permissions.ts`. The prompt says "Firebase", and that term is shared by auth and AI code. The agent then still read all 4 expected files: 7 files read versus 4 for baseline, and 8 tools versus 6.
- `impact-shared-date-picker-props`: the intent was classified as **editing-prep**, not impact. The context then expanded the picker's *outbound* imports (`ui/button`, `ui/calendar`, `ui/popover`, `ui/table`) and unrelated AI executors. The agent read 8–14 files versus 5 for baseline.
- Repeated catastrophic pattern across repos: none.

## Determinism

Median coefficient of variation across 3 repetitions, 34 tasks:

| Metric | Baseline | Stellar | Tasks where Stellar is less variable |
|---|---:|---:|---:|
| Input | 0.105 | 0.088 | 17/34 |
| Tool calls | 0.102 | 0.141 | 10/34 |
| Source bytes | 0.069 | 0.059 | 15/34 |

The two sides are mixed: Stellar is not clearly more deterministic. Outliers are `edit-expose-organizations-module` (Stellar input CV 0.32) and `apex-hunt-flow` (0.28).

## First-relevant investigation

Median ms from agent spawn:

| Repo | Condition | First model event | First tool start | First tool duration | Relevant tool start | firstRelevant |
|---|---|---:|---:|---:|---:|---:|
| reefmori | baseline | 2791 | 2791 | 41 | 4961 | 5035 |
| reefmori | stellar | 3090 | 3090 | 974 | 3090 | 4029 |
| jetchat-admin | baseline | 3053 | 3053 | 52 | 5675 | 5690 |
| jetchat-admin | stellar | 3374 | 3374 | 950 | 3802 | 4732 |
| nestmind | baseline | 2989 | 2989 | 58 | 5393 | 5422 |
| nestmind | stellar | 3582 | 3582 | 976 | 3863 | 4871 |

- Stellar's first relevant call starts 1.6–2.5 s earlier than baseline's.
  - About 0.95 s of that gain is lost to the first-Bash-call cost in Claude Code. The local `stellar context` itself takes about 0.1 s.
  - The rest is lost to the first provider turn, which is about 3 s in both conditions.
- Upper bound if Stellar's first call took 0 ms, (B_firstRelevant − S_firstToolStart) / B_firstRelevant:

| Repo | Upper bound |
|---|---:|
| reefmori | 38.6% |
| jetchat-admin | 40.7% |
| nestmind | 33.9% |

- Under this metric and this agent, the 40% gate is at or beyond what is physically reachable. The gate is unchanged, and this is reported as a measurement limitation.
- Earlier notes on the v0.5.5 data: `first-relevant-notes.md`.

## Local Stellar latency

From `../latency/*.json`, 7 repetitions per task:

| Repo | Files | context cold p50/p95 | context warm p50/p95 | node floor p50 | index build | no-op sync p50/p95 | context JSON p50 | embedded source p50 |
|---|---:|---|---|---:|---:|---|---:|---:|
| reefmori | 100 | 128 / 179 | 131 / 168 | 58 | 362 | 95 / 102 | 6.9 KB | 4.7 KB |
| jetchat-admin | 186 | 97 / 109 | 96 / 108 | 55 | 302 | 94 / 102 | 6.3 KB | 4.2 KB |
| nestmind | 223 | 117 / 143 | 117 / 141 | 53 | 474 | 95 / 134 | 6.5 KB | 4.2 KB |

StellarCode's own latency is about 0.1 s and is not the bottleneck.

## Known limitations

- **Claude only.** Codex is unavailable (out of credits), so there is no cross-agent evidence.
- jetchat-admin had prior exposure in v0.5.3/v0.5.4 validation. nestmind is the only truly unseen repo.
- Three repositories is the minimum. Repo-weighted statistics over n=3 are fragile.
- One frozen task (`flow-member-disable-and-enable`) has an expected file that neither condition needs. That task alone causes the jetchat-admin correctness miss.
- The Reefmori task set is the v0.5.5 set; it was authored with knowledge of the runtime.
- `normalizeRow` still maps missing numeric fields to 0 for legacy rows. This has no effect on v0.5.6 data.
- firstRelevant includes provider and agent latency (see above).
- Absolute provider tokens are not comparable across campaigns.

## Generic issue classification

| Class | Issue | Evidence |
|---|---|---|
| confirmed generic | Fixed source budget over-includes secondary files when the answer is narrow | Precision drops in 2/3 repos. nestmind single-file navigation tasks: baseline reads 1 file in 2 tools, Stellar 3–4 files (bytes −51% to −117%). Also seen in reefmori `predator-pressure-impact` and jetchat `nav-malformed-ai-chart-rejection`. |
| confirmed generic | Intent classifier misses "if X changes, which files must be reviewed" impact phrasing | Impact classified correctly 3/7. jetchat 0/3, nestmind 2/3, reefmori 1/1. Overall classifier agreement 27/34 (reefmori 10/10, jetchat 8/12, nestmind 9/12). Linked to one catastrophic regression. |
| possible generic | Lexical term collision (a shared vendor or framework word) pulls unrelated modules into context | jetchat `flow-sign-in-to-session-cookie` ("Firebase"). One instance only. |
| repo-specific | The holdout baselines are already more efficient than the reefmori baseline, which leaves less headroom | Average baseline tool calls: nestmind 5.31, jetchat 6.50, reefmori 7.20. Stellar averages: 4.31 / 4.83 / 3.13. |
| task-authoring | `flow-member-disable-and-enable` expects a file that is not needed | 0/6 grounded in both conditions, 6/6 answers correct |
| isolated stochastic | High-variance single tasks | `edit-expose-organizations-module` (Stellar CV 0.32), `apex-hunt-flow` (0.28) |

## Generalization decision

**PARTIAL GENERALIZATION** (Claude only; Codex unavailable).

| Rule | Result |
|---|---|
| Distinct repositories | 3 (minimum met) |
| Grounded correctness 100% | 2/3 repos. The miss is symmetric, with Stellar ≥ baseline. |
| Repo-median input reduction ≥ 20% | 13.96%, not met |
| Repo-median tools / search / bytes | 25.6 / 50.6 / 25.5 |
| Categories with a positive median input reduction | 4/4 |
| Repeated catastrophic pattern | none |

Candidate v0.5.7 runtime fixes (proposal only, **not implemented**):

1. **Confidence-adaptive source budget.** When the top-ranked file covers the query with high confidence, stop embedding secondary files.
2. **Impact-phrasing intent rule.** Classify "renamed / type changes / gains a field … which files must be reviewed" as impact, and expand only *inbound* dependents for impact.
3. **Generic-term down-weighting.** Lower the weight of query terms that match many unrelated modules (vendor names such as Firebase) during context routing.

Each fix must be validated on a fresh, unseen holdout. It must not be tuned against jetchat-admin or nestmind, which are now exposed.
