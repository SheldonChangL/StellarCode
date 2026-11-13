# v0.7 second Kotlin repository: holdout plan (pre-registered before any run on it)

## Question

In the first holdout the Kotlin repository (vigorplus) saved 2.1% of input and its context delivered 23% of the expected files, against 56% for Swift and 48% for Rust. With one repository per language, a language effect could not be separated from a repository effect. Does a second Kotlin repository behave like vigorplus?

## Setup

Same protocol as `HOLDOUT_PLAN.md` unless stated here.

| | |
|---|---|
| Repository | motocam: single-module Android app, 120 production Kotlin files, commit `28338fd4cc1ca2026fbfc87f856806ad764073fb` |
| Never used | Not used for any development, tuning, parsing check or query before this plan. Only file counts and sizes were read. |
| Conditions | `baseline`, `stellar` (pull delivery), 3 repetitions |
| Runtime | this branch (source identical to `d65bd96`: lexical tier plus Kotlin same-package edges) |
| Agent model | pinned to `claude-fable-5-2`, the model of the first holdout, and verified in the raw events after the run |
| Tasks | 12 (3 per category), fresh author plus independent reviewer, lint clean, sha256 frozen before any run or replay |

## Measurements

1. **Deterministic replay, no agent.** Each task prompt is sent once to `stellar context`. Reported: expected files delivered with source, and the rank of each expected file among non-test candidates. Also replayed against an index built by `901ebed` (no Kotlin same-package edges) to read the edge effect.
2. **Agent A/B.** Input tokens, tool calls, search calls, cost, answer and grounded success, paired by task and repetition.

## Pre-registered reading

No pass/fail threshold; this run answers a classification question, fixed now:

| Outcome on motocam | Reading |
|---|---|
| Expected files delivered ≥ 40% and input reduction ≥ 10% | vigorplus was a repository effect; the Kotlin tier works about as well as Rust and Swift |
| Expected files delivered ≤ 30% and input reduction < 5% | consistent with a Kotlin (or Android-app) limit of the lexical tier |
| Anything else | mixed; reported as such |

Correctness gate as before: answer and grounded success of `stellar` ≥ `baseline`.

## Limits

Two Kotlin repositories from one organization, both Android apps: an Android-app effect cannot be separated from a Kotlin effect.
