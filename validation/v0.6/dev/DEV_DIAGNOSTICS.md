# v0.6 development diagnostics (exposed repositories only; not holdout evidence)

All nine repositories below were already used in v0.5.6–v0.5.9. These numbers guided development and say nothing about generalization.

- **Runtime:** `db5af25`
- **Context command:** the benchmark one, `--compact --with-source --depth 1 --max-files 6 --max-lines 160 --max-bytes 12000`
- **Comparison:** each repository was run twice on the same index, once with the semantic slice on and once off (`STELLAR_SEMANTIC_SLICE=0`, which is what the `stellar-lexical` condition uses).
- **Per-task output:** `diagnostics/<repo>.json`

## Expected-file grounding: lexical → semantic

"Grounded" means the expected file has a source excerpt in the context.

| Repo | Tasks | Top target correct | Tasks with semantic edges | Index edges (CALLS/IMPLEMENTS/REGISTERS/CONSUMES) | Expected files grounded | Median source bytes | Full index (ms) |
|---|---|---|---|---|---|---|---|
| jetchat-admin | 12 | 5 | 8 | 308/0/6/255 | 12/30 → 14/30 | 3935 → 4793 | 488 |
| nestmind | 12 | 6 | 12 | 816/90/0/675 | 17/30 → 19/30 | 4522 → 6756 | 787 |
| reefmori | 10 | 8 | 10 | 946/77/18/538 | 17/19 → 18/19 | 5817 → 6672 | 520 |
| anchor | 12 | 8 | 11 | 1491/28/14/366 | 12/31 → 19/31 | 4357 → 6001 | 1026 |
| lodestar | 12 | 4 | 7 | 615/0/85/0 | 7/29 → 7/29 | 4649 → 4907 | 811 |
| moneytalks | 12 | 3 | 7 | 373/4/13/228 | 10/30 → 12/30 | 3532 → 3902 | 522 |
| kc002-ota | 12 | 6 | 12 | 336/3/59/85 | 13/28 → 18/28 | 3963 → 4953 | 537 |
| goodjobshare | 12 | 2 | 7 | 298/0/15/373 | 3/33 → 6/33 | 1601 → 1611 | 721 |
| patentskill | 12 | 4 | 11 | 1342/0/92/358 | 11/27 → 12/27 | 5884 → 7295 | 1089 |
| **Pooled** | **106** | **46** | **85** | | **0.397 → 0.486** | **4090 → 4953** | |

By category (expected files grounded):

| Category | Lexical → semantic |
|---|---|
| navigation | 15 → 15 / 27 |
| flow | 38 → 45 / 86 |
| impact | 26 → 38 / 84 |
| editing-prep | 23 → 27 / 60 |

No category regresses.

## Required relation coverage (kc002-ota, 4 annotated tasks, 11 edges)

`validation/v0.6/dev/kc002-ota.dev-semantic.json`

| Measure | Result |
|---|---|
| Index-level recall | 11/11. This is circular: the annotations were read from the index after checking them against source. |
| Context-level recall | 4/11 (36%) |

Per-task context recall:

| Task | Recall | Notes |
|---|---|---|
| flow-kc003-firmware-key-wrapping | 3/3 | route REGISTERS handler → CALLS service → CALLS crypto; semanticPathLength 2 |
| flow-user-reset-queues-alerts | 0/3 | The top target is the wrong method in the right file, and the other targets are password-reset code. |
| impact-logout-revocation-list | 0/2 | The top target is wrong (a controller `list`). |
| impact-signup-confirmation-token-store | 1/3 | The intent classifier labels it navigation, so the slice is the 3-edge incoming navigation slice. |

## Post-context exploration before v0.6 (where agents went after the context)

Source: v0.5.9 Stage 2 `pull` runs, repetition 1, 24 tasks. See [docs/V0.6_CURRENT_GRAPH_GAPS.md](../../../docs/V0.6_CURRENT_GRAPH_GAPS.md). The graph-addressable exploration was mostly:

| Relation the agent reconstructed | Tasks |
|---|---|
| Incoming callers/consumers | 7 |
| Outgoing callees | 5 |
| Member calls on imported singletons | 4 |
| Registration | 1 |

10 of the 24 were target or excerpt problems, not graph gaps.

## Known failures

- **The top target is wrong in 60 of 106 tasks.** This is lexical ranking, unchanged in v0.6. A slice from the wrong owner is correct for that owner but does not contain the requested chain. This is the dominant limit on context-level recall.
- **Intent misclassification** (impact or flow labeled navigation) gives the small navigation slice.
- **Python receivers are resolved conservatively.** lodestar shows no grounding change.
- **False-edge review (fresh-context reviewer before the freeze).** It found 11 shapes that produced wrong high-confidence edges:
  - nested declarations
  - untyped parameter and local shadowing
  - regex literals in the masker
  - JSX text
  - commented-out re-exports
  - reassignment
  - conflicting field assignments
  - `this` in object-literal methods
  - Python class attributes
  - Python keyword arguments
  - object keys

  It also found two quadratic hot paths. All 11 shapes are fixed and covered by `tests/v06-semantic-graph.test.js` ("no false edge"), and both hot paths are now linear. A 300 KB TSX file had taken 49.6 s because of a quadratic regex-literal check introduced during the fix; it now takes 0.23 s.
