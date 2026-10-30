# M3 A/B Benchmark

`tasks.json` defines the minimum 12-task suite from the MVP spec.

Record one JSON object per task for baseline and StellarCode-assisted runs:

```json
{"taskId":"bug-01","success":true,"discoveryToolCalls":18,"discoveryTokens":9200,"firstRelevantMs":8200,"filesOpened":11}
```

Then run:

```bash
stellar benchmark report baseline.jsonl stellar.jsonl
```

Acceptance thresholds:
- discovery tool calls reduced >= 50%;
- discovery tokens reduced >= 40%;
- median time to first relevant file reduced >= 50%;
- success-rate delta >= -5 percentage points.

The example telemetry files are synthetic and only validate/report the calculation pipeline.
