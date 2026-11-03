# Benchmark Task Authoring

The benchmark is only as credible as its task set.

## Good tasks

Use questions a developer genuinely asks before changing code:

- Where is production login implemented?
- Which files implement password reset end-to-end?
- Where does the LLM provider selection happen?
- Which module owns API-token validation?
- What file should be changed to alter a specific business rule?
- Which test covers a known production behavior?

Each task should have at least one maintainer-verified `expectedFiles` entry.

## Avoid benchmark leakage

Do not generate the answer key by running StellarCode and copying its top result. Build answer keys from known code ownership, tests, commit history, issue fixes, or manual inspection. Otherwise the benchmark becomes circular.

Do not mention the expected path in the prompt.

Bad:

```text
Find login in src/actions/auth.ts.
```

Good:

```text
Find the production login implementation and explain where credentials are verified.
```

## Recommended suite

Use 10–20 tasks per repository:

- 30% direct feature location;
- 25% multi-file flow tracing;
- 20% test-to-implementation location;
- 15% architecture/core-module discovery;
- 10% intentionally absent concepts to test false-positive behavior.

Run at least three repeats per task/condition when quota permits.

## Categories (v0.5.5)

Give every task an explicit `category`: `navigation`, `flow`, `impact` or `editing-prep`.
Choose it from what the prompt actually asks, not from the task id:

- `navigation`: locate an implementation, entry point or owner;
- `flow`: trace behavior across modules (caller → callee, producer → consumer);
- `impact`: what depends on or breaks if something changes;
- `editing-prep`: identify what to read before modifying code.

A task without a category is treated as legacy `navigation`. The report shows each
category separately and lists the runtime-classified intent next to it; the category is
never given to the agent or to StellarCode. See `docs/V0.5.5_CONTEXT_PRECISION.md`.

## Correctness

`expectedMatch: "any"` means at least one answer-key file must appear in the agent's final `files` list.

`expectedMatch: "all"` requires every answer-key file.

Use `all` only when the task genuinely requires all listed files; otherwise it can punish a correct concise answer.

## What v0.5.1 does not benchmark

The runner is intentionally read-only. Do not use tasks such as "implement feature X" or "fix bug Y" yet. Those require a separate edit-quality benchmark with tests/build outcomes in addition to token usage.

## v0.5.2 grounding note

The v0.5.2 benchmark does not accept a correct-looking file name unless the run also reads answer-key source. Keep `expectedFiles` focused on files that actually contain the implementation evidence an agent should inspect. Avoid using barrel files or metadata-only files as the sole answer key when the task asks about implementation behavior.
