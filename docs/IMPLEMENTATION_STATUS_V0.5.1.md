# v0.5.1 Implementation Status

Status: **implemented and regression-tested; real savings percentage requires user-side authenticated agent runs.**

Delivered:

- `stellar benchmark init`
- `stellar benchmark doctor`
- `stellar benchmark run`
- `stellar benchmark report`
- Claude Code telemetry adapter
- Codex CLI JSONL telemetry adapter
- fresh-session / detached-worktree A/B isolation
- baseline StellarCode-disable shim
- pinned packaged-Stellar shim for assisted condition
- hidden answer-key correctness check
- input/cache/output token normalization
- tool/search/file/time telemetry
- paired run manifest
- JSON report
- standalone HTML report
- automatic evidence gate
- benchmark-specific StellarCode data directory isolation
- removal of installed Stellar agent rules inside temporary A/B worktrees

Automated suite: 31 tests at release preparation time.

Not claimed by this release:

- a numeric real-world token reduction percentage;
- editing-quality benchmark results;
- cross-model universal savings.

Those require running the included harness against authenticated Claude/Codex installations and representative user repositories.
