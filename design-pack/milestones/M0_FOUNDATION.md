# M0 — Foundation & Cross-platform Skeleton

## Objective

建立後續不希望重構的基礎：project identity、跨平台資料位置、SQLite lifecycle、CLI framework、migration、測試骨架。

## Deliverables

- `stellar` CLI executable.
- `stellar init`, `stellar status`.
- `.stellar/project.json` with UUID/schema.
- OS-standard data/cache/log path resolver.
- `registry.db` and per-project `index.db` creation.
- SQLite migration runner.
- project move/path refresh support.
- CI on macOS/Linux/Windows.

## Work packages

### M0-001 Monorepo
Create apps/packages structure, TypeScript config, lint/test/build scripts.

### M0-002 PlatformAdapter
Implement macOS/Linux/Windows directory and path normalization adapters.

### M0-003 Project identity
Create UUID project metadata, validate schema, never derive identity from absolute path.

### M0-004 Registry DB
Register project UUID -> current path, last seen time, DB location, status.

### M0-005 Per-project DB
Create/migrate isolated index DB.

### M0-006 CLI
Implement init/status and stable error codes.

### M0-007 Safety
Ensure init never touches user source beyond `.stellar/project.json`; support dry-run.

### M0-008 CI matrix
Run unit/integration tests on macOS, Ubuntu, Windows.

## Architecture gate

No package except `platform` may hardcode platform-specific application-data paths.

## Validation

- Initialize the same fixture on all three OS runners.
- Move repo to a new path; UUID remains the same and registry updates.
- Delete application-data DB and re-init without source loss.
- Re-running `stellar init` is idempotent.

## Exit criteria

- 100% pass on three-platform CI.
- No absolute project path written into `.stellar/project.json`.
- `stellar init` creates <= 2 KB repository-local metadata.
- No source file modification outside `.stellar/`.
