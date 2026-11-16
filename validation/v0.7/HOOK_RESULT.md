# v0.8 hook delivery on Rust / Kotlin / Swift: result

Plan: `HOOK_PLAN.md` (pre-registered in `686a5de`, which is also the runtime). 192 runs, **0 failed**, `changedDuringCampaign=false` for all four campaigns. Model pinned to `claude-fable-5-2` and verified: every model event in the raw logs carries it (387, 455, 438 and 358 events). All 96 pairs are valid.

## Correction (2026-11-16): the `prefetch` cost comparison

This result compares the hook's cost (−3.1%) with `prefetch`'s −17.3% from `DELIVERY_RESULT.md`. That figure is mostly a cache artifact (see the correction there): on repetition 1, where no earlier run is in cache, `prefetch` lowers cost by 6.4% [2.3, 10.3] and the hook by 2.2% [−4.4, 8.5]. The two come from different campaigns and their intervals overlap, so the hook is not shown to keep less of the cost saving than `prefetch`.

The hook's own cost numbers below are close to their repetition-1 values (the hook's attached context is not reused from cache across runs). On repetition 1, mac-kvm costs 18.4% more than `pull` [0.9, 36.5], from cache writes. Over both repetitions its `hook` runs read 3.25 files per run against 2.33 with `prefetch`, and re-read attached files 1.71 times per run against 0.92, with identical attached excerpts. Why this happens on Swift only is not known.

## Verdict against the pre-registered targets (`hook` vs `pull`)

| Target | Result | Verdict |
|---|---|---|
| Delivery check: `hookDelivered` ≥ 95% | 96 of 96 `hook` runs, read from the CLI's session transcripts | met |
| Primary: input tokens, repo-median reduction ≥ 10% | 15.1% | met |
| Correctness gate per repository: answer and grounded success ≥ `pull` | three repositories hold both; vigorplus answer 24 → 23, grounded 23 → 24 | **missed on one run** |

By the reading fixed in the plan this is not the clean "ship as is" outcome: the primary target is met, and the correctness gate is missed by one run.

The one answer failure: `camera-status-entry-readers`, repetition 1. The answer named three of the four expected files plus two files the prompt excludes; the fourth expected file was missing. The other repetition of the same task passed. In the same repository `pull` has one grounding failure that `hook` does not.

## Per repository (24 pairs each)

| | mac-kvm (Swift) | serialwrap (Rust) | vigorplus (Kotlin) | motocam (Kotlin) |
|---|---|---|---|---|
| Input tokens | −9.0% | −14.5% | −15.7% | −21.8% |
| Model turns | −14.8% | −17.6% | −16.2% | −20.2% |
| Tool calls | +20.6% | −5.9% | −20.0% | −18.5% |
| Search calls | +36.4% | +21.4% | +20.8% | +10.0% |
| Cost | **+14.8%** | +2.1% | −10.2% | −15.7% |
| `prefetch` input reduction (`DELIVERY_RESULT.md`, other campaign) | −27.0% | −26.8% | −13.5% | −16.9% |
| Characters attached, median / max | 8,062 / 9,780 | 9,299 / 9,798 | 7,978 / 9,017 | 9,201 / 9,777 |
| Source attached, median bytes (`pull` context median) | 6,069 (6,092) | 7,721 (8,243) | 5,904 (5,271) | 8,078 (11,576) |
| `hook` runs with no tool call at all | 2 of 24 | 0 of 24 | 0 of 24 | 2 of 24 |
| Tasks where `hook` costs more input (task median) | 3 of 12 | 3 of 12 | 1 of 12 | 1 of 12 |

Pooled over the 48 tasks (paired bootstrap over tasks, 95%): input −15.5% [9.9, 20.8], model turns −17.2% [13.1, 21.2], tool calls −7.6% [−15.2, +1.2], **search calls +21.4% [+7.7, +38.4]**, **cost −3.1% [−9.1, +3.4]** ($38.67 → $37.45).

One `hook` run of 96 ran `stellar context` again despite the rule.

## Reading

- The hook keeps the saved turn: model turns fall 17% and input 15.5%. Delivery is reliable (96 of 96).
- It keeps less than `prefetch` on Swift and Rust (9% and 14.5% against 27%), and as much or more on the two Kotlin repositories.
- **Cost does not fall.** The interval includes zero, and Swift costs 14.8% more. Token accounting explains it: cache reads fall (15.8M → 13.1M) but cache writes, which are priced far higher, do not (1.81M → 1.78M), and output is unchanged. `prefetch` lowered cost by 17.3% in its own campaign.
- **The agent searches more with the hook than with `pull`**, on every repository, and the pooled interval excludes zero. `prefetch` did not show this clearly (+10.4% [−2.9, +25.2]). The difference between the two paths is the size limit and the guidance: the hook's preamble is short and the rest is the agent rule, which lacks `prefetch`'s instruction to answer at once when the evidence covers the task. This is a hypothesis; it was not isolated.
- The character limit binds on serialwrap and motocam (median within 600 characters of the cap; motocam's source falls from 11.6 KB to 8.1 KB) and not on the other two. The repository where it binds most (motocam) has the largest saving, so the limit alone does not explain the weaker result on Swift.

## Limits

- 2 repetitions, not 3 (pre-registered, to stay inside the usage limit).
- The task sets have been run several times. Both conditions share the runtime.
- The `prefetch` comparison is across campaigns.
- The benchmark hands the hook the task text alone; a real user message is the user's own wording, which was not measured.

Raw runs: `validation/v0.7/hook/<repo>/claude-20261116-*/` (not committed).
