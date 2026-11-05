# Review: redmine-ai-agent v0.6 holdout tasks

All expectedFiles were checked with `git ls-files`. Every edge was checked by reading both symbols' source. The checkout is unmodified.

| Task | Note |
|---|---|
| nav-per-user-redmine-throttle | ok. The rate, burst and 60s wait constants are in `TokenBucket` / `RedmineClient`. `_request` calls `self._bucket()`. `acquire` calls `self._refill()`. |
| nav-nda-ticket-llm-guard | fixed: "backend" (the top-level directory) became "server". The edges `is_bypassed`->`is_confidential`/`is_llm_primitive` and `enforce`->`is_bypassed` were verified. |
| nav-free-text-to-issue-filters | ok. `nl_to_redmine_query` calls `build_prompt` and `_parse` (2 attempts, default limit 50). |
| flow-approve-staged-batch-update | ok. `confirm` calls `load_preview`, `_execute_item` and `save_rollback_plan`. `_execute_item` calls `write_update_issue`. |
| flow-recurring-watch-notification | fixed: the prompt said "audit log", which leaked the `app/audit.py` stem; it now says "compliance trail of user actions". "in-app" (the `app/` dir) became "in-product". The edges were verified: `load_jobs` passes `run_inspection` to `scheduler.add_job`, and `_dispatch_one` uses `with audit_scope(...)`. |
| flow-side-panel-message-intent | fixed: the prompt leaked "chat" (the `app/chat.py` stem and endpoint symbol), "inference" (the `inference/` dir), "orchestrator" (the `orch/` dir) and "backend". These were reworded. The edges were verified (`build_graph` uses `graph.add_node(..., _classify_intent)`). |
| impact-chat-run-slot-and-sse-helpers | fixed: "chat endpoint" (the stem leak) became "conversational streaming endpoint", and "orchestrator" became "agent workflow". `run_macro` calls `chat_module._claim_run` / `_stream_events` (module receiver, unambiguous). There are no other production callers. |
| impact-published-rule-loader-contract | fixed: "rule set" (near the `rules/` dir) became "required-field configuration". The edges were verified: `validate_required_fields` calls `load_published_rules`, `validate_before_transition` calls `validate_required_fields`, and `explain_ticket` uses `load_published_rules` as a value only (CONSUMES). |
| impact-ticket-update-diff-helpers | fixed: the prompt nearly spelled out the helper identifiers ("update", "before/after diff"). It was reworded. `build_update_preview` calls `_build_updates`/`_compute_diff`, and `_read_before` calls `_get_before`. These are the only production importers. |
| edit-redmine-api-key-secret-naming | ok. `_SECRET_KEY_PREFIX` and `_secret_key` are duplicated in both files. All 3 call edges were verified. |
| edit-inference-reply-redis-key | fixed: "workers" leaked the `inference/worker.py` stem; it became "model-serving processes". `RESULT_KEY_PREFIX` / `result_key` are duplicated in client and worker. `infer`->`result_key` and `InferenceWorker._persist_result`->`result_key` were verified. |
| edit-add-watch-delivery-channel | fixed: added "(excluding database migrations)" so the answer is objective. Migration 0007 also holds a CHECK constraint. "backend" became "server-side". The channel Literal/allow-list is in inspections.py and the handler table is in notifier.py. |

Totals: 12 tasks, 3 per category, 11 with expectedSemanticEdges.
