# StellarCode Project Plan

## MVP

**M0–M3** form the MVP. The goal is not merely to display a graph; the MVP must prove AI navigation efficiency.

### M0 — Foundation
Cross-platform project identity, storage, DB lifecycle, CLI skeleton.

### M1 — Index Engine
Deterministic source graph, supported-language parsing, Git metadata, incremental synchronization.

### M2 — Universe UI
Human exploration experience: galaxy, search, file inspector, focus, impact.

### M3 — AI Gateway & Validation
MCP tools, compact task context, agent rule, A/B benchmark. **MVP complete only after benchmark.**

## Post-MVP

### M4 — Daemon & Scale
One global daemon, active watcher policy, lazy sync fallback, GC, recovery.

### M5 — Advanced Intelligence
Co-change, change intent, architecture decisions, timeline, cross-repo graph, optional semantic summaries.

## Dependency graph

```text
M0
 |
 v
M1 --------------------+
 |                      |
 v                      v
M2                     M3
 |                      |
 +----------+-----------+
            |
         MVP Gate
            |
            v
           M4
            |
            v
           M5
```

M2 and most of M3 can proceed in parallel once M1 query contracts stabilize.
