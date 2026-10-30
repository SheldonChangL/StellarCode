# Data Model

## Core entities

### Project

```text
project_id UUID PK
display_name TEXT
repo_path TEXT
created_at DATETIME
last_seen_at DATETIME
last_indexed_head TEXT
graph_version INTEGER
schema_version INTEGER
```

### File

```text
file_id TEXT PK          # project-relative stable key/path identity
path TEXT UNIQUE
name TEXT
extension TEXT
language TEXT
size_bytes INTEGER
line_count INTEGER
content_hash TEXT
modified_at DATETIME
summary TEXT NULL
summary_hash TEXT NULL
importance REAL
is_test BOOLEAN
is_generated BOOLEAN
```

### Symbol

```text
symbol_id TEXT PK
file_id TEXT FK
qualified_name TEXT
name TEXT
kind TEXT
start_line INTEGER
end_line INTEGER
exported BOOLEAN
signature TEXT NULL
summary TEXT NULL
```

### Edge

```text
edge_id TEXT PK
source_id TEXT
target_id TEXT
edge_type TEXT
weight REAL
confidence REAL
source_file_id TEXT NULL
metadata_json TEXT NULL
```

Supported MVP edge types:

- `contains`
- `imports`
- `references`
- `tests`
- `calls` when deterministically available
- `extends`
- `implements`

Post-MVP:

- `cochange`
- `decision_related`
- `change_related`

### ChangeEvent

```text
change_id TEXT PK
occurred_at DATETIME
source TEXT              # working-tree / commit / agent-record
reason TEXT NULL
commit_sha TEXT NULL
metadata_json TEXT
```

### ChangeFile

Maps `ChangeEvent` to files with added/deleted line counts.

## Identity policy

- Project identity comes from `.stellar/project.json` UUID, not repository path.
- File path is project-relative.
- Rename detection should preserve history when confidence is high.
- Symbol IDs can be regenerated after structural changes; clients must not persist symbol IDs forever.

## Importance score

Initial heuristic:

```text
importance =
  0.30 * normalizedInboundReferences +
  0.20 * normalizedOutboundDependencies +
  0.20 * normalizedGitActivity +
  0.15 * normalizedSymbolCount +
  0.15 * graphCentrality
```

Weights are configuration, not schema.

## Summary policy

Summary is optional metadata, never required for search or graph correctness.

LLM-generated summaries must store `summary_hash = content_hash` so stale summaries can be detected. MVP may use deterministic summaries only.
