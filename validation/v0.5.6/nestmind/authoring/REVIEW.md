# nestmind v0.5.6 draft answer key: independent review

- Repo: `stellar-holdout-v056/nestmind` @ `3dc749f17631259529aec8a13ff8e2ce5e4b3920` (`git rev-parse HEAD` confirmed). Read only.
- Method: `rg`, `sed` and `git` on the repo only. No `stellar` command was run and no `.stellar/` directory was opened.
- Result: 11 ACCEPT, 1 REVISE (wording only), 0 REPLACE. All three of the author's flagged doubts are upheld as drafted.

## Per-task review

### 1. repo-access-token-encryption-at-rest: ACCEPT
- Source grounding:
  - `createCipheriv`, `createDecipheriv` and `scryptSync` occur only in `projects/credential.service.ts` (L8-11, L38, L41, L52, L77).
  - The 64-hex check and the scrypt fallback are in the constructor.
  - The 12-byte IV is at encrypt L51. The auth tag is handled with `getAuthTag` and `setAuthTag` (tag is 16 bytes).
- No other crypto sits in apps/libs, so the key is unambiguous.
- Leak check: "credential" does not appear in the prompt.
- Using "any" with a single file is correct.

### 2. structured-json-retry-and-call-timeout: ACCEPT
- `llm/llm.service.ts` has the following:
  - `JSON_PARSE_FAILED` throw at L224.
  - The stricter retry at L235-247.
  - `LLM_REQUEST_TIMEOUT_MS` at L39.
  - `AbortController` at L285.
- No provider under `llm/providers/*` contains retry or timeout logic.
- The other `retry` hits are in the dispatcher, agent-runner and pipeline pollers. They are unrelated (task retry and poll retry).

### 3. live-update-stream-fanout: ACCEPT
- In `sessions/session-events.service.ts`, the heartbeat `interval(30_000)` is at L42-44. The `@OnEvent` handlers include TASK_APPROVED at L89.
- The only `@Sse` route is `sessions.controller.ts:180`, which the prompt explicitly excludes.
- Leak check: "session" and "events" appear as separate domain words, not as the hyphenated stem. This is acceptable.

### 4. ci-hook-to-recorded-outcome: ACCEPT
- `webhooks.controller.ts`: secret check at L35-38, `Pipeline Hook` filter at L40, then the call to `processPipelineEvent` at L49.
- `webhooks.service.ts`: terminal-state filter at L17, `findSessionByMr` at L19, `applyTerminalStatus` at L30.
- `pipeline-status.service.ts` has the following:
  - `applyTerminalStatus` at L81, with the idempotent "already recorded" return at L96.
  - The emit at L140.
  - `findSessionByMr` at L272.
- All three files are needed for the asked chain. The pollers in `pipeline-verification.service.ts` (L273, L290) are a separate entry path and are rightly excluded.

### 5. approval-resumes-work-dispatch: ACCEPT
- `tasks.service.ts`:
  - `approve()` at L36-73 runs a transaction across task DONE, the approval event and session RUNNING.
  - The emit is at L71.
- `orchestrator.service.ts`: `onTaskApproved` (L153-157) calls `dispatcher.tick`.
- `dispatcher.service.ts`:
  - `tick()` selects tasks whose dependencies are DONE or ghost.
  - `maxParallel` comes from `DISPATCHER_MAX_PARALLEL` (L24).
  - Slots are computed with `slice` and the task is started with `runner.runTask`.
- The `stage-coordinator` listener lives in `orchestrator/lifecycle/` and is excluded by "non-lifecycle". The `session-events` listener only feeds the UI. Both exclusions are correct.

### 6. generated-code-to-searchable-vectors: ACCEPT (author doubt: chunker omitted, upheld)
The three asked behaviours map one-to-one onto the three files:
- Latest-per-path collection is `session-artifact-index.service.ts` `collectGeneratedFiles`, which uses a Map keyed by path over CODE messages in ascending sequence.
- Hash-keyed upsert without a clone is `ingestion.service.ts` `ingestFiles` (L222-243) plus `upsertChunks` (L253-292). These use the sha256 hash and the `projectId_source_path_contentHash` key.
- Embedding only new, non-blank chunks is `embedding.service.ts` `embedProject`, which filters on `embeddingModel: null` and `trim().length > 0` and then writes with `::vector`.

`chunker.service.ts` is only called at ingestion L259 (`this.chunkerService.chunk`). None of the behaviours the prompt asks about live there, so requiring it under "all" would fail a correct answer. Keep it out of the key.

### 7. usd-cost-calculation-callers: ACCEPT
- `rg calcCost|pricing` over apps and libs finds exactly four files:
  - `pricing.ts` L121 (the owner).
  - `agent-runner.service.ts` L6 and L360.
  - `planner.service.ts` L4 and L130.
  - `sessions.service.ts` L19, L110 and L162.
- `MODEL_PRICING_PER_1K` is not used outside `pricing.ts`.
- The web client only displays the stored `costUsd`, which is not a caller. The consumer set is complete and every consumer is direct.

### 8. vector-similarity-result-consumers: ACCEPT (author doubt: Angular client omitted, upheld)
- `RetrievalService.search` is the only public method on the service (retrieval L53). Its direct callers are:
  - `knowledge.tools.ts` L60 and L73 (maps `similarity`).
  - `project-context.service.ts` L43 and L57 (`h.similarity * 100`, `h.content`).
  - `projects.controller.ts` L149 (returns the results verbatim).
- `knowledge.tools.ts` L220 only injects the service and passes it into the tool, so it adds no extra file.
- The web client's `api.service.ts:379` reaches the search over HTTP, not as a direct call. The prompt says "calls this search directly", so excluding it is consistent.
- No other pgvector `<=>` query exists in the backend, so "vector-similarity search" is unambiguous. The set is complete.

### 9. job-trace-helper-signature-change: ACCEPT
- `ci-log.util` is imported only by:
  - `pipeline-status.service.ts` L12-15, which uses all three helpers (L175, L188, L189).
  - `gitlab.tools.ts` L9, which uses `extractErrorContext` at L517. Its own `parsePipelineId` at L93 is local, which makes a good trap.
  - `scripts/check-ci-log.ts`, which the prompt excludes.
- The set is complete.

### 10. add-go-to-sandboxed-execution: REVISE (wording only, key unchanged)
- The key is correct:
  - `language-map.ts` has `LANGUAGE_MAP` at L7-15.
  - `executor.tools.ts` has `LANG_EXT` at L15-20, the "Supported languages" description at L49 and the `enum` at L55.
- The Docker and K8s executors only delegate (L25-26 and L35-36). The controller, container-pool and job factory have no per-language tables.
- Problem: the phrase "the shared mapping from language to container image" nearly spells out the stem `language-map`, which is a mild leak.
- Minimal change: replace that clause with "the shared per-language table of container image and run command used by both the Docker and Kubernetes backends". `expectedFiles` and `expectedMatch` stay unchanged.

### 11. async-report-job-ownership-check: ACCEPT
- The service has `jobStore` at L20, `enqueueJob` at L124, `getJob` at L146 (with the empty "ownership check" comment at L149-150) and `getJobBuffer` at L164.
- The controller has `getJobStatus` at L79-85. `download` at L91-104 receives `user` but calls `getJobBuffer(jobId)` only, so both files must change.
- `verifyProjectAccess` is in the service at L496, so the fix can reuse the existing projectId on the job.
- No DTO change is needed.

### 12. require-access-token-signing-secret: ACCEPT (author doubt: auth service omitted, upheld)
- `'fallback-secret'` appears in exactly three places: `auth.module.ts:15`, `jwt.strategy.ts:22` (bearer, L20) and `jwt-query.strategy.ts:17` (`fromUrlQueryParameter`, L15).
- `auth.service.ts` L90-91 signs the access token without a `secret`, so it inherits the module config. Its only explicit secret is `JWT_REFRESH_SECRET` at L96, which is a different secret.
- The prompt asks which files "configure that secret", so `auth.service.ts` is correctly omitted.

## Cross-cutting notes
- Expected files are all `.ts` and all exist at HEAD.
- Each category matches the task's shape:
  - Navigation tasks use "any" with one file.
  - Flow tasks span three production files.
  - Impact tasks list the owner plus every direct consumer.
  - Editing-prep tasks list exactly the files that must change.
