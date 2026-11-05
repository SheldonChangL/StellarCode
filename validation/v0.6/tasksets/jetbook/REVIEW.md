# jetbook task review

Reviewer checked every task against source at the pinned checkout using git/rg/sed/cat only. All expectedFiles exist via `git ls-files`; every edge's `from` body was read and contains the call/use, and every `to` symbol exists at the stated path.

| Task | Review |
|---|---|
| nav-login-lockout-duration | fixed: prompt reworded ("lock duration" echoed the identifier `lockDurationMs`); file and edge verified |
| nav-image-import-blocked-addresses | ok |
| nav-editor-autosave-delay | fixed: prompt said "page editor", which is the expected file stem (`page-editor.tsx`); reworded to "browser screen where a user edits a document" |
| flow-comment-reply-email | fixed: prompt said "background worker as a job", which leaked the `jobs/` directory; reworded to "handed off for asynchronous delivery". 4 edges verified |
| flow-api-update-archived-space-refused | ok (PATCH -> apiUpdatePage -> can -> actionAllowedWhenArchived verified) |
| flow-autosave-version-conflict | fixed: replaced "the editor" (the directory `components/editor/`) with "browser editing screen". Edges verified; `writePageContentTx` throws `VersionConflictError` (errors.ts) and the client matches on the `VERSION_CONFLICT` message |
| impact-content-write-pipeline-signature | fixed: `page-write.ts` has two callers; added the missing edge `apiCreatePage -> writePageContentTx`. The files list is complete (4 call sites in 4 files) |
| impact-verified-token-id-field | fixed: added edge `src/app/api/mcp/route.ts#writeGate -> bearer.ts#checkApiTokenRate` (the per-token id use in the agent endpoint). No REST route reads `auth.tokenId` directly, so the file list is complete |
| impact-save-action-return-shape | fixed: prompt leaked "editor" (directory) and "restore-a-previous-version" (close to the stem `restore-version-button`); reworded. Files and edges verified (the import callers of savePage ignore the return value) |
| edit-api-update-page-icon | ok (PATCH schema, MCP update_page tool, apiUpdatePage input/logic, openapi.ts spec are the 4 edit sites) |
| edit-moderators-edit-comments | ok (editComment author-only check; comments-panel `canEdit` lines 284/323) |
| edit-separate-move-permission | fixed: prompt said "web move actions", which leaked the `actions/` directory; reworded. The files list was confirmed complete (Action union and REQUIRED_ROLE in policy.ts; movePage via requireEditor and movePageToSpace in actions/page.ts; apiMovePage), and the edges were verified |

Totals: ok 4, fixed 8, replaced 0. Final set: 12 tasks, 3 per category, 9 with expectedSemanticEdges.
