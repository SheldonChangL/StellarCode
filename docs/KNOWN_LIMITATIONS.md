# Known Limitations

1. **Parser scope.** The shipped parser is deterministic and dependency-free, not Tree-sitter. It targets common TypeScript/JavaScript/Python declaration/import syntax. Complex decorators, path aliases, conditional exports, macro/codegen patterns and exotic syntax can be incomplete.
2. **Module resolution.** MVP resolves relative TS/JS imports and common Python module paths. `tsconfig` aliases, package exports and framework-specific resolution are not yet modeled.
3. **Call graph.** Function call edges are not broadly inferred. MVP focuses on file imports, imported symbol references and tests.
4. **Node.js requirement.** Built-in `node:sqlite` requires Node 22.5+ and may print an experimental warning on Node 22.
5. **UI scale validation.** Payload limits and visual LOD are implemented, but a formal 5k-node browser performance benchmark is not included in this execution environment.
6. **M3 token proof.** The benchmark reporter is real; the bundled example telemetry is synthetic. Run the 12-task suite with your Claude/Codex workflow before claiming token savings.
7. **Daemon/watchers.** Global daemon + active-project watcher is M4. M0–M3 uses lazy sync before queries, avoiding per-repo background watchers.
