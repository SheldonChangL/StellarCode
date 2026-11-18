# v0.8.6 hint and gate precision: result

The two-turn agent campaign (`../followup/RESULT.md`, PR #18) found two precision problems. Both fixes were measured on the real-prompt set with the hook's settings (`--hook --strict --hints`): developed on dev, then the chosen change scored once on the holdout, baseline and change together. Deterministic and local; no agent was run.

## 1. Session hints: test files and hub files

In the campaign, 6 of 37 hints were test files and most others were hubs: files linked to much of the project, such as the app's composition root or a crate's `lib.rs`. None of them was a follow-up's answer.

Hub was defined as a file linked (imports, tests, references, either direction) to at least max(8, share × indexed files) files. Dev, 309 prompts:

| Variant | reachNew | Hints given | Later touched |
|---|---|---|---|
| v0.8.5 (baseline) | 23.9% | 334 | 110 (33%) |
| without test files | **24.6%** | 337 | 111 (33%) |
| without hubs, share 5% | 17.8% | 318 | 69 (22%) |
| without hubs, share 8% | 21.4% | 330 | 88 (27%) |
| without hubs, share 12% | 22.3% | 338 | 99 (29%) |

Leaving out hubs makes hints worse on real sessions: hubs are often touched later, because real work goes on to edit them (wiring a feature into the composition root). The campaign's follow-ups asked read-only navigation questions, where hubs are not the answer. Hub filtering was not kept.

Leaving out test files lost no reached turn on dev: +0.6 pts [−1.0, 2.3]. **Kept**: hints skip test files (the index's test-path rule); `sessionHints: { tests: true }` and `score.mjs --hint-tests` keep them.

## 2. The strict gate and common-word file stems

In the campaign, three vague follow-ups passed the strict gate because ordinary words ("daemon", "device", "server", "request") are file stems in that repository. The tried fix: a list of 46 generic stems and symbol names (server, request, service, lib, mod, ...) that count as naming code only when the prompt writes them as code (backticks, `name.ext`, `name(`).

| | Dev | Holdout (156 prompts) |
|---|---|---|
| Turns with attached source changed | 0 | 3 lost |
| hitNew | 2.9% → 2.9% | 6.4% → 5.1%, −1.3 pts [−3.2, 0.0] |
| Attached characters | unchanged | −13.3% |

On the campaign's prompts, the fix stopped all three leaks. It also stopped one turn-1 attachment that held one of two answer files; that run cost more than baseline. On the holdout it stopped three attachments, and two of them held the file the turn needed, named by "service" and by "server". In real prompts these words usually do point at the file of that name. The campaign's vague follow-ups were written for the test. **Not kept**: the holdout did not confirm it, and the gate is unchanged.

## Holdout record

One holdout run each for v0.8.5 and the combined change (test files left out and the generic-stem gate), logged in `holdout-log.jsonl`. Hints in the holdout: 197 given and 41 later touched, against 199 and 41 with the change. The kept part (test files) was not scored on the holdout separately.

## Limits

- One developer's sessions; the label is what the agent touched, edits included.
- Whether fewer test hints change what an agent spends was not measured: no agent was run. The campaign result stands: hints did not lower turn-2 cost, and whether they stay on by default is open.
