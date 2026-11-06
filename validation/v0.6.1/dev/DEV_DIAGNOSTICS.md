# v0.6.1 semantic entry selection: development diagnostics

**This is not holdout evidence.** audit-orders, JetBook and Redmine-AI-agent were the v0.6 unseen holdout. They are now exposed and were used here to develop and tune v0.6.1. Nothing below supports a generalization claim.

Only deterministic semantic diagnostics were run (`semanticDiagnostics`, the benchmark context flags). No agent token benchmark was run on these repositories. The worktrees are the frozen v0.6 holdout checkouts: audit-orders `e47d84c`, JetBook `371b82e`, Redmine-AI-agent `5189f6b`. Each was indexed into a fresh scratch data directory.

Per-task rows for both stages are in [`semantic-funnel.json`](semantic-funnel.json).

## Smoke criterion

The pre-freeze smoke criterion is returned/indexed required-edge recall of at least 60% on this development set.

| Runtime | Pooled routing recall | Repo median | Smoke criterion |
|---|---|---|---|
| `e60589b` (seeds and intent) | 20/58 = 34.5% | 31.3% | not met |
| Iteration 2 (seed relevance and admission) | **35/58 = 60.3%** | **52.2%** | met on the pooled number, by one edge |

The second iteration passes the pooled criterion by a single edge, on repositories that were used to tune it. Read that as "at the threshold", not as evidence of generalization. The repo median, which is the statistic a holdout would use, is 52.2%. That is below both 60% and the 70% holdout target.

The holdout was stopped by instruction. No runtime freeze is declared.

## Funnel (pooled over 3 repositories, 28 annotated tasks, 74 required edges)

| Stage | v0.6 (historical, `db5af25`) | + range repair (`0c45b82`) | + seeds and intent (`e60589b`) | + seed relevance and admission (iteration 2) |
|---|---|---|---|---|
| Required | 74 | 74 | 74 | 74 |
| Indexed | 38 (51.4%) | 58 (78.4%) | 58 (78.4%) | 58 (78.4%) |
| Endpoint among the seed candidates | n/a | 37 (pool of 12 files) | 46 (pool of 20 files) | 46 |
| Reachable from the chosen seeds | n/a | 20 | 33 | 42 |
| Admitted by traversal | n/a | 8 | 24 | 36 |
| Returned to context | 3 | 6 | 20 | 35 |
| **Routing recall** (returned / indexed) | 3/38 = 7.9% | 6/58 = 10.3% | 20/58 = 34.5% | **35/58 = 60.3%** |
| End-to-end recall (returned / required) | 4.1% | 8.1% | 27.0% | 47.3% |

The v0.6 column comes from `validation/v0.6/V0.6_HOLDOUT.md`. The v0.6 runtime had no seed concept, so its intermediate stages are n/a.

"Reachable from the chosen seeds" means one endpoint of the edge lies within one hop of a seed. The slice traverses at most two edges from a seed, so this is the most it could return.

### Per repository (iteration 2)

| Repo | Required | Indexed | In candidate pool | Seed reachable | Admitted | Returned | Routing recall |
|---|---|---|---|---|---|---|---|
| audit-orders | 16 | 16 | 12 | 15 | 14 | 14 | 87.5% |
| JetBook | 26 | 23 | 20 | 16 | 12 | 12 | 52.2% |
| Redmine-AI-agent | 32 | 19 | 14 | 11 | 10 | 9 | 47.4% |

"Seed reachable" can exceed "in candidate pool". The first counts edges within one hop of a seed; the second counts edges with an endpoint among the seed candidates.

### Per repository (`e60589b`)

| Repo | Required | Indexed | In candidate pool | Seed reachable | Admitted | Returned | Routing recall |
|---|---|---|---|---|---|---|---|
| audit-orders | 16 | 16 | 12 | 12 | 8 | 5 | 31.3% |
| JetBook | 26 | 23 | 20 | 15 | 11 | 10 | 43.5% |
| Redmine-AI-agent | 32 | 19 | 14 | 6 | 5 | 5 | 26.3% |

## Iteration 2: seed relevance and traversal admission

Parser, intent and the edge resolver are unchanged, and so is every edge budget.

**Seed relevance.**
- What changed: the seed score is now the weighted coverage of *distinct* query terms in the symbol's name and code. Name terms count twice. String literals, comments and JSX/HTML text are excluded. Bodies longer than 80 lines are discounted by sqrt(80/span), at most 2×.
- Why: the in-file range score (`rankFileSymbols`) favors short helpers whose name repeats one query word, such as `APILogger.error`, `QdrantSearcher.search` and `progress`. It also favors page components whose UI labels restate the query.

**Admission.**
- Flow upstream callers: the v0.6 `onlyUnique` rule dropped every caller of a step that has more than one caller. It is replaced by keeping the two most query-relevant callers per node.
- Edges between two distinct seeds in one file are admitted. The old "sibling inside one seed container" exclusion now applies only to members of the same expanded container.
- Navigation with a behavior seed also reports the owner's callees as relations, without source. Callees still stay ungrounded (v0.5.4 rule), and the 3-edge budget is unchanged.
- CONSUMES targets get the same fan-in discount as CALLS targets, so widely consumed infrastructure such as `db` and schema tables ranks below a specific callee.

**Effect of each change.**

| Change | Pooled returned edges |
|---|---|
| Traversal fixes alone (fan-in, navigation callees) | 20 → 24 |
| + coverage seed score | 27 |
| + code-only body | 32 |
| + distinct-seed link fix | 34 |
| + CONSUMES fan-in | 35 |

**Tried and not adopted.** These changed results by ±1 edge or regressed a repository:
- round-robin budget across seeds
- a bonus for seed-to-seed edges
- name weight 0.5 or 2
- span reference 50 or 120

**Cost: more source per context.** Median grounded source bytes rose from 4,000 to 7,025 (audit-orders), 9,866 to 11,195 (JetBook) and 5,352 to 7,585 (Redmine-AI-agent). Every payload stays under the unchanged 12,000-byte budget. A holdout should watch input tokens against the "semantic route catastrophe" rule.

**Check on repositories not used for tuning.** Six exposed repositories have no semantic-edge annotations: nestmind, jetchat-admin, reefmori, kc002-ota, patentskill and goodjobshare. On them, deterministic expected-file grounding compared `e60589b` with iteration 2. All payloads stayed within budget. See [`unannotated-repos.json`](unannotated-repos.json).

| Repo | Expected-file grounding (`e60589b` → iteration 2) |
|---|---|
| jetchat-admin | 0.467 → 0.733 |
| reefmori | 0.947 → 1.0 |
| kc002-ota | 0.786 → 0.821 |
| goodjobshare | 0.242 → 0.273 |
| patentskill | 0.556 → 0.556 |
| nestmind | 0.800 → 0.733 |

## Where the edges were lost at `e60589b` (before iteration 2)

1. **Seed choice inside the candidate pool. This is the largest loss: 46 → 33, and 37 → 25 at a 12-file pool.**
   - Enlarging the pool from 12 to 60 files raises its ceiling from 37 to 54 edges. Returned edges stay at 16–19.
   - The binding limit is the in-file symbol relevance (`rankFileSymbols`), which picks the seed. Typical failures:
     - `nl_to_redmine_query` ranks fifth, behind generic search helpers.
     - The bearer-token middleware loses to `jetResponse`.
     - The throttle file is not a lexical candidate at all, because the prompt paraphrases "lock" as "blocked".
   - v0.6.1 was scoped not to rewrite lexical relevance.
2. **Traversal admission: 33 → 24.** Flow seeds often land on the step that does the work, for example a service method. The required chain starts upstream (route → controller → service). Following callers two hops upstream in flow recovered part of this, within the unchanged 6-edge budget.
3. **Edge budget: 24 → 20.** Some admitted edges lose to higher-scored neighbors within the per-intent budget. The budgets were not raised.
4. **Index: 58 of 74.** Most remaining index misses are in Python (Redmine-AI-agent 19/32): receivers without type evidence, and module-attribute calls. No resolver capability was added.

## Parser attribution (range repair)

All 15 edges that the v0.6 audit (`validation/v0.6/holdout/edge-audit.json`) found with a `(module level)` caller now name the enclosing function: **15/15 fixed**. Examples:
- `changePasswordAction`
- `EditPage`
- `put_redmine_token` (two edges)
- `nl_to_redmine_query`

In the v0.6 audit, 15 of 69 returned edges had a module-level caller.

## Intent agreement (authored category vs runtime intent)

| Repo | v0.6 | v0.6.1 |
|---|---|---|
| audit-orders | 9/12 | 12/12 |
| JetBook | 5/12 | 12/12 |
| Redmine-AI-agent | 9/12 | 12/12 |

All 72 categorized prompts across every exposed task set now agree, against 24/36 for the older classifier on the non-v0.6 sets. The rules were written while these prompts were visible, so this is a development fit, not a generalization estimate. The generic precedence rules are covered by `tests/v061-semantic-seed.test.js`.

## Context size

| Repo | Median grounded source bytes (range repair only → v0.6.1) | Expected-file grounding |
|---|---|---|
| audit-orders | 1,610 → 4,000 | 0.033 → 0.533 |
| JetBook | 8,402 → 9,866 | 0.441 → 0.588 |
| Redmine-AI-agent | 4,560 → 5,352 | 0.370 → 0.407 |

Every payload stays under the unchanged 12,000-byte context budget.

## Remaining losses (iteration 2)

| Stage | Edges lost | Cause |
|---|---|---|
| Indexed → candidate pool | 12 | The lexical ranker never surfaces the owning file. The prompt paraphrases its vocabulary: "blocked" for a throttle/lock, an NDA guard, and a confirm endpoint. |
| Candidate pool → seed reachable | 4 | — |
| Seed reachable → admitted | 6 | Mostly chains three or more hops from the seed. |
| Admitted → returned | 1 | Edge budget |

Index misses (16) are mostly Python receivers without type evidence.

## Not done

- A source audit of the edges that v0.6.1 newly routes into context. No resolver rule changed, but the range repair changes which callers exist. This audit should run before any holdout.
- A new unseen holdout, stopped by instruction.
