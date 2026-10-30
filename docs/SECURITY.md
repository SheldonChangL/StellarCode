# Security & Privacy

- StellarCode is local-first.
- `stellar serve` binds to `127.0.0.1` by default.
- MCP uses local stdio.
- Source bodies are not stored in the StellarCode database.
- Indexed data includes paths, hashes, line counts, symbols, short deterministic summaries, imports, graph edges and Git metadata.
- `.stellar/project.json` contains only a UUID and schema version; it never stores the absolute repo path.
- Source files are not modified by indexing. Only explicit `stellar init --install-agent-rule` may write an agent instruction file.
- M0–M3 makes no network/API/LLM calls.
