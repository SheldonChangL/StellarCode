# v0.5 Implementation Status

Status: **implemented and regression-tested**.

## Acceptance matrix

| Capability | Status | Validation |
|---|---|---|
| Global registry migration | PASS | existing schema extended in place |
| Multiple registered repos | PASS | end-to-end two-repo CLI run |
| `stellar projects` | PASS | registry summaries + counts |
| One global UI server | PASS | HTTP integration test |
| Project switching | PASS | `/project/<uuid>` |
| Lazy sync on project access | PASS | newly added file appears without manual scan |
| Active/idle lifecycle | PASS | access timestamps + reconciliation |
| Deleted root detection | PASS | global query returns 404; status becomes missing |
| Missing -> orphaned | PASS | simulated grace-period regression |
| Moved repo recovery | PASS | UUID path refresh test |
| Global MCP | PASS | discover + query by UUID outside repo |
| Conservative GC | PASS | default preserves index |
| Explicit purge | PASS | orphan purge regression |
| Home-directory crawling | NOT USED | registered paths only |
| Per-project always-on watchers | NOT USED | lazy sync by design |

## Test command

```bash
npm test
```

See `docs/TEST_REPORT_V0.5.txt` for the packaged run.
