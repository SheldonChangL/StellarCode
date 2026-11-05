# audit-orders task review

Verified against the repository with git ls-files, rg, sed and cat. Every expectedFiles path and edge endpoint exists in `git ls-files`. Final set: 12 tasks, 3 per category, 8 with expectedSemanticEdges.

| Task | Review |
|---|---|
| nav-meter-rollover-energy | ok. The rollover branch of `AuditService._calculateEnergyUsage` calls `this._findClosestPowersOfTwo(meterStart)`. |
| nav-bearer-token-identity | ok. `deserializeUser` strips `Bearer`, falls back to `req.query.token`, calls `verifyJwt` and sets `res.locals.user`. |
| nav-incoming-file-disk-name | ok. multer `diskStorage` destination and the `Date.now() + extname` filename are both in uploadFile.ts. |
| flow-reconcile-to-history-record | ok. The arrow handler in `setRoutes` calls `this.auditController.audit` (field typed `AuditController`). That calls `this._auditService.audit`, which calls `this._createAuditRecord`, which calls `energyDb.Audit.create`. |
| flow-invalid-token-rejected | ok. `verifyJwt` catches and returns null, so no `res.locals.user` is set. `requireUser` is passed to `router.post('/audit', ...)` and returns the 403 "You don't have permission" JSON. |
| flow-monthly-report-email | ok. Route calls `AuditController.monthAudit`, which calls `AuditService.monthAudit`, which calls `this.sendEmail(...)`. `sendEmail` makes `axios.post("http://127.0.0.1:3080/email")`. |
| impact-token-verify-throws | ok. The only production caller of `verifyJwt` is `deserializeUser`. |
| impact-schema-check-decorator | fixed: added src/controllers/audit.controller.ts to expectedFiles. If the decorator rethrows, the exception escapes before the service methods' own try/catch, so `AuditController.audit`, `monthAudit` and `list` (which have no try/catch) must be reviewed. Added 3 controller-to-service CALLS edges. |
| impact-history-record-columns | fixed: the prompt said "a column ... (for example ...)", which made the answer depend on the column chosen. `cash_flow_file` and `invoice_file` also appear in the zod schema, but `report_file` does not. Narrowed the prompt to the report-file-name column. The answer is then the model, `IAudit.Body` and `_createAuditRecord` in the service. |
| edit-history-list-date-filter | ok. The list zod schema and `AuditService.list` must change. `ICommon.IListQuery` already has `begin_at`/`end_at`, and the controller passes `req.query` through, so neither needs editing. |
| edit-storage-dir-configurable | fixed: "per-environment setting" was ambiguous between the typed `Config` interface and the env JSON value files. The prompt now asks for a value of the typed settings object loaded at startup, puts the JSON value files explicitly out of scope, and mentions that the path is hard-coded in several places. The expected files are unchanged: uploadFile.ts, the controller's `download`, the service and the config index. |
| edit-owner-only-history-delete | ok. The route has `// requireUser` commented out on delete. The controller does not pass `res.locals.user`. The service's `delete` does `findByPk` and `destroy` with no owner check. The edges are verified. |

Counts: ok 9, fixed 3, replaced 0.
