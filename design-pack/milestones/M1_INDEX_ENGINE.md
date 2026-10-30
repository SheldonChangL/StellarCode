# M1 — Repository Index Engine

## Objective

建立 StellarCode 的核心 deterministic repository graph。做到這階段，即使沒有 UI/AI，也能可靠查詢檔案、symbols、imports、reverse dependencies。

## Deliverables

- Filesystem scanner + ignore rules.
- Hash-based file state.
- Tree-sitter parsing for TypeScript, JavaScript, Python.
- File/folder/symbol graph.
- Import/export edges.
- Reverse dependency index.
- Git HEAD/status/history metadata.
- Incremental add/modify/delete/rename sync.
- Importance score.
- Query service for file/symbol/related.

## Work packages

### M1-001 Scanner
Binary filtering, generated-folder exclusions, language detection, configurable limits.

### M1-002 Parser abstraction
Language adapter contract and Tree-sitter integration.

### M1-003 TypeScript/JavaScript extraction
Functions, classes, methods, interfaces/types, imports/exports.

### M1-004 Python extraction
Functions, classes, imports, module exports where deterministic.

### M1-005 Graph builder
Build contains/imports/references/tests edges and reverse adjacency.

### M1-006 Git analyzer
HEAD, working tree, commit metadata, rename hints.

### M1-007 Incremental synchronizer
Transactional replacement of changed-file facts; affected-edge rebuild only.

### M1-008 Search/query
Name/path/symbol search, file detail, direct related graph.

### M1-009 Importance
Compute stable bounded importance score.

### M1-010 Golden fixtures
Small curated TS/JS/Python projects with known graph output.

## Zero-token gate

All M1 functionality must run with no LLM/API key configured.

## Validation

### Full vs incremental equivalence
For a fixture:

1. full index state A;
2. edit/add/delete/rename files;
3. incremental sync -> state B1;
4. delete index and full reindex -> state B2;
5. canonicalized B1 must equal B2.

### Parser precision
Golden expected symbols/imports must match >= 98% for supported fixture syntax.

### Performance target
On a representative 10k-source-file repo (excluding dependencies):

- warm no-change stale check <= 500 ms target;
- one-file incremental parse/update <= 1 s target;
- memory remains bounded and does not load all source content simultaneously.

## Exit criteria

- Incremental/full equivalence passes all fixtures.
- Unsupported syntax produces warning, not project failure.
- No LLM dependency.
- CLI can find a file/symbol and show direct dependencies from DB only.
