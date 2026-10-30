# M4 — Global Daemon, Scale & Reliability

## Objective

把 MVP 從「可驗證」提升為「日常長期裝在開發機上不煩人」。解決多 repository、background resource、crash recovery、storage growth。

## Deliverables

- One global daemon per user.
- Project lifecycle: active/idle/archived.
- Active-project file watching.
- Lazy sync correctness fallback.
- IPC abstraction: Unix socket / Windows named pipe.
- Resource quotas.
- `stellar gc`, `stellar prune`.
- Crash recovery and DB integrity checks.
- Schema migration/reindex strategy.

## Daemon policy

Do **not** run one watcher/process per repository.

```text
stellar-daemon
├── active project A -> watcher
├── active project B -> watcher
├── idle project C   -> no watcher
└── archived D       -> no watcher
```

## Suggested activity policy

A project becomes active when:

- MCP request resolves to it;
- web UI opens it;
- CLI query targets it.

Suspend watcher after configurable inactivity, e.g. 20–30 minutes. Correctness is preserved by lazy stale check on next query.

## Storage management

- One DB per project.
- Global cache quota.
- Per-project cache quota.
- Orphan detection when repo path no longer exists.
- Cache data is deletable; index is rebuildable.
- Never delete source repository data.

## Validation

- Register 100 fixture projects; daemon process count remains one.
- Only configured max active watchers remain live.
- Idle projects consume negligible CPU.
- Simulated daemon crash does not corrupt committed graph.
- Schema migration failure can fall back to per-project reindex.

## Exit criteria

- Background idle CPU near-zero under normal use.
- No unbounded watcher/process growth.
- Storage report and cleanup commands are accurate.
- Recovery from killed process passes integrity tests.
