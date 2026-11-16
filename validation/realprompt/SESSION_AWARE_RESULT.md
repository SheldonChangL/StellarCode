# v0.8.2 session-aware delivery: result

Measured on the real-prompt evaluation set (`README.md`): developed on dev, then confirmed once on the holdout, baseline and change together. Deterministic and local; no agent was run.

## Finding

In follow-up turns the agent mostly works on code it already has: on dev, 74% of turns with an earlier turn in the session touched a file touched in the last two turns. StellarCode attached such files again: 34% of the files attached in follow-ups were already in the session. A repeated file is new cache writes for nothing.

Counting only files the turn newly needed (`hitNew`), retrieval is useful in new conversations (dev 42.9%, holdout 46.3%) and weak in follow-ups (13.0%, 19.1%).

## Change

The Claude Code hook reads the session transcript it receives (`transcript_path`) and leaves out of the attachment every file the agent already read, edited or wrote in the session (tool calls with a file path, and paths in shell commands). When nothing else is left, nothing is attached (`already-in-context`). The strict gate judges match strength and naming on everything found, including files already seen, so a prompt that names a file the agent already has still counts as naming the code.

Reading a 20 MB transcript takes about 125 ms.

## Variants on dev (309 prompts)

| Variant | Delivered | hitNew | Attached characters |
|---|---|---|---|
| no gate | 69.3% | 18.4% | 2,288,775 |
| no gate, drop seen files | 65.7% | **18.4%** | 1,684,019 (−26%) |
| no gate, skip when a file would repeat | 31.1% | 11.7% | 933,569 |
| hook (limit + strict gate) | 6.1% | 2.9% | 166,331 |
| hook, drop seen files | 5.8% | **2.9%** | 112,173 (−33%) |

Skipping the whole attachment loses useful files (18.4% → 11.7%) and was rejected. Dropping seen files keeps every useful file. A first version judged naming after dropping and lost one useful attachment under the strict gate; judging it on everything found restored it. Paired difference in `hitNew` for both drop variants: 0.0 points [0.0, 0.0].

## Holdout confirmation (156 prompts, scored once)

| Variant | Delivered | hitNew | Attached characters |
|---|---|---|---|
| no gate | 68.6% | 26.3% | 1,643,500 |
| no gate, drop seen files | 65.4% | **26.3%** | 1,270,288 (**−23%**) |
| hook (limit + strict gate) | 16.0% | 6.4% | 227,513 |
| hook, drop seen files | 13.5% | **6.4%** | 133,226 (**−41%**) |

`hitNew` is unchanged (paired difference 0.0 [0.0, 0.0]) and attached characters fall by 23% and 41%. In the hook, 44.6% of attached files were already in the session before the change.

## Limits

- One developer's sessions. The label is what the agent touched.
- Characters are a proxy for cost: an attached character becomes a cache write once and a cache read on every later turn.
- A file path in a shell command is attributed to the project by resolving it from the command's working directory; a command that changes directory first can make a file count as seen when it was not.
