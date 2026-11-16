# Real-prompt retrieval evaluation

A retrieval test set made from a developer's own Claude Code sessions, so ranking changes can be measured on real work in under a minute, without running an agent.

## Why

What makes StellarCode save tokens is whether the code it returns is the code the task needs (`../v0.7/HOLDOUT_RESULT.md`: Swift, where 56% of expected files are delivered, saves 26% of cost on repetition 1; a Kotlin repository with 23% saves nothing). The delivery path barely moves cost (`../v0.7/DELIVERY_RESULT.md`, correction). Agent benchmarks measure this with hand-written tasks and cost hundreds of runs per change. This set measures retrieval alone, on prompts people actually typed.

## Method

`extract.mjs <eval-dir>` reads `<eval-dir>/repos.json` (repository id, stack, local path, split), clones each repository's current `HEAD`, indexes the clone, and reads the session transcripts in `~/.claude/projects`.

- **Item**: a prompt the developer typed in a session whose working directory is inside the repository (or one of its `.claude/worktrees`). Slash commands, tool results, system messages and continuation summaries are excluded.
- **Label**: the source files the agent read, edited or wrote in that turn, up to the next prompt (Read, Edit, Write, MultiEdit, and file paths in Bash commands), kept if the file exists in the clone and has a supported extension.
- **Kept**: items that pass the prompt gate (not a command or short follow-up) and have at least one labeled file.

`score.mjs <eval-dir> --label NAME` runs the `stellar preflight` lookup (the delivery benchmarks' context options, no character limit, no strict gate) on each item and compares the attached files with the label:

| Metric | Meaning |
|---|---|
| delivered | anything was attached |
| hit | at least one attached file was touched |
| top1 | the top target was touched |
| hitWithHints | a touched file is among the attached or hinted files |
| recall | share of touched files that were attached |
| precision | share of attached files that were touched (over delivered items) |

`score.mjs <eval-dir> --compare BASE NEW` gives paired differences with a bootstrap interval over prompts.

**Privacy.** Prompts, paths, repository names and per-prompt results stay in `<eval-dir>`, outside this repository. Only the method and aggregates are committed. Repositories are referred to by neutral ids.

## Split (fixed before any scoring)

| Id | Stack | Split | Items |
|---|---|---|---|
| R01 | Kotlin Android app | dev | 232 |
| R02 | TypeScript backend | dev | 62 |
| R03 | JavaScript (StellarCode) | dev | 15 |
| R04 | JavaScript/TypeScript desktop tool | holdout | 65 |
| R05 | TypeScript backend | holdout | 37 |
| R06 | Rust/TypeScript tool | holdout | 14 |
| R07–R09 | Kotlin Android apps | holdout | 11 |
| R10 | TypeScript game | holdout | 10 |
| R11 | TypeScript MCP server | holdout | 19 |

Dev: 309 items, sha256 `bf6b419d3e0cb24c6b7475bcebba5520154725cd51e6588a9852a76f0622c1c5`. Holdout: 156 items, sha256 `812a4f59b4585bed5931cb7972ed20629323d779e976608cde755a0a3c8f3f24`. Built 2026-11-16.

The first split had a 40-item holdout (five repositories never used before); it was rebalanced once, before anything was scored, to put three more repositories in the holdout. R01, R02, R04, R05, R06 and R03 were used in the hook gate analysis (`../v0.7/HOOK_GATE_RESULT.md`), which did not change ranking.

**Rules.** Ranking changes are developed on dev only. The holdout is scored with `--confirm-holdout`, once per change already chosen on dev, baseline and change together; every holdout run is logged in `<eval-dir>/holdout-log.jsonl`. Dev is dominated by R01 (232 of 309): read per-repository numbers before pooled ones.

## Baseline (dev, runtime `2e36613`)

309 prompts, 95% bootstrap interval over prompts:

| Metric | Value |
|---|---|
| delivered | 69.3% [64.1, 74.1] |
| hit | **30.7%** [25.6, 35.9] |
| top1 | 16.8% [12.6, 21.0] |
| hitWithHints | 37.9% [32.4, 43.0] |
| recall | 10.9% [8.5, 13.6] |
| precision | 20.2% [16.5, 24.1] |

| Repository | Items | Delivered | Hit | Top1 | Recall |
|---|---|---|---|---|---|
| R01 Kotlin | 232 | 66.4% | 26.7% | 15.5% | 8.2% |
| R02 TypeScript | 62 | 79.0% | 38.7% | 16.1% | 20.9% |
| R03 JavaScript | 15 | 73.3% | 60.0% | 40.0% | 11.8% |

Not attached: 95 prompts, all `no-evidence`.

## Limits

- One developer's prompts, mostly Chinese with English terms. The label is what the agent touched, which includes exploration that was not needed; a file the agent never opened can still have been relevant.
- Repositories are at their current commit; files touched under another path or since deleted are dropped from the label.
- The query is the user's own prompt, as the hook sends it. With `pull`, the agent writes the query itself, usually with code names in it; this set is harder than that path.
