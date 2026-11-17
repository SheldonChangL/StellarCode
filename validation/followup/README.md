# Two-turn agent benchmark (v0.8.5)

Session-aware delivery (v0.8.2) and session hints (v0.8.3, v0.8.4) act only in a follow-up turn: they read the conversation's transcript. A one-prompt benchmark cannot see them. The real-prompt evaluation set (`../realprompt/`) measures what they reach, not what an agent does with it. This benchmark runs a real agent for two turns of one conversation.

## Method

`stellar benchmark run <repo> --agent claude --mode baseline,hook,hook-nohints --follow-up --model MODEL`

- **Turn 1** is the existing benchmark run of the task's `prompt` (unique run line, fresh worktree, read-only index snapshot).
- **Turn 2** resumes the same Claude Code session (`--resume`) with the task's `followUp.prompt`, followed by a reminder of the JSON answer format. With a hook condition the CLI runs the product hook again, now with a transcript that shows what turn 1 read, as in real use.
- Each row records the turn's own usage and cost. Turn 1 rows go to `<condition>.jsonl` as before; turn 2 rows go to `<condition>-followup.jsonl` and carry `firstTurnCostUsd`.

Task format: an optional `followUp` next to `prompt`. Its expected files are the turn-2 answer key; they are never shown to the agent or to StellarCode.

```json
{ "id": "lockout", "prompt": "…", "expectedFiles": ["…"],
  "followUp": { "prompt": "…", "expectedFiles": ["…"], "expectedMatch": "any" } }
```

Conditions:

| Condition | Turn 2 |
|---|---|
| baseline | no StellarCode |
| hook-nohints | hook with session-aware delivery, without session hints (`--session-hints off`) |
| hook | the product hook: session-aware delivery and session hints |

`hook` vs `hook-nohints` isolates the hints. `hook` vs `baseline` measures the whole delivery path over a conversation.

Turn 2 fields: cost and token usage, model turns, tool and search calls, `filesOpenedList`, `newFilesRead` and `rereadFiles` (against turn 1), answer and grounding against the follow-up's expected files (grounded if read in either turn or attached in turn 2), and for hook conditions `hookDelivered`, `hookChars`, `hookSourceFiles`, `hookHints`, `hintsRead` (hints the agent then read) and `hintsExpected` (hints in the answer key). The attachment is read from the CLI's own session transcript, after the turn's start time.

## Found while building it

The hook could hint a file whose source it had attached in an earlier turn of the same session: the transcript shows an attachment, not a read, so the file was not counted as seen. Hints now skip files with an excerpt delivered earlier in the session. On the real-prompt dev split `reachNew` is unchanged (23.9%) and three more hints are given in their place (331 to 334).

## Status

Harness only; no campaign has been run yet. Planned first campaign: two repositories, about six tasks each with a follow-up that names no code (as most real follow-ups do), one repetition, a pinned model. The primary measure is turn-2 cost, `hook` against `hook-nohints`, then against `baseline`.
