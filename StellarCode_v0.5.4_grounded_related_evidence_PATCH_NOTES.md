# StellarCode v0.5.4 Grounded Related Evidence Patch

Base commit: `24ca31e5a9f0b98a476cfc9ca950a7cd07d2f9d9`

## Apply

```bash
git status
git rev-parse HEAD
git apply --check /path/to/StellarCode_v0.5.4_grounded_related_evidence.patch
git apply /path/to/StellarCode_v0.5.4_grounded_related_evidence.patch
npm test
```

If tests pass, inspect and commit normally.

## Main changes

- JS/TS named import bindings and aliases become imported-symbol `references` edges.
- Arrow-function and Python symbol ranges are more accurate.
- Adds `INDEXER_VERSION`; stale semantic indexes auto-rebuild on the next sync/query.
- Related neighbors are ranked before limiting and preserve incoming/outgoing direction.
- Compact context separates:
  - `targets`: primary source targets
  - `relatedEvidence`: bounded related source that is actually grounded
  - `relatedHints`: navigation-only metadata
  - `groundedFiles`: paths whose source was embedded
- Related evidence is only emitted when the imported local binding is actually used inside the selected primary symbol range.
- `depth=0` never auto-attaches related evidence.
- MCP and agent rules understand the same grounded-evidence contract.
- Benchmark prompt understands `relatedEvidence` / `relatedHints` and avoids re-reading embedded ranges.
- Benchmark aggregate uses comparable paired runs only; interrupted/provider-failed pairs are reported as coverage gaps.
- Report exposes `correctnessPass`, `efficiencyPass`, and `overallPass`; `passGate` now aliases overall pass.

## Validation performed here

- `git apply --check`: PASS against a clean reconstructed `24ca31e` affected-file baseline.
- `git diff --check`: PASS.
- `node --check`: PASS for every changed/new JS file.
- New benchmark tests: 3/3 PASS.
- New integration tests: 8/8 PASS using the complete retained v0.5.2 runtime plus the current affected code overlay.

This environment cannot directly clone GitHub, so run the repository's current full `npm test` suite on the real `24ca31e` checkout before committing.
