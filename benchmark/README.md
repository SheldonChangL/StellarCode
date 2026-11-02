# v0.5.1 Token Benchmark

Use the real runner instead of manually inventing telemetry:

```bash
stellar benchmark init
# edit .stellar/benchmark/tasks.json
stellar benchmark doctor --agent all
stellar benchmark run --agent codex --mode both --repeat 3
stellar benchmark run --agent claude --mode both --repeat 3
```

Each paired run creates `baseline.jsonl`, `stellar.jsonl`, `manifest.json`, `report.json`, and `report.html`.

`tasks.v051.example.json` is valid for the bundled sample fixture only.

The legacy `baseline.example.jsonl` / `stellar.example.jsonl` data is synthetic and exists only to test/report the calculation pipeline. `example-report-v051.*` is generated from that synthetic data and must not be cited as real product evidence.

See `docs/V0.5.1_TOKEN_BENCHMARK.md` and `docs/BENCHMARK_TASK_AUTHORING.md`.
