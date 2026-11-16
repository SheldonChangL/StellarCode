# v0.8 hook guidance: result

Plan: `HOOK_GUIDANCE_PLAN.md` (pre-registered in `8803d41`, which is also the runtime for both campaigns). 96 runs on mac-kvm (Swift) and serialwrap (Rust), 2 repetitions. Model pinned to `claude-fable-5-2` and verified in the raw events.

**6 runs failed**, all with the account's 5-hour usage limit (`api_error: usage_limit_reached`, zero tokens, under 4 seconds): mac-kvm `hook-brief` 2 and `hook` 1, serialwrap `hook-brief` 2 and `hook` 1. They fall on 4 pairs, all in repetition 2. **44 of 48 pairs are valid** (22 per repository); every valid run has `hookDelivered` true. Only valid pairs are used below.

## Verdict against the pre-registered targets (`hook` with full guidance vs `hook-brief`)

| Target | Result | Verdict |
|---|---|---|
| Search calls reduced ≥ 15% | 16.0% [2.1, 28.3] (100 → 84) | met |
| Cost reduced, interval excluding zero | 4.8% [−2.1, 11.7] ($17.81 → $16.95) | **missed** |
| Input tokens not higher | 3.5% lower [−6.3, 12.0] | met |
| Correctness ≥ `hook-brief` on each repository | 22 of 22 answers and 22 of 22 grounded, both conditions, both repositories | met |

By the reading fixed in the plan this is "searches fall but cost does not": **the full guidance stays the default, and the cost question is not answered by guidance.**

## Per repository (22 pairs each, full guidance relative to brief)

| | mac-kvm (Swift) | serialwrap (Rust) |
|---|---|---|
| Search calls | +2.6% (39 → 40) | −27.9% (61 → 44) |
| Tool calls | −1.8% | −17.0% |
| Model turns | −1.4% | −4.9% |
| Input tokens | −0.1% | −6.3% |
| Cache-write tokens | +1.3% | −10.1% |
| Output tokens | −0.1% | −8.5% |
| Cost | +0.9% | −9.5% |
| Source attached, median bytes (brief → full) | 6,070 → 5,532 | 7,721 → 7,347 |
| Characters attached, median (brief → full) | 8,062 → 8,213 | 9,299 → 9,583 |

Pooled over the 24 tasks (paired bootstrap over tasks, 95%, reductions): tool calls 10.4% [2.4, 18.4], model turns 3.3% [−4.7, 9.6], cache-write tokens 5.1% [−3.1, 13.0], output tokens 4.3% [−1.4, 9.9].

## Reading

- The whole effect comes from serialwrap. On mac-kvm nothing moved, so the extra searching the hook showed there (`HOOK_RESULT.md`, +36.4% against `pull`) is not caused by the shorter guidance. Its cause is not known.
- The full guidance costs 370 to 540 bytes of attached source at the median and did not lower correctness.
- Cost follows cache writes and output, which moved only on serialwrap. The pooled cost interval includes zero.

## Limits

- 2 repetitions, two repositories, 44 pairs. The pooled search interval is wide.
- These task sets have been run many times; this is a development comparison, not an unseen holdout.
- The comparison is between two hook preambles only. It does not re-measure the hook against `pull`.

Raw runs: `validation/v0.7/guidance/<repo>/claude-20261116-*/` (not committed).
