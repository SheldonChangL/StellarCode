# v0.8.4 session hints from the dependency graph: result

Measured on the real-prompt evaluation set (`README.md`): developed on dev, confirmed once on the holdout, baseline and change together. Deterministic and local; no agent was run.

## Why

The v0.8.3 hints (`SESSION_HINTS_RESULT.md`) come from git history alone. A repository with little history or large commits gets none (R06: 0 of 14), and a file that rarely changes with the session's files is never named. The index already holds the dependency graph, so files that import, or are imported by, the session's files are a second source at no token cost.

## Change

- `dependencyNeighbors(root, files)` (query service): files linked to the given files by `imports` or `tests` edges, or by symbol `references`, in either direction. Each candidate scores the number of given files it is linked to; ties go to the more important file.
- Session hints take candidates from both sources, interleaved (co-change first, then the dependency graph, rank by rank, without repeats). The limit is five hints instead of three. Everything else is unchanged: paths only, once per session, after the source or alone.
- `sessionHints: { source: 'both' | 'cochange' | 'deps', limit }` selects them for evaluation; `score.mjs` has `--hint-source` and `--hint-limit`.
- With `before` (evaluation only), a candidate must also have existed at the last commit before the prompt. The index is at the current commit, so without this a file the turn created could be hinted. It does not change the v0.8.3 baseline (holdout 20.5% before and after).

## Variants on dev (309 prompts, hook settings)

| Hint source, limit | reachNew | Hints given | Later touched |
|---|---|---|---|
| co-change, 3 (v0.8.3) | 20.1% | 207 | 39% |
| dependency graph, 3 | 18.4% | 201 | 33% |
| both, 3 | 20.4% | 211 | 41% |
| co-change, 5 | 22.3% | 320 | 33% |
| **both, 5** | **23.9%** | 331 | 33% |
| both, 5, files named by both first | 24.3% | 347 | 33% |

The two sources reach different turns: of 78 turns either one reaches at 3 hints, 41 are reached by both, 21 by co-change only and 16 by the dependency graph only. Alone, the graph is weaker than history. Combined at three hints they crowd each other out (+0.3 pts); five hints let both contribute.

Paired differences on dev: v0.8.3 → both, 5: **+3.9 pts [1.9, 6.1]** (12 turns gained, none lost). Of that, the higher limit gives +2.3 [0.6, 4.2] with co-change alone, and the graph adds +1.6 [−1.0, 4.2] at the same limit. Putting files named by both first added 0.4 pts and was not kept.

## Holdout confirmation (156 prompts, scored once)

| | v0.8.3 (co-change, 3) | v0.8.4 (both, 5) |
|---|---|---|
| reachNew | 20.5% | **25.6%** |
| Paired difference | | **+5.1 pts [1.9, 9.0]** (8 turns gained, none lost) |
| hitNew (source attached) | 6.4% | 6.4% |
| Attached characters | 142,640 | 145,796 (+2.2%) |
| Hints given / later touched in the session | 124 / 29 (23%) | 202 / 48 (24%) |

By repository (turns reaching a new file): R04 12 → 13, R05 10 → 12, R06 0 → 3, R08 1 → 2, R10 3 → 4; R07, R09 and R11 unchanged. R06, which history could not help, now gets hits from the graph.

## Limits

- One developer's sessions; the label is what the agent touched.
- More hints per turn: precision stays at the v0.8.3 level on the holdout (24%) but falls on dev (39% → 33%). Each hint is a path of about 60 characters.
- `reachNew` counts a hint like attached source, and a hint stays countable for the rest of the session. Whether a path hint changes what an agent reads was not measured: no agent was run.
- The dependency graph is the current index, filtered to files that existed at the prompt's time; edges between files may have differed then.
- v0.8.5 correction: a hint could name a file whose source the hook attached earlier in the session; such files are now skipped. Dev `reachNew` is unchanged (23.9%); the holdout was not rescored for it (`../followup/README.md`).
