# StellarCode v0.4 Implementation Status

## Completed

### Universe UX rewrite
- Galaxy → Module → File hierarchy.
- Default global edge suppression.
- Deterministic canvas layout and starfield.
- Breadcrumb navigation.
- Search-to-file deep navigation.
- Floating file inspector.
- File architecture role badges.
- Cross-module external relation satellites.
- Focus relation highlighting.
- Bounded Impact visualization.
- Changes view retained.
- Responsive and reduced-motion CSS retained.

### Architecture classification
- App Entry vs Module Entry separation.
- Domain Core, Service, UI, Infrastructure, Test, Config, Docs, Source roles.
- `package.json` entry/run hint parsing.
- Framework entry conventions for common JS/TS layouts.
- Distinct-module selection for structural core recommendations.
- New `stellar architecture` CLI surface.
- New `stellar_architecture` MCP tool.
- `/api/architecture` local Web API.

### CLI polish
- npm-installed `stellar` uses `bin/stellar.js`.
- Only the Node 22 `node:sqlite` ExperimentalWarning is suppressed in the end-user CLI wrapper.

## Automated verification

- 21 tests pass.
- v0.3 symbol-ID collision regression remains covered.
- Incremental/full-index equivalence remains covered.
- Chinese deterministic query expansion remains covered.
- No-evidence context behavior remains covered.
- v0.4 nested barrel classification is covered.
- v0.4 galaxy/module graph payload is covered.
- v0.4 architecture API is covered.
- v0.4 CLI warning wrapper is covered.

See `docs/TEST_REPORT_V0.4.txt`.

## Visual/scale verification

A synthetic 481-file / 19-module repository was used for local visual QA. No user source code is included in that fixture or the screenshots.

See `docs/V0.4_UI_QA.md` and `docs/screenshots/`.
