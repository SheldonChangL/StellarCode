# StellarCode development rules

- Keep repository indexing deterministic and zero-token.
- Never store source bodies in the project database.
- Platform-specific application-data paths belong only in `src/platform/`.
- Query/MCP responses should stay compact and never return full source by default.
- Preserve `.stellar/project.json` as tiny path-independent identity metadata.
- M0–M3 uses lazy sync; do not add one persistent watcher per repository.
