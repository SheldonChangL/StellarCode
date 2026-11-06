# v0.6.1 semantic entry selection: development diagnostics

**This is not holdout evidence.** audit-orders, JetBook and Redmine-AI-agent were the v0.6 unseen holdout. They are now exposed and were used here to develop and tune v0.6.1. Nothing below supports a generalization claim.

Only deterministic semantic diagnostics were run (`semanticDiagnostics`, the benchmark context flags). No agent token benchmark was run on these repositories. The worktrees are the frozen v0.6 holdout checkouts: audit-orders `e47d84c`, JetBook `371b82e`, Redmine-AI-agent `5189f6b`. Each was indexed into a fresh scratch data directory.

Per-task rows for both stages are in [`semantic-funnel.json`](semantic-funnel.json).

## Smoke criterion: not met

The pre-freeze smoke criterion is returned/indexed required-edge recall of at least 60% on this development set. v0.6.1 reaches **20/58 = 34.5%**. As the task plan requires, no new holdout was run and no runtime freeze is declared.

## Funnel (pooled over 3 repositories, 28 annotated tasks, 74 required edges)

| Stage | v0.6 (historical, `db5af25`) | + range repair (`0c45b82`) | + seeds and intent (`e60589b`) |
|---|---|---|---|
| Required | 74 | 74 | 74 |
| Indexed | 38 (51.4%) | 58 (78.4%) | 58 (78.4%) |
| Endpoint among the seed candidates | n/a | 37 (pool of 12 files) | 46 (pool of 20 files) |
| Reachable from the chosen seeds | n/a | 20 | 33 |
| Admitted by traversal | n/a | 8 | 24 |
| Returned to context | 3 | 6 | 20 |
| **Routing recall** (returned / indexed) | 3/38 = 7.9% | 6/58 = 10.3% | **20/58 = 34.5%** |
| End-to-end recall (returned / required) | 4.1% | 8.1% | 27.0% |

The v0.6 column comes from `validation/v0.6/V0.6_HOLDOUT.md`. The v0.6 runtime had no seed concept, so its intermediate stages are n/a.

"Reachable from the chosen seeds" means one endpoint of the edge lies within one hop of a seed. The slice traverses at most two edges from a seed, so this is the most it could return.

### Per repository (`e60589b`)

| Repo | Required | Indexed | In candidate pool | Seed reachable | Admitted | Returned | Routing recall |
|---|---|---|---|---|---|---|---|
| audit-orders | 16 | 16 | 12 | 12 | 8 | 5 | 31.3% |
| JetBook | 26 | 23 | 20 | 15 | 11 | 10 | 43.5% |
| Redmine-AI-agent | 32 | 19 | 14 | 6 | 5 | 5 | 26.3% |

## Where the edges are lost

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

## Not done

- A source audit of the edges that v0.6.1 newly routes into context. No resolver rule changed, but the range repair changes which callers exist. This audit should run before any holdout.
- A new unseen holdout. It is gated on the smoke criterion above.
