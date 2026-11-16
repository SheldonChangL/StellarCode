# v0.8.1 hook gate on real prompts: result

The v0.8 hook (`HOOK_RESULT.md`) was measured on benchmark tasks: self-contained navigation questions, each one about code. This measures it on prompts a developer actually typed, and sets the gate the automatic hook uses from v0.8.1.

This is a development analysis, not a pre-registered experiment. No agent was run; everything below is deterministic and local.

## Data

- Prompts typed by one developer in Claude Code sessions, read from the local session transcripts. Slash commands, tool results, system messages and benchmark runs were excluded.
- Six repositories that StellarCode indexes, each cloned at its current `HEAD` and indexed: a Kotlin Android app, two TypeScript backends, a JavaScript/TypeScript desktop tool, a Rust/TypeScript tool, and StellarCode itself. **1,764 prompts.**
- Language: 997 mix Chinese with ASCII terms, 649 are Chinese only, 118 are ASCII only.
- `stellar preflight` with the hook's settings (9,800-character limit) was run on each prompt in its repository.

**Label.** For each prompt, the source files the agent read, edited or wrote (Read, Edit, Write, and file names in Bash commands) until the next prompt. A delivery is a **hit** when the agent touched an attached file, a **miss** when it touched other source only, and **waste** when it touched no source.

The prompts and per-prompt results are not committed: they are private session content.

## Before: the v0.8 hook

| Prompt language | Prompts | Attached | Hit |
|---|---|---|---|
| Chinese with ASCII terms | 997 | 651 (65%) | 118 |
| Chinese only | 649 | 77 (12%) | 5 |
| ASCII only | 118 | 65 (55%) | 6 |
| **All** | 1,764 | **793 (45%)** | **152 (19% of attached)** |

(The hit counts per language use target files only; the total uses all attached files.)

Of the 793 attachments, **374 (47%) went to turns that touched no source**: git and deployment chores, follow-ups that refer to the conversation, account and setup steps, UI descriptions. A common word in the prompt ("commit", "main", "google", "token", "log") matched some file. 267 went to turns that worked on other files. 152 were hits.

Not attached although the agent then worked on source: 228 prompts with no matching source (147 of them Chinese only) and 209 rejected by the length check.

Chinese comments in the source would let Chinese-only prompts match, but only the Kotlin app has them widely (97% of its source files); the other five have them in 5% to 34% of files, mostly a few lines.

## Cost of a wrong attachment

In the hook campaign the first turn wrote about 3,200 more cache tokens with the hook than with `pull` (median attachment 8,088 characters), about **$0.05** at the cache-write price ($16 per million; `DELIVERY_RESULT.md`, correction). An attachment the turn does not use is that cost and nothing else.

A useful attachment saved about $0.009 against `pull` on repetition 1 of the hook campaign. Breaking even therefore needs about 85% of attachments to be useful; even if a useful attachment saved as much as a wrong one costs, it needs 50%. The v0.8 hook is at 19%.

## Gate search

Signals available without a model: the number of distinct query terms the targets matched (from their reasons), how common the rarest matched term is in the repository, whether the prompt names an attached file (its stem) or a target symbol as a word, whether the prompt is pasted content, and whether it is the first in its session.

| Signal among the 793 attachments | Share that are hits |
|---|---|
| All | 19% |
| First prompt of its session | 26% |
| At least 3 matched terms | 32% |
| Names an attached file or symbol | 33% |
| Pasted content | 48% |

75 combinations were compared. The best trade-offs:

| Gate | Attached | Hit | Waste | Precision | Share of hits kept |
|---|---|---|---|---|---|
| none (v0.8) | 793 | 152 | 374 | 19% | 100% |
| ≥ 2 matched terms, names a file or symbol | 131 | 57 | 51 | 44% | 38% |
| **≥ 4 matched terms, names a file or symbol** | **71** | **39** | **26** | **55%** | **26%** |
| ≥ 5 terms, rarest in ≤ 10% of files, names a file or symbol | 26 | 17 | 7 | 65% | 11% |

**Leave-one-repository-out** (choose the most precise gate keeping ≥ 25% of hits on five repositories, apply it to the sixth): pooled precision 51%, 26% of hits kept, 77 attached, 30 waste. It varies widely by repository: 23 of 33 on the desktop tool, 2 of 20 on one backend.

No gate reaches the break-even of the measured costs. Whether a turn needs code depends on the conversation, which a lexical match on the prompt cannot see.

## Decision

The automatic hook (`stellar preflight --hook`, and `stellar preflight --claude`, which records what the hook would attach) now attaches only when the prompt **names an attached file or a target symbol and the targets match at least four distinct query terms**; otherwise the reason is `weak-match`. `--gate any` restores the v0.8 behavior. The manual `stellar preflight <task>` is unchanged.

With the implemented gate on the same 1,764 prompts: **71 attached (was 793), 39 hits, 6 misses, 26 waste (was 374), precision 55% (was 19%)**. This reproduces the analysis exactly; it is in-sample, and the out-of-sample estimate above is 51%.

The gate limits the harm; it does not make automatic delivery pay for itself on conversational prompts. The agent rule (`pull`: the agent calls `stellar context` when it decides it needs to) remains the recommended path. The hook suits prompts that name the code they are about.

## Effect on the benchmark

On the 48 v0.7 holdout tasks the strict hook attaches to 11 (mac-kvm 4, serialwrap 6, vigorplus 0, motocam 1). The task prompts describe behavior without naming code, by design. The `hook` condition therefore now measures mostly no attachment; the v0.8 measurements (`HOOK_RESULT.md`, `HOOK_GUIDANCE_RESULT.md`) describe the ungated hook, available as the benchmark condition `hook-any`.

## Limits

- One developer's prompts. Another person's prompts, or another language, can differ.
- The repositories are at their current commit, not the commit each prompt was typed against.
- The label is coarse: a hit can be coincidental (the turn edits a file that happened to be attached), and a turn that only searched counts as touching no source.
- The saving per useful attachment comes from the benchmark, not from real sessions.
