# Validation & Benchmark Plan

## Product hypothesis

StellarCode is successful only if it measurably reduces repository-discovery cost while preserving or improving task completion quality.

## Benchmark design

Use the same repository snapshot, model, task prompt, tool permissions, and completion criteria in two conditions:

- **A — Baseline:** normal filesystem/search tools.
- **B — StellarCode:** Stellar MCP available and rule instructing the agent to query it first.

Run each task multiple times if model nondeterminism is material.

## Metrics

### Primary
- Discovery tool call count.
- Discovery-related input tokens.
- Time to first relevant file.
- Number of irrelevant files opened.
- Task success rate.

### Secondary
- Total input tokens.
- Total tool calls.
- Time to working patch.
- Number of regressions.
- Whether tests selected were relevant.

## MVP thresholds

StellarCode should demonstrate across the benchmark set:

- >= 50% reduction in discovery tool calls;
- >= 40% reduction in discovery input tokens;
- >= 50% reduction in median time to first relevant file;
- no statistically meaningful reduction in task success rate.

## Benchmark task categories

1. Locate implementation of a named user-visible behavior.
2. Fix a bug that spans 2–4 related files.
3. Add a small feature to an existing module.
4. Identify affected tests before modifying a core file.
5. Trace an import/dependency chain.
6. Find a likely regression introduced by a recent change.

## UI validation

Human test participants should be able to:

- identify the largest/core module in <= 30 seconds;
- explain a selected file's purpose and direct dependencies in <= 30 seconds;
- locate a named symbol in <= 20 seconds;
- identify direct impact scope in <= 30 seconds.

## Correctness checks

- Parse known fixture repositories and compare extracted symbols/imports to golden files.
- Incremental update output must equal a full reindex of the same final repository state.
- Delete/rename tests must not leave dangling graph edges.
- Project move must retain project identity through UUID.
- Corrupt project DB must be recoverable by project-only reindex.
