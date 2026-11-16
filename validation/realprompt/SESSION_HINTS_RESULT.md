# v0.8.3 session hints from git history: result

Measured on the real-prompt evaluation set (`README.md`): diagnosed and developed on dev, confirmed once on the holdout, baseline and change together. Deterministic and local; no agent was run.

## Diagnosis (dev, 309 prompts)

97 turns needed no file new to the session. Of the 212 that did:

| Outcome of the prompt's own lookup (no gate) | Turns | Share |
|---|---|---|
| A new touched file is attached | 57 | 27% |
| Ranked in the top 3 but not attached | 4 | 2% |
| Ranked 4 to 10 | 14 | 7% |
| Ranked below 10 | 34 | 16% |
| Query has terms, the file matches none of them | 59 | 28% |
| The prompt yields no query term | 44 | 21% |

Half of the misses (103) have no lexical link between the prompt and the file: short follow-ups that refer to the conversation, 52 of them Chinese only, median 20 characters. Ranking cannot reach them.

Probes on the 156 follow-ups that needed a new file (lookup alone finds it in 33):

| Probe | Finds a new touched file |
|---|---|
| Previous prompt added to the query | 10 gained, 3 lost |
| Import neighbors of the session's files, top 3 by the prompt's ranking | union 41 (the neighbor set has a median of 97 files) |
| **Files that changed together with the session's files in earlier commits, top 3** | 39 alone, **union 58** |

Only commits before each prompt's time were used, so a session's own commits cannot leak into its hints.

## Change

In a follow-up (the transcript shows files already read), the hook names up to three files that git history shows changing together with those files: for every commit that touched some of them, each other file scores the number of them it changed with. Commits of more than 40 files are skipped; the last 400 commits are read; only existing source files are named. The strongest three are the hints; one already given in the session is not repeated or replaced by a weaker one.

The hints are paths, not source. They follow the attached source when there is one, and are sent alone (about 170 characters a turn) when there is none. `--session-hints off` disables them.

## Result

`reachNew`: a file the turn touched, new to the session, was attached, hinted, or hinted earlier in the session. Hook settings (character limit, strict gate, seen files dropped) in both columns.

| | Dev (309) | Holdout (156, scored once) |
|---|---|---|
| reachNew, before | 3.2% | 7.1% |
| reachNew, with session hints | **20.1%** | **20.5%** |
| Paired difference | +16.8 pts [12.6, 21.0] | **+13.5 pts [8.3, 19.2]** |
| hitNew (source attached) | 2.9% → 2.9% | 6.4% → 6.4% |
| Attached characters | 112,173 → 140,963 (+26%) | 133,226 → 142,640 (**+7%**) |
| Hints given / later touched in the session | 207 / 81 (39%) | 124 / 29 (23%) |

Holdout by repository (turns reaching a new file): R04 8 → 12, R05 0 → 10, R06 0 → 0, R08 0 → 1, R09 1 → 2, R10 1 → 3, R11 1 → 4.

A first implementation replaced an already-given hint with the next weaker candidate; on dev it gave 664 hints for the same gain per character and was dropped before the holdout run.

## Reading

- History says what belongs together when the prompt does not: the gain comes from turns whose prompt has no usable terms.
- A hint is weaker than attached source. It saves the search for the file, not the read. `reachNew` counts hints and attached source alike; `hitNew` is unchanged.
- No effect on a repository with little history or large commits (R06: none of 14).

## Limits

- One developer's sessions; the label is what the agent touched.
- A hint given early stays countable for the rest of the session, so `reachNew` grows with session length. Hint precision (23% to 39% touched later) is the stricter figure.
- Whether a path hint changes what an agent does was not measured: no agent was run.
