# v0.7 Rust / Kotlin / Swift lexical tier: holdout result

Plan: `HOLDOUT_PLAN.md` (pre-registered in `9460b91`, task sets frozen in `7a19d81`). Runtime `7a19d81` (source identical to `901ebed`), `changedDuringCampaign=false` for all three campaigns. 216 runs, all exit 0. Agent: Claude CLI 2.1.322.

## Verdict against the pre-registered targets

| Target | Result | Verdict |
|---|---|---|
| Correctness gate: answer and grounded success ≥ baseline, per repository | 36/36 answers in every cell; grounded 36→36, 36→36, 35→36 | **met** |
| Primary: input tokens, repo-median reduction ≥ 10% | 7.5% | **missed** |
| Secondary: tool calls, repo-median reduction ≥ 15% | 20.0% | met |
| Secondary: search calls, repo-median reduction ≥ 15% | 49.5% | met |

## Per repository (`baseline` → `stellar`, 36 paired runs each)

| | mac-kvm (Swift) | serialwrap (Rust) | vigorplus (Kotlin) |
|---|---|---|---|
| Input tokens | 7.15M → 5.50M (−23.2%) | 7.22M → 6.68M (−7.5%) | 7.40M → 7.24M (−2.1%) |
| Tool calls | 260 → 154 (−40.8%) | 251 → 218 (−13.1%) | 255 → 204 (−20.0%) |
| Search calls | 121 → 45 (−62.8%) | 111 → 56 (−49.5%) | 123 → 73 (−40.7%) |
| Cost | $16.09 → $12.16 (−24.4%) | $16.94 → $15.61 (−7.9%) | $15.28 → $14.52 (−5.0%) |
| Answered with no tool call after the context | 9 of 36 | 0 of 36 | 0 of 36 |
| Expected files delivered by the context | 57 of 102 (56%) | 48 of 99 (48%) | 24 of 105 (23%) |
| Runs with every expected file in the context | 15 of 36 | 12 of 36 | 3 of 36 |

Pooled over the 36 tasks (paired bootstrap over tasks, 95%): input −10.8% [2.8, 18.3], tool calls −24.8% [15.7, 34.0], search calls −51.0% [41.5, 60.1], cost −12.5% [5.2, 19.7] ($48.30 → $42.29).

## Input tokens by category

| | mac-kvm | serialwrap | vigorplus |
|---|---|---|---|
| navigation | −33.3% | +9.5% | −6.9% |
| flow | −12.1% | −14.2% | +14.8% |
| impact | −43.9% | −17.2% | −24.2% |
| editing-prep | −7.9% | +4.2% | +12.1% |

## Catastrophic regressions (task median over repetitions)

No correctness loss. Six tasks crossed a cost threshold:

| Repo | Task | Flag | Input | Tool calls |
|---|---|---|---|---|
| mac-kvm | edit-barrier-protocol-revision | input +25% | 168K → 227K | 5 → 6 |
| serialwrap | add-nul-text-terminator-choice | input +25% | 171K → 218K | 8 → 6 |
| serialwrap | add-csv-recording-download-format | tool calls > 2× | 179K → 173K | 3 → 8 |
| vigorplus | add-camera-to-device-picker | input +25% | 119K → 162K | 4 → 4 |
| vigorplus | add-megapascal-pressure-unit | input +25% | 124K → 165K | 6 → 6 |
| vigorplus | clip-route-onto-screen-map | input +25% | 171K → 293K | 7 → 7 |

Five of the six are editing-prep tasks.

## Reading

- The benefit follows how many expected files the context delivers. Swift, with type-mention edges, delivers 56% and saves 23% of input. Kotlin delivers 23% and saves 2%: the agent searches less (−41%) but the context call costs about as much as the searches it replaces.
- Kotlin's low delivery is consistent with its missing edges: references inside one package need no import and so produce no edge. This was a stated limit before the run; the run does not prove it is the cause.
- Editing-prep is the weakest category in all three repositories (context delivers 6/27, 9/30 and 9/27 expected files). These tasks ask for every exhaustive `match` / `when` / `switch` over a type, which needs "who uses this type" at symbol level; the lexical tier has no such relation.

## Limits

- One repository per language: a language effect cannot be separated from a repository effect.
- One agent. Baseline rows carry no per-turn telemetry, so model turns are not compared.
- The three campaigns ran concurrently on one machine.

Raw runs: `validation/v0.7/holdout/<repo>/claude-20261113-0949*/` (not committed).

## Follow-up: Kotlin same-package edges (`d65bd96`), not an unseen holdout

After the result above, Kotlin files were linked by same-package and wildcard-import name mentions (file pairs linked in vigorplus: 371 → 514). The frozen Kotlin task set was run again; it had been seen once by then.

**The re-run cannot be compared with the first run.** The agent model was not pinned: the first campaigns ran on `claude-fable-5-2`, the re-run on `claude-opus-5-5` (the CLI default changed in between). Baseline input alone moved from 7.40M to 9.03M.

Within the re-run (36 paired runs, all exit 0, `claude-opus-5-5`): input 9.03M → 8.44M (−6.5%, paired bootstrap 95% [−13.5, 22.4]), tool calls 300 → 218 (−27.3%), search calls 144 → 85 (−41.0%), answers and grounding 36/36 in both conditions. The input interval includes zero.

**Deterministic replay (no agent, no model).** The 12 context commands the agents issued in the first run were replayed against an index built by `901ebed` and one built by `d65bd96`:

| | `901ebed` | `d65bd96` |
|---|---|---|
| Expected files returned with source | 8 of 35 | 8 of 35 |
| Expected files only hinted | 3 | 1 |
| Tasks with every expected file | 1 of 12 | 0 of 12 |

One task gained an expected file, one navigation task lost its only one, two lost a hint.

**Conclusion.** The new edges do not change what the context delivers for these tasks. Kotlin's low delivery is not caused by missing same-package edges, as the first reading suggested; the expected files are not selected as targets in the first place, and neighbors of the wrong targets do not help. The limit is target selection for Kotlin questions, which this change does not touch.

Raw re-run: `validation/v0.7/rerun-kotlin-edges/vigorplus/claude-20261113-102851/` (not committed).

## Second Kotlin repository: motocam (plan `HOLDOUT_PLAN_KOTLIN2.md`)

Unseen repository, task set frozen in `bf19a42` before any run or replay. Runtime `bf19a42` (source identical to `d65bd96`). Model pinned to `claude-fable-5-2` and verified: all 587 model events in the raw logs carry it. 72 runs, all exit 0, `changedDuringCampaign=false`.

**Pre-registered classification: mixed.** Expected files delivered reached the 40% line; the input reduction did not reach 10% — input went up.

| | motocam (`baseline` → `stellar`) | vigorplus, first holdout |
|---|---|---|
| Expected files delivered by the context (replay) | 10 of 24 (42%) | 8 of 35 (23%) |
| Input tokens | 6.31M → 6.74M (**+6.8%**) | −2.1% |
| Tool calls | 207 → 178 (−14.0%) | −20.0% |
| Search calls | 102 → 65 (−36.3%) | −40.7% |
| Cost | $12.92 → $14.45 (**+11.9%**) | −5.0% |
| Answer success | 36 → 36 | 36 → 36 |
| Grounded success | 34 → 36 | 35 → 36 |
| Answered with no tool call after the context | 3 of 36 | 0 of 36 |

Paired bootstrap over tasks (95%): input +6.8% [−7.6, +21.8], tool calls −14.0% [−29.5, +2.6], search calls −36.3% [−56.5, −12.5], cost +11.9% [+2.2, +22.5]. The cost increase excludes zero; the input change does not.

Input by category: navigation +20.3%, flow −0.5%, impact +10.9%, editing-prep −2.1%. One task crossed a catastrophic threshold on cost (`add-fourth-rear-collision-sensitivity`, input +25%); no correctness loss.

Edge effect by replay: 9 of 24 expected files on an index without Kotlin same-package edges (`901ebed`), 10 of 24 with them.

**Reading.**

- vigorplus's low delivery (23%) was at least partly a repository effect: a second Kotlin repository reaches 42%, close to Rust's 48%.
- Delivery is not the whole story. motocam delivers almost as much as Rust and still costs more than the baseline. The baseline is cheap on this repository (207 tool calls and 6.31M input over 36 runs, against 251–260 and 7.2M on the first three), so there is less exploration to remove, while the context call adds its own tokens to every run.
- Across both Kotlin repositories the lexical tier lowers searching (−36% to −41%) and keeps or improves correctness, but does not lower input or cost.

Limits: two Kotlin repositories, both Android apps from one organization. Raw runs: `validation/v0.7/holdout/motocam/claude-20261113-113804/` (not committed).
