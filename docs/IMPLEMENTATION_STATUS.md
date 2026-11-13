# M0–M3 Implementation Status

Legend: ✅ implemented + locally tested, 🟡 implemented but needs external/platform validation, ⚠ deliberate MVP substitution.

## M0 Foundation

| Requirement | Status | Evidence |
|---|---|---|
| CLI executable/init/status | ✅ | `src/cli.js`, tests |
| Stable UUID metadata | ✅ | `.stellar/project.json` logic |
| OS-standard paths | ✅ | path adapter unit tests |
| Registry + per-project DB | ✅ | SQLite storage tests |
| Move/path refresh | ✅ | automated move test |
| Idempotent init | ✅ | automated test |
| macOS/Linux/Windows CI | 🟡 | workflow included; build environment ran Linux only |

## M1 Index Engine

| Requirement | Status | Evidence |
|---|---|---|
| Scanner/ignore/hash | ✅ | scanner + fixture tests |
| TS/JS/Python parsing | ✅ | golden fixture extraction |
| Rust/Kotlin/Swift parsing | ⚠ | lexical tier only: symbols, ranges and file dependencies (imports; for Swift, type mentions) (`tests/v07-brace-languages.test.js`); no semantic edges |
| Tree-sitter specifically | ⚠ | replaced in this self-contained MVP by deterministic lightweight parsers |
| Import/test/reference graph | ✅ | graph tests |
| Reverse dependencies | ✅ | related/impact tests |
| Git metadata/activity/rename hints | ✅ | implementation; Git-backed fixture |
| Incremental add/modify/delete | ✅ | automated test |
| Full vs incremental equivalence | ✅ | canonical graph equality test |
| Importance score | ✅ | computed after graph rebuild |
| Zero-token indexing | ✅ | no LLM/network dependency |
| 10k-file performance target | ✅ | synthetic 10,000-file Git repo: warm no-change 163 ms in the final reproducible delivery run; reproducible script included |

## M2 Universe UI

| Requirement | Status | Evidence |
|---|---|---|
| Real graph UI | ✅ | Canvas UI reads `/api/graph` |
| Folder clustering | ✅ | deterministic cluster layout |
| Search/focus/detail | ✅ | UI + API tests |
| Impact mode | ✅ | UI + query endpoint |
| Changes view | ✅ | recorded incremental change events |
| Reduced motion | ✅ | CSS media query |
| 5k-node browser performance gate | 🟡 | graph limit/LOD behavior included; browser perf benchmark pending |
| Three.js/WebGL | ⚠ | implemented with dependency-free Canvas 2D for MVP portability |

## M3 AI Gateway

| Requirement | Status | Evidence |
|---|---|---|
| MCP stdio server | ✅ | protocol tests |
| Six MCP tools | ✅ | list/call test |
| Compact payload budgets | ✅ | default result limits, no source bodies |
| Deterministic context recommender | ✅ | query test |
| Agent rule installer | ✅ | opt-in init flag |
| Benchmark harness/reporter | ✅ | automated report test |
| 12-task benchmark definition | ✅ | `benchmark/tasks.json` |
| Real Claude/Codex A/B threshold proof | 🟡 | requires external agent runs/telemetry; example report is synthetic |

## MVP delivery interpretation

All M0–M3 **software components** needed to run the MVP are present. Two acceptance checks cannot be truthfully certified in this container alone: real Windows/macOS execution and real Claude/Codex A/B token telemetry. Those are explicitly left as validation gates, not silently treated as passed.
