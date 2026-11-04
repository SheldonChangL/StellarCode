# nestmind v0.5.6 holdout: authoring notes (draft)

- Repository: `/Users/sheldon.chang/Projects/Private/stellar-holdout-v056/nestmind` @ `3dc749f17631259529aec8a13ff8e2ce5e4b3920` (read-only; `git status` was clean)
- Authored without StellarCode. No `stellar` command was run and no `.stellar/` directory was opened. I used only `git`, `find`, `rg`, `sed`, `cat` and `wc`, and read the source directly.
- Category counts: navigation 3, flow 3, impact 3, editing-prep 3 (12 total). All tasks are backend (`apps/api`).
- Existence check: every expectedFile passed `git -C <repo> cat-file -e HEAD:<path>`, run in a loop over all 29 paths. All returned `ok`.
- Leak check: a script compared every prompt and id (lowercased) against all multi-part `.ts/.js` file stems under apps/ and libs/ (e.g. `pipeline-status`, `language-map`, `session-events`). There were no hits. A second scan for distinctive single-word stems (dispatcher, planner, pricing, retrieval, chunker, ingestion, credential, orchestrator, strategy, jwt, knowledge, runner, artifact, webhooks, executor) also found nothing. The only match was the generic phrase "in-memory" in the PDF task, which is unrelated to `memory.service.ts`. Generic domain words (task, session, webhook, GitLab, embedding, chunk, agent) are deliberately kept.
- Repo facts that shaped the key: there are no `*.spec.ts` files in apps/api (`find . -name '*.spec.ts' -not -path '*/node_modules/*'` → empty). So no test file is ever required. The only test-like file is `scripts/check-ci-log.ts` (a script, explicitly excluded in the impact prompt).

---

## 1. `repo-access-token-encryption-at-rest` (navigation, any)

**Why realistic:** a security review or key-rotation question: "where and how are stored repo tokens encrypted?"

**Expected:** `apps/api/src/modules/projects/credential.service.ts`. It is the only file that does AES-256-GCM encrypt/decrypt. It handles the 12-byte IV, appends the 16-byte tag (`encrypt` L50-L66, `decrypt` L70-L87), and derives the key in the constructor (64-hex → raw bytes, otherwise `scryptSync(rawKey,'nestmind-salt',32)`, L24-L43).

**Excluded:**
- `projects.service.ts` and `projects.controller.ts` only call `encrypt` (the upsert-credential endpoint). The prompt explicitly asks for the cryptography, not the endpoint.
- `ingestion.service.ts` only calls `decrypt` (L136).

**Evidence:**
- `rg -n "createCipheriv|createDecipheriv|aes-|scrypt|bcrypt|argon" apps/api/src libs` → cipher and scrypt calls occur only in credential.service.ts (L8-11, L38, L41, L52, L77). bcrypt in users/auth is password hashing, which is a different concern.

## 2. `structured-json-retry-and-call-timeout` (navigation, any)

**Why realistic:** debugging "why did my JSON call get retried / time out after 10 min".

**Expected:** `apps/api/src/modules/llm/llm.service.ts`.
- `chat()` builds the JSON-schema system prompt.
- `attempt()` (L178-L224) calls `parseJsonLoose`.
- On `JSON_PARSE_FAILED` it retries once with a stricter hint (L235-L247).
- `invokeWithTimeout` (L269-L301) uses `AbortController` plus `Promise.race` with `LLM_REQUEST_TIMEOUT_MS` (default 600000, L38-L40).

**Excluded:**
- The vendor adapters in `llm/providers/*` have no retry or timeout logic (`rg -n -i "retry|timeout|parseJsonLoose" apps/api/src/modules/llm/providers` → no matches).
- `json-repair.util.ts` only does loose parsing, not the retry.
- `stage-coordinator.service.ts` and `verdict-parser.ts` call `parseJsonLoose` but have no stricter-prompt retry (`rg -n -i "not valid JSON|stricter|JSON_PARSE_FAILED" apps/api/src` → only llm.service.ts).

## 3. `live-update-stream-fanout` (navigation, any)

**Why realistic:** "the UI stopped getting live updates or heartbeats; where is the fan-out?"

**Expected:** `apps/api/src/modules/sessions/session-events.service.ts`.
- `subscribe()` keeps a per-session `Set<Subject>` (L36-L54).
- The heartbeat is `interval(30_000)` (L42-L45).
- `push()` fans out to subscribers (L56-L61).
- The `@OnEvent` handlers for TASK_* and STAGE_* events (L77-L137) translate lifecycle events into stream messages.

**Excluded:** `sessions.controller.ts` has `@Sse(':id/events')` (L180-L188) but only returns `sessionEvents.subscribe(id)`. The prompt explicitly excludes "the HTTP route that merely returns the stream".

**Evidence:** `rg -n "heartbeat|@Sse|text/event-stream" apps/api/src` → the heartbeat exists only in session-events.service.ts, and the only `@Sse` route is in sessions.controller.ts.

## 4. `ci-hook-to-recorded-outcome` (flow, all)

**Why realistic:** "a GitLab pipeline finished but the session never showed it": trace webhook → session.

**Expected:**
- `webhooks/webhooks.controller.ts` checks the `x-gitlab-token` header against `GITLAB_WEBHOOK_SECRET` (L31-L38), filters on the `Pipeline Hook` event and `object_kind` (L40-L47), and calls `processPipelineEvent` (L49).
- `webhooks/webhooks.service.ts` ignores non-terminal states via `['success','failed','canceled']` (L17), calls `findSessionByMr` (L19), then `applyTerminalStatus` (L30).
- `webhooks/pipeline-status.service.ts` does three things:
  - `findSessionByMr` matches on `mrUrl` prefix plus `mrIid` (L272-L292).
  - `applyTerminalStatus` is idempotent on the (status, url) pair (L81-L97). It writes the context (L123-L134) and adds a system message.
  - It emits `PIPELINE_STATUS_UPDATED` (L139-L140).

**Excluded:**
- `pipeline-verification.service.ts` and `main-pipeline-watch.service.ts` are the poller path, not the inbound webhook.
- `dto/gitlab-pipeline-event.dto.ts` is a type-only DTO.
- `webhooks.module.ts` is boilerplate.
- Listeners of the emitted event (`pipeline-diagnosis.service.ts`) are downstream of "event is emitted".

**Evidence:** `rg -n "GITLAB_WEBHOOK_SECRET|processPipelineEvent|applyTerminalStatus\(" apps/api/src` shows the controller → service → status-service chain. `rg -n "x-gitlab-token|Pipeline Hook|'success', 'failed', 'canceled'|findSessionByMr|already recorded|eventEmitter.emit" apps/api/src/modules/webhooks/*.ts` gives the lines above.

## 5. `approval-resumes-work-dispatch` (flow, all)

**Why realistic:** "after I approve a task nothing else runs": trace approval → dispatch.

**Expected:**
- `tasks/tasks.service.ts`: `approve()` (L36-L73) validates TUNING mode and AWAITING_APPROVAL. In one transaction it sets the task to DONE, writes an approval event and sets the session to RUNNING (L46-L69). It then emits `TASK_APPROVED` (L71).
- `orchestrator/orchestrator.service.ts`: `@OnEvent(TASK_APPROVED) onTaskApproved` → `dispatcher.tick(sessionId)` (L153-L157).
- `orchestrator/dispatcher.service.ts`: `tick()` does three things:
  - Readiness: dependencies DONE, or ghost dependencies treated as satisfied (L41-L72).
  - Slot cap: `DISPATCHER_MAX_PARALLEL`, default 2 (L24, L75-L83).
  - It runs `runner.runTask` (L98-L108).

**Excluded:**
- `stage-coordinator.service.ts` also listens to TASK_APPROVED (L140-L145), but only for lifecycle stage tasks (`if (!task?.stageExecutionId ...) return`). The prompt says non-lifecycle.
- `session-events.service.ts` also listens (L89), but only for the UI stream.
- `tasks.controller.ts` (L24-L29) is a one-line pass-through.
- `agent-runner.service.ts` is what gets executed after dispatch, which is past the asked boundary ("selected and started").

**Evidence:** `rg -n "async approve|TASK_APPROVED|AWAITING_APPROVAL" modules/tasks modules/sessions modules/orchestrator/orchestrator.service.ts modules/orchestrator/dispatcher.service.ts`, plus `rg -n "ORCHESTRATOR_EVENTS\.\w+|@OnEvent\(" apps/api/src`, which lists all emitters and listeners.

## 6. `generated-code-to-searchable-vectors` (flow, all)

**Why realistic:** "files the agent wrote aren't found by knowledge search": trace indexing of session artifacts.

**Expected:**
- `orchestrator/session-artifact-index.service.ts`:
  - `syncAndEmbed` (L34-L53) resolves the PRIMARY project, then calls `ingestion.ingestFiles` and `embedding.embedProject`.
  - `collectGeneratedFiles` (L63-L88) reads `contentType: 'CODE'` messages; the last path wins via a Map.
- `ingestion/ingestion.service.ts`:
  - `ingestFiles` (L223-L244) works with no clone.
  - `upsertChunks` (L253-L292) upserts on `projectId_source_path_contentHash` with a sha256 hash.
- `embedding/embedding.service.ts`:
  - `embedProject` (L130-L196) selects `embeddingModel: null` and filters out blank chunks (L143-L146).
  - It batches the work and writes vectors with raw `::vector` SQL.

**Excluded:**
- `ingestion/chunker.service.ts` produces the raw chunks, but none of the asked behaviours (collection, hash-keyed upsert, embed-only-new or non-blank) live there. Reading it is harmless but not required.
- `dispatcher.service.ts` and `sessions.service.ts` are triggers (callers of `syncAndEmbed`), not part of the path.
- `retrieval.service.ts` is the read side.

**Evidence:** `rg -n "SessionArtifactIndex|syncAndEmbed" apps/api/src` gives callers dispatcher L179, sessions.service L50 and agent-runner (injected). `rg -n "async ingestFiles|private async upsertChunks|projectId_source_path_contentHash"` covers ingestion.service.ts. `rg -n "embedProject"` covers embedding.service.ts.

## 7. `usd-cost-calculation-callers` (impact, all)

**Why realistic:** changing `calcCost` (e.g. making cache tokens mandatory) requires finding every caller.

**Expected:**
- Owner `llm/pricing.ts`: `calcCost` (L121-L139) and `MODEL_PRICING_PER_1K` (L12), which is not exported-used elsewhere.
- Direct callers:
  - `orchestrator/agent-runner.service.ts` L6 and L360-L366 (passes cache tokens).
  - `orchestrator/planner.service.ts` L4 and L130-L134.
  - `sessions/sessions.service.ts` L19, L110 and L162 (legacy recompute with a hard-coded model id).

**Excluded:** nothing else imports the module. Web and Prisma do not compute cost.

**Evidence:** `rg -n "calcCost|MODEL_PRICING|pricing'" --type ts -g '!node_modules' .` → exactly these 4 files.

## 8. `vector-similarity-result-consumers` (impact, all)

**Why realistic:** changing the `SearchResult` shape or semantics (similarity, content) requires reviewing the direct callers.

**Expected:**
- Owner `embedding/retrieval.service.ts`: `SearchResult` (L6-L19) and `search()` (L53-L101).
- Direct callers:
  - `tools/builtin/knowledge.tools.ts` L60-L75 (maps `similarity` and `content`).
  - `orchestrator/project-context.service.ts` L43 and L57-L60 (uses `h.similarity * 100` and `h.content`).
  - `projects/projects.controller.ts` L142-L154 (returns the results verbatim over HTTP).

**Excluded:**
- `apps/web/src/app/services/api.service.ts` L379 consumes the HTTP endpoint (`SearchChunkResult`). That is a transitive, HTTP-level consumer with no TS import, so it is left out to keep the set direct.
- `embedding.module.ts` is boilerplate.

**Evidence:** `rg -n "RetrievalService|retrieval\.\w+\(" apps/api/src` and `rg -n "\.search\(" apps/api/src` → the three callers above. `rg -n "SearchResult|search\(" apps/web/src` → web api.service only.

## 9. `job-trace-helper-signature-change` (impact, all)

**Why realistic:** refactoring a shared util's exported API requires listing its importers.

**Expected:**
- Owner `common/ci-log.util.ts`: `parsePipelineId` L72, `extractErrorContext` L84, `computeFailureSignature` L117.
- Importers:
  - `webhooks/pipeline-status.service.ts` L11-L15, L175, L188-L189 (uses all three).
  - `tools/builtin/gitlab.tools.ts` L9 and L517 (`extractErrorContext` only; it has its own local `parsePipelineId` at L93, which is a useful trap).

**Excluded:**
- `sessions/pipeline-diagnosis.service.ts` reads stored `failureSignature` and `failureExcerpt` strings (L367, L482-L488) but does not import the helpers. The prompt explicitly says to ignore readers of stored fingerprints.
- `scripts/check-ci-log.ts` is a script (explicitly excluded).

**Evidence:** `rg -n "calcCost|resolveLanguageConfig|extractErrorContext|computeFailureSignature|parsePipelineId|\.search\(" --type ts .` and `rg -n "ci-log.util" apps/api/src` → only the two production importers. `rg -n "failureSignature|failureExcerpt" apps/api/src` → only pipeline-diagnosis besides pipeline-status.

## 10. `add-go-to-sandboxed-execution` (editing-prep, all)

**Why realistic:** a typical feature-prep question: "add a language to code_execute".

**Expected:**
- `executor/language-map.ts`: `LANGUAGE_MAP` (L7-L15) maps language → image and runCmd. It is shared by both backends via `resolveLanguageConfig` (L18-L25).
- `executor/executor.tools.ts`:
  - `LANG_EXT` (L15-L20) sets the default script extension.
  - The tool description says "Supported languages: ..." (L49).
  - The input-schema `enum` (L55) gates which languages an agent may send.

**Excluded:** `docker-executor.service.ts` (L25-L26) and `k8s/k8s-executor.service.ts` (L35-L36) only delegate to `resolveLanguageConfig(language, this.defaultImage)`. They need no change for a new language. `executor.interfaces.ts` and `executor.types.ts` are type-only.

**Evidence:** `rg -n "npx|node:22|python|LANGUAGE_MAP|tsx" apps/api/src --type ts` → the language-specific tables exist only in language-map.ts and executor.tools.ts. Chunker, file-extractor and compilation-validator hits are unrelated.

## 11. `async-report-job-ownership-check` (editing-prep, all)

**Why realistic:** an IDOR fix. `getJob` has a comment admitting the check is missing (L149-L150), and `download` does not receive the user at all.

**Expected:**
- `pdf-report/pdf-report.service.ts` holds the module-level `jobStore` (L20). The entry has no owner field, so one must be added.
  - `enqueueJob` (L124-L144) is where the owner would be recorded.
  - `getJob` (L146-L162) and `getJobBuffer` (L164-L170) need the check.
  - `verifyProjectAccess` (L496-L505) is the existing pattern to reuse.
- `pdf-report/pdf-report.controller.ts`: `getJobStatus` (L79-L85) and `download` (L91-L104). `download` passes only `jobId` to `getJobBuffer`, so its call signature must change.

**Excluded:**
- `dto/pdf-job-status.dto.ts` is the response DTO. The owner can live in the store's intersection type, so the DTO need not change.
- `pdf-renderer.service.ts` does rendering only.
- The web client (`apps/web/.../api.service.ts` L403-L424) is unaffected by a server-side check.

**Evidence:** `rg -n "getJobBuffer|getJob\(|jobStore" apps/api/src` → only these two files.

## 12. `require-access-token-signing-secret` (editing-prep, all)

**Why realistic:** security hardening: remove the `'fallback-secret'` default.

**Expected:**
- `auth/auth.module.ts` L13-L19: `JwtModule.registerAsync` sets the signing secret (`JWT_SECRET`, default `'fallback-secret'`). This is genuine config, not boilerplate.
- `auth/strategies/jwt.strategy.ts` L19-L23: bearer-header verification secret.
- `auth/strategies/jwt-query.strategy.ts` L14-L18: `?token=` verification secret. This is the easily-missed third site.

**Excluded:**
- `auth/auth.service.ts` signs access tokens (L90-L92) but relies on the module default and never reads `JWT_SECRET`. The refresh token uses `JWT_REFRESH_SECRET`, which is a different secret.
- The guards (`jwt-auth`, `jwt-query-auth`, `jwt-flexible-auth`) only select strategies.
- `app.module.ts` has no env validation schema (`ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' })`).

**Evidence:** `rg -n "fallback-secret|JwtService|jwtService" --type ts -g '!node_modules' .` → 'fallback-secret' appears in exactly these 3 files. `rg -n "JWT_|sign\(|expiresIn|secretOrKey|JwtService" apps/api/src` confirms auth.service.ts uses no JWT_SECRET.

---

## Confidence notes

- **Lowest: #6** (`generated-code-to-searchable-vectors`). The chunker is a real step between ingestion and persistence, and a reviewer might argue it belongs in the key. I excluded it because the prompt scopes the asked behaviours to collection, hash-keyed upsert and embedding of only new, non-blank chunks, none of which are in the chunker.
- **#12:** someone could argue auth.service.ts (the signing call) is required. I scoped the prompt to the files that *configure* the secret.
- **#8:** excludes the Angular HTTP consumer by design (direct TS consumers only).
