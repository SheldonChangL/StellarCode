# Implementation Handoff

## Recommended first build order

1. M0 project identity/storage/platform adapter.
2. M1 scanner + SQLite + TypeScript parser.
3. M1 incremental equivalence tests before adding more languages.
4. M1 query service.
5. M2 static graph payload + UI shell.
6. M2 focus/search/impact interactions.
7. M3 MCP wrappers over existing query service.
8. M3 benchmark harness and A/B validation.

Do not begin with the 3D renderer. The graph contracts and incremental index correctness are the critical path.

## Suggested issue convention

Each issue should include:

- goal;
- inputs/outputs;
- interfaces changed;
- deterministic test fixture;
- acceptance criteria;
- non-goals;
- platform notes.

## Engineering rules

- No LLM call may be required to keep index correctness.
- Do not duplicate full source files into the index DB.
- No platform path constants outside PlatformAdapter.
- Query APIs return bounded data by default.
- Incremental final state must equal full reindex final state.
- DB changes are transactional and versioned.
- Parser failure is isolated to the affected file.
- UI does not access SQLite directly.

## Suggested initial repository layout

```text
apps/cli
apps/web
apps/daemon
packages/core
packages/platform
packages/scanner
packages/parser
packages/git
packages/graph
packages/storage
packages/query
packages/mcp
packages/benchmark
packages/shared
fixtures/
tests/
```

## Prompt for a coding agent

Use this design pack as the source of truth. Implement one milestone at a time. Do not skip milestone exit criteria. When a design ambiguity appears, prefer the principles in `README.md` and `docs/00_PRODUCT_VISION.md`: local-first, zero-token maintenance, deterministic graph correctness, incremental synchronization, bounded AI responses, and repository-as-source-of-truth.

Before merging any milestone:

1. run unit and integration tests;
2. run incremental/full-index equivalence fixtures when M1 or later;
3. verify no repository source was copied into application-data storage;
4. verify macOS/Linux/Windows path behavior when platform code changed;
5. update architecture docs only if implementation intentionally changes a contract.
