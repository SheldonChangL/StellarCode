# jetchat-admin v0.5.6 holdout — independent answer-key review

- Reviewed: `draft-tasks.json` and `AUTHORING-draft.md` in this folder.
- Repo: `/Users/sheldon.chang/Projects/Private/stellar-holdout-v056/jetchat-admin`. `git rev-parse HEAD` returned `c9256c06ff39fb2d3c4f5f73fe5be2439423cd9f`, and the worktree was clean.
- Method: git, rg, sed and cat on the repo only. I ran no `stellar` command, opened no `.stellar/` directory, and read nothing else under StellarCode_M0-M3_Complete.

## Summary

| id | verdict | change |
|---|---|---|
| nav-unauthenticated-redirect-and-token-cache | ACCEPT | none |
| nav-malformed-ai-chart-rejection | REVISE | `expectedMatch` "any" → "all" |
| nav-all-organizations-account-listing | ACCEPT | none |
| flow-sign-in-to-session-cookie | ACCEPT | none |
| flow-member-disable-and-enable | ACCEPT | none |
| flow-conversation-list-date-window | ACCEPT | none (optional wording note) |
| impact-shared-date-picker-props | REVISE | prompt wording: remove the "date-range" stem and ask for the owner explicitly |
| impact-browser-readable-access-cookie | ACCEPT | none |
| impact-ai-generation-settings-shape | REVISE | add `src/components/ai-assistant/dialogs/ai-assistant-dialog.tsx` (all) |
| edit-expose-organizations-module | ACCEPT | none |
| edit-new-ai-assistant-tool | REVISE | prompt wording only: "function-call name" → "tool call" |
| edit-group-admin-account-creation | ACCEPT | none |

Category distribution stays at 3/3/3/3 after the revisions.

---

## 1. nav-unauthenticated-redirect-and-token-cache — ACCEPT

**Grounding.** Everything the prompt asks about is in `src/middleware.ts`:

- `:36-38`: `tokenCache = new Map`, with `CACHE_TTL = 5 * 60 * 1000`.
- `:48-59`: `getLoginRedirect` redirects to `/${locale}/login` and deletes `auth-token`.
- `:76-80`: a missing cookie triggers the redirect.
- `:90-134`: cache hit or miss, `verifyToken`, and caching that is skipped on `NETWORK_ERROR`.

**Alternatives.**

- `src/hooks/use-auth.ts:348,364,376` has client-side `router.push('/login')` paths. They do not run on URL access and do no caching.
- The dashboard layout (`src/app/[locale]/(dashboard)/layout.tsx`) explicitly defers to the middleware ("Middleware 已經處理路由保護").

**Other checks.**

- No path leak. The cache part pins the answer to a single file.
- With one file, "any" is equivalent to "all", so the match is fine.

## 2. nav-malformed-ai-chart-rejection — REVISE (`expectedMatch: "all"`)

**Grounding.**

- `src/components/ai-assistant/report/dynamic-chart-renderer.tsx:56-60`: `safeValidateChartConfig`, then `ChartErrorDisplay`, which shows the "Invalid Chart Configuration" alert (`:31-37`).
- `src/lib/ai/chart-validation.ts:91` (`dynamicChartConfigSchema`), `:206` (`safeValidateChartConfig`) and `:216` (`formatValidationErrors`).

**Problem with "any".** The two files are complementary, not alternatives:

- The prompt explicitly asks both where the spec is structurally checked (the Zod schema in `chart-validation.ts`) and what decides to show the error box (the renderer).
- The renderer imports the validator directly (`:12-16`), so any agent that follows the call reads both. Requiring both costs a competent agent nothing.
- With "any", an agent can pass by naming only the renderer without ever looking at the schema. That under-specifies the "structural validity" half.

**Distractor checked.** `src/lib/ai/extract-chart-config.ts:16-36` only `JSON.parse`s the code blocks and silently drops bad JSON. `use-ai-chat.ts:527` says that "validation happens at render time in DynamicChartRenderer". This is not a competing answer, because it never shows the error box. The key correctly omits it.

**Change:** `"expectedMatch": "all"`. Leave the files and prompt as they are.

## 3. nav-all-organizations-account-listing — ACCEPT

**Grounding.** `src/hooks/use-users-list.ts:72-91` checks `selectedOrgId === 'all-organizations' && role.name === 'system_admin'`, which leads to `UserService.getUsersSystemWideDataTable`. Otherwise it calls `getUserListAdvanced` (`:115`).

**Alternatives.**

- `src/lib/services/user.service.ts:179-197` branches on `isSystemLevel` (system vs org endpoints), but never on the all-organizations choice.
- `user-search.executor.ts:85` is the AI path, which the prompt excludes by naming the screen.

The key is unambiguous.

## 4. flow-sign-in-to-session-cookie — ACCEPT

**Grounding.** All four files carry an asked-for behaviour:

- `src/components/auth/login-form.tsx:57-59`: `onSubmit` → `login(data)`. The remember field is defined here.
- `src/lib/services/auth.ts:53-71`: `signInWithEmailAndPassword`, then `apiClient.post(API_ENDPOINTS.AUTH.SIGN_IN)`.
- `src/hooks/use-auth.ts`:
  - `:196-208`: `validateSystemAccess` (Dashboard/SelfDashboard).
  - `:232`: `setAuthCookie(token, remember)`.
  - `:274-277`: landing route `'/'` vs `'/self/dashboard'`.
  - `:291`: `authService.login`.
- `src/app/actions/auth.ts:18-24`: `maxAge: remember ? 30d : undefined`.

**Uniqueness.** `rg -ln "LoginForm|signInWithEmailAndPassword|setAuthCookie" src` returns only these four files plus the login route page, so there is no second implementation.

**Note.** The prompt asks *where* the credentials go to the backend endpoint, not for its path, so `api-endpoints.ts` correctly stays optional. The author's concern about agents skipping `login-form.tsx` is acceptable: the prompt starts at "submits the … sign-in form".

## 5. flow-member-disable-and-enable — ACCEPT

**Grounding.**

- `src/app/[locale]/(dashboard)/members/[id]/page.tsx`:
  - `:101-131`: `handleConfirmDisable` calls `updateMemberStatus({disabled:true, comment})` and maps `disabledByUser`/`disabledAt` into state.
  - `:147`: `handleConfirmEnable`.
- `src/lib/services/member.service.ts:100-117`: `UPDATE_STATUS.replace(':userId')` → `apiClient.patch`.
- `src/lib/constants/api-endpoints.ts:41`: holds the path, which is required because the prompt asks "which backend path is hit".

**Alternatives.** None. `rg -ln "disableReason|isDisableDialogOpen|disabledByUser" src` returns only the detail page and `dto.ts` (types only). There is no extracted dialog component.

## 6. flow-conversation-list-date-window — ACCEPT

**Grounding.**

- `src/components/conversations/conversations-management.tsx:26-62`: the default is `subDays(today, 30)`, formatted to `yyyy-MM-dd`, then passed to `useConversationsList`.
- `src/hooks/use-conversations-list.ts:40`.
- `src/lib/services/conversation.service.ts:25-41`: the `start_date`/`end_date` query params.

**Other callers.** `getConversationList` is also called by:

- `src/lib/ai/service-mapper.ts:156`
- `src/hooks/use-conversation-volume.ts:60`
- `conversation-search.executor.ts:58`

All three are other features. None starts from the 30-day window, so the key is not ambiguous.

**Optional wording note.** "conversation list" is close to the hook stem `use-conversations-list`. It is a domain phrase, so I do not require a change. If you want extra safety, use "How do the rows on the conversations screen get loaded?"

## 7. impact-shared-date-picker-props — REVISE (prompt wording only)

**Grounding.**

- The props interface is at `src/components/shared/date-range-filter.tsx:20-58`.
- `rg -n "DateRangeFilter" src` returns exactly three importers:
  - `member-management.tsx:38,441,452`
  - `user-data-table.tsx:42,334`
  - `conversation-table.tsx:35,315`
- `src/components/users/user-date-filter.tsx` is never imported (dead), and "shared" excludes it.

**Issue 1: stem leak.** "date-range picker" contains the stem `date-range` of `date-range-filter`. `rg -il "date-range"` lands on the owner file immediately.

**Issue 2: owner not asked for.** The key requires the owner under "all", but the prompt asks "which production components must be reviewed". A good agent could list just the three consumers, treating the owner as "the thing being changed", and fail.

**New prompt:**

> The shared calendar-popover picker for choosing a from/to period, shown above the list tables, takes a value, a change callback and a placeholder translation key. If those props are renamed or their types change, which production files — the picker itself and every component that renders it — must be reviewed?

Keep the expected files and "all".

## 8. impact-browser-readable-access-cookie — ACCEPT

**Grounding.**

- Writer: `src/middleware.ts:166-181` sets `'user-permissions'` to `JSON.stringify({role, permissions})` with `httpOnly: false`.
- Parser: `src/stores/permission-store.ts:47-66` reads `document.cookie` and runs `JSON.parse(decodeURIComponent(...))`.

**Uniqueness.** `rg -n "user-permissions|document\.cookie" src` returns exactly these two files. There is no leak, because the prompt avoids "permission".

## 9. impact-ai-generation-settings-shape — REVISE (add a missed consumer)

**Grounding of the existing key.**

- `src/lib/firebase/remote-config.ts:12-21` (interface) and `:94` (loader).
- `src/lib/ai/firebase-ai-client.ts:44-66` and `:91-114`.
- `src/hooks/use-ai-chat.ts:206,218,500-502`.

**Missed consumer.**

- `src/hooks/use-ai-chat.ts:575,695` returns `aiConfig` from the hook.
- `src/components/ai-assistant/dialogs/ai-assistant-dialog.tsx:51` destructures it and renders `{aiConfig?.modelName ?? '...'}` at `:149`.
- Renaming `modelName` breaks this dialog. It is a direct reader of the settings object's fields, and the prompt asks for modules that "load **or consume**" it.
- The draft wrongly fails nothing, but it under-specifies the task: an agent that misses the UI reader still passes. The author's `rg` (`getAIGenerationConfig|AIGenerationConfig|remote-config`) could not see it, because the dialog only uses the field via the hook return.

**Change:** add `src/components/ai-assistant/dialogs/ai-assistant-dialog.tsx` to `expectedFiles` and keep "all", for four files.

**Alternative, if 4/all feels too strict.** Narrow the prompt to "…which production modules fetch it from Firebase or read its fields to configure the model or check token usage?" and keep three files. I prefer adding the file, because the dialog is a real breakage point.

## 10. edit-expose-organizations-module — ACCEPT

**Grounding.**

- `src/lib/constants/navigation-modules.ts`:
  - `:53-60`: `OrganizationManagement.visible: false`.
  - `:136-140`: `moduleToNavigationItem` returns null when the module is not visible.
- `src/lib/utils/route-permissions.ts`:
  - `:47-54`: role-type check. `/organizations` is a system route, so org roles are refused.
  - `:58-70`: `routeModuleMap` has no `/organizations` entry.
  - `:86-87`: the fail-closed `return false`. This is why the URL is refused "for every role", as the prompt states.

**Alternatives.**

- `src/hooks/use-navigation-items.ts` is generic. Its `useCanAccessRoute` is client-side, so "server-side route guard" excludes it.
- `src/middleware.ts:147` only calls `canAccessRoute`. An agent may also list it, which is harmless.
- `src/lib/constants/navigation.ts` is dead code.

There is no leak: "menu", "route guard" and "module" are domain words.

## 11. edit-new-ai-assistant-tool — REVISE (prompt wording only)

**Grounding.**

- `src/lib/ai/function-declarations.ts:481-491`: the exported array. It is registered at `firebase-ai-client.ts:56`.
- `src/lib/ai/function-execution/index.ts:31-63`: the switch, with `Unknown function` as the default.

**Leak risk.** The phrase "function-call name … the code that executes it" mirrors both stems (`function-*`, `function-execution`). Gemini's API term is unavoidable in the domain, but the prompt does not need it twice.

**New prompt:**

> Before adding a new tool the AI assistant can call (for example 'search organizations'), which files define the tool schemas offered to the Gemini model and route a tool call returned by the model to the code that runs it?

Keep the expected files and "all".

**Notes, no key change.**

- `src/lib/ai/function-execution/types/function-execution.types.ts:121-139` holds the `FunctionArgs` discriminated union of tool names. A new `case 'search_organizations'` in the switch would not type-check without a new union member, so a strong agent will list this file too. That is fine under "all", and the prompt does not ask for it, so do not add it.
- The author's note claims that `constants.ts` SYSTEM_PROMPT does not enumerate tool names. That is inaccurate: `src/lib/ai/constants.ts:54` names `'generate_data_report'`. It is guidance prose, not dispatch, so the key is unaffected. Correct the note.

## 12. edit-group-admin-account-creation — ACCEPT

**Grounding.**

- `src/lib/utils/role-filters.ts:39-49`: in org scope, `org_admin` gets `['org_user','org_group_admin']`, and `org_group_admin` gets `[]`.
- `src/components/users/dialogs/create/create-user-dialog.tsx`:
  - `:65-67`: `getAvailableRolesForCreation`.
  - `:148`: the `system_admin` branch.
  - `:161-163`: the `org_admin` branch.
  - `:180-182`: `insufficientPermissions` for any other creator.

**Alternatives.**

- `user-dialog.tsx` is dead.
- `create-user-fields.tsx` only filters out `system_admin` (`:186`).
- `user-management.tsx:67,125` gates on `hasAction(..., 'write')`, not on role names.

The key is complete for what the prompt asks.

---

## Corrections to AUTHORING-draft.md

1. Task 2: change the "any" rationale. The files are complementary, so the match should be "all".
2. Task 9: add the `ai-assistant-dialog.tsx` consumer, which reads `aiConfig.modelName` via the `useAIChat` return.
3. Task 11: `constants.ts:54` does name `generate_data_report`. Also mention the `FunctionArgs` union in `function-execution.types.ts` as an optional extra file.
