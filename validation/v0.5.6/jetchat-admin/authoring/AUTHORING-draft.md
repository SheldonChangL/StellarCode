# jetchat-admin v0.5.6 holdout — authoring notes (draft)

- Repo: `/Users/sheldon.chang/Projects/Private/stellar-holdout-v056/jetchat-admin` @ `c9256c06ff39fb2d3c4f5f73fe5be2439423cd9f` (read-only, not modified).
- Authored with git / ls / rg / sed / cat only. No `stellar` command run, no `.stellar/` opened, no prior validation folders read.
- Distribution: navigation 3, flow 3, impact 3, editing-prep 3 (12 tasks).
- Subsystems covered: route guard (Next.js middleware), sign-in/session, members, conversations, admin accounts (users), shared table UI, menu/module mapping, AI assistant (tools, charts, runtime model settings).
- Checks run: every expectedFile passes `git cat-file -e HEAD:<path>`. A stem-leak script compared prompts and ids against the expected-file basenames. It flagged only `member` (from `member.service.ts`) and `conversation` (from `conversation.service.ts`). Both are domain nouns the rules allow. No prompt contains `auth`, `middleware`, `page`, `index`, `api`, `sidebar` or any hyphenated stem.
- Repo-wide distractors to know about:
  - `src/components/users/user-dialog.tsx` defines a second `createUserSchema`/`UserDialog`, but nothing imports `UserDialog` (`rg -n "UserDialog\b" src` → only its own definition). It is dead code.
  - `src/lib/constants/navigation.ts` holds a static `navigationItems` array that nothing imports (`rg -n "lib/constants/navigation'" src` → no hits).

---

## 1. nav-unauthenticated-redirect-and-token-cache — navigation
**Why realistic:** A common first question about any Next.js admin app is "where is the auth gate, and why does my token get re-verified or not?"

**Expected:** `src/middleware.ts` (any)
- `src/middleware.ts:76-82`: reads the `auth-token` cookie and calls `getLoginRedirect` when it is missing. `:48-61`: `getLoginRedirect` builds `/${locale}/login` and deletes the cookie.
- `:37-38`: `tokenCache = new Map`, `CACHE_TTL = 5 * 60 * 1000`. `:85-133`: cache lookup, `verifyToken`, then `tokenCache.set`, which skips caching on NETWORK_ERROR. `:139`: redirect when the token is invalid.

**Alternatives excluded:**
- `src/lib/services/api.ts:180` (`verifyToken`) only performs the HTTP call. It neither redirects nor caches.
- `src/app/actions/auth.ts` and `src/hooks/use-auth.ts` (`checkAuth` → `router.push('/login')`) are client-side helpers. They do not run on URL access, and neither caches verification.

**Evidence:** `rg -n "getLoginRedirect|tokenCache|CACHE_TTL =" src/middleware.ts`; `rg -n "tokenCache|CACHE_TTL" src` → only `src/middleware.ts`.

## 2. nav-malformed-ai-chart-rejection — navigation
**Why realistic:** "The AI chart shows 'Invalid Chart Configuration' — where is that decided?" is a typical debugging entry question.

**Expected (any):** `src/components/ai-assistant/report/dynamic-chart-renderer.tsx`, `src/lib/ai/chart-validation.ts`
- The renderer calls `safeValidateChartConfig(config)` at `:56`. On failure it calls `formatValidationErrors` (`:59`) and renders the destructive `<Alert>` titled "Invalid Chart Configuration" (`:34-37`).
- The schema owner is `chart-validation.ts`: `dynamicChartConfigSchema` at `:91`, `safeValidateChartConfig` at `:206`, `formatValidationErrors` at `:216`.
- The prompt asks both "where is it checked" (schema) and "what decides to show the error" (renderer), so either file is a valid owner. That is why the match is `any`.

**Alternatives excluded:**
- The `dynamic-charts/*` components import only the `ValidatedChartConfig` type. They receive configs that are already validated.
- `src/lib/ai/dynamic-chart-schema.ts` holds TypeScript types and no runtime validation.

**Evidence:** `rg -n "safeValidateChartConfig|formatValidationErrors" src` → hits only in these two files.

## 3. nav-all-organizations-account-listing — navigation
**Why realistic:** A scoped-data bug ("All Organizations shows the wrong users") sends an agent hunting for the branch that picks the endpoint.

**Expected:** `src/hooks/use-users-list.ts` (any)
- `:73-76`: `if (selectedOrgId === 'all-organizations' && role.name === 'system_admin')` → `UserService.getUsersSystemWideDataTable` (`:91`). Otherwise it calls `UserService.getUserListAdvanced` (`:115`).

**Alternatives excluded:**
- `src/stores/org-group-store.ts:20` only defines the "All Organizations" option.
- `src/lib/services/user.service.ts` only maps org/group to endpoints. It never sees the all-orgs choice.
- `src/components/users/user-management.tsx:70` just calls the hook.
- `src/lib/ai/function-execution/executors/user-search.executor.ts:85` has a similar branch, but it belongs to the AI assistant's search, not the management screen. The prompt names the screen to exclude it.

**Evidence:** `rg -n "all-organizations" src` → store, hook, executor; `rg -n "useUsersList" src`.

## 4. flow-sign-in-to-session-cookie — flow
**Why realistic:** "Walk me through login end-to-end" is the canonical onboarding flow question. It crosses UI → hook → service → server action.

**Expected (all):**
- `src/components/auth/login-form.tsx`: the entry point. `onSubmit` → `login(data)` from `useAuth` (`:37`, `:57-59`).
- `src/hooks/use-auth.ts`: orchestration.
  - `authService.login` (`:291`).
  - `validateSystemAccess` rejects accounts without the Dashboard/SelfDashboard module (`:196-208`).
  - `updateAuthState` → `setAuthCookie(loginData.backendToken, remember)` (`:232`).
  - `navigateToAppropriateRoute` → `'/'` or `'/self/dashboard'` (`:274-277`).
- `src/lib/services/auth.ts`: `signInWithEmailAndPassword` (`:55`), then POST to `API_ENDPOINTS.AUTH.SIGN_IN` (`:68`).
- `src/app/actions/auth.ts`: `setAuthCookie`. The cookie gets `maxAge: remember ? 60*60*24*30 : undefined` (`:23`).

**Alternatives excluded:**
- `src/lib/services/api.ts` is generic transport.
- `src/lib/constants/api-endpoints.ts` only holds the path string; the prompt does not ask for the path.
- The stores are side effects of the flow, not required to understand it.
- `src/middleware.ts` runs after sign-in, not during it.

**Evidence:** `rg -n "setAuthCookie|clearAuthCookie" src` (only `use-auth.ts` consumes the server actions); `rg -n "authService.login|navigateToAppropriateRoute" src/hooks/use-auth.ts`.

## 5. flow-member-disable-and-enable — flow
**Why realistic:** This is a concrete write path with UI state reconciliation, the kind an agent traces before changing the disable-reason behaviour.

**Expected (all):**
- `src/app/[locale]/(dashboard)/members/[id]/page.tsx`: `handleConfirmDisable` and `handleConfirmEnable` (`:101`, `:147`) call `MemberService.updateMemberStatus` (`:109`, `:154`) with `{disabled, comment}`. They map `response.data.disabledByUser` and `disabledAt` into local state (`:118-131`).
- `src/lib/services/member.service.ts`: `updateMemberStatus` (`:100`) builds the endpoint from `API_ENDPOINTS.MEMBERS.UPDATE_STATUS` (`:107`) and calls `apiClient.patch` (`:114`).
- `src/lib/constants/api-endpoints.ts:41`: `UPDATE_STATUS: '/api/v1/server/mgmt/users/:userId/members/status'`. This is required because the prompt asks for the backend path.

**Alternatives excluded:**
- `src/lib/services/api.ts` is a generic `fetch` wrapper and not needed to understand this flow.
- `src/components/members/member-management.tsx` is the list screen and has no status toggle.
- `src/lib/types/dto.ts` contains only types.

**Evidence:** `rg -n "updateMemberStatus|getMemberDetail" src` → only the service and the detail page; `rg -n "UPDATE_STATUS" src`.

## 6. flow-conversation-list-date-window — flow
**Why realistic:** Data-fetch tracing from a container component through a hook to a service is the bread-and-butter flow question in React apps.

**Expected (all):**
- `src/components/conversations/conversations-management.tsx`: the default window is `subDays(today, 30)` (`:41`). It formats the range to `yyyy-MM-dd` and calls `useConversationsList({start_date, end_date})` (`:57-62`).
- `src/hooks/use-conversations-list.ts`: `ConversationService.getConversationList` (`:40`).
- `src/lib/services/conversation.service.ts`: appends the `start_date`/`end_date` query params to `API_ENDPOINTS.CONVERSATIONS.LIST` (`:30-46`).

**Alternatives excluded:**
- The route `conversations/page.tsx` only forwards `searchParams` as `initialFilters`. The prompt starts at the date window, so it is not required.
- `conversation-table.tsx` only renders the rows and the picker.
- `use-conversation-volume.ts` and `conversation-search.executor.ts` call the same service from different features (dashboard chart and AI).

**Evidence:** `rg -n "useConversationsList|getConversationList" src`.

## 7. impact-shared-date-picker-props — impact
**Why realistic:** Changing a shared component's props is the classic "who breaks?" question.

**Expected (all):** owner `src/components/shared/date-range-filter.tsx` (props interface `:20-58`, export `:60`), plus every direct consumer:
- `src/components/members/member-management.tsx:38`, used at `:441`, `:452`
- `src/components/users/user-data-table.tsx:42`, used at `:334`
- `src/components/conversations/conversation-table.tsx:35`, used at `:315`

**Alternatives excluded:**
- `src/components/users/user-date-filter.tsx` is a separate component and does not import the shared picker.
- The parents of the consumers (pages, `user-management.tsx`, `conversations-management.tsx`) are transitive, not direct.

**Evidence:** `rg -n "DateRangeFilter" src` → exactly the owner plus 3 importers (4 files total).

## 8. impact-browser-readable-access-cookie — impact
**Why realistic:** A cross-runtime contract (Edge middleware writes, browser store reads) is easy to break silently. It is a good test of whether the agent finds both ends of a string-keyed contract.

**Expected (all):**
- `src/middleware.ts:167-181`: sets the cookie `'user-permissions'` to `JSON.stringify({role, permissions})` with `httpOnly: false`.
- `src/stores/permission-store.ts:49-66`: `parsePermissionsCookie` finds `user-permissions=`, runs `JSON.parse(decodeURIComponent(...))`, and reads `data.role` and `data.permissions`.

**Alternatives excluded:**
- `src/hooks/use-permissions.ts` only calls `syncFromCookie()` and never touches the cookie payload, so it is transitive.
- `src/hooks/use-auth.ts` sets the store directly from the sign-in response, not from the cookie.

**Evidence:** `rg -n "user-permissions" src tests` → exactly these two files.

## 9. impact-ai-generation-settings-shape — impact
**Why realistic:** The runtime config contract (`AIGenerationConfig`) feeds model construction. An agent adding a field such as `maxOutputTokensSummary` must find every reader.

**Expected (all):**
- `src/lib/firebase/remote-config.ts`: `AIGenerationConfig` interface `:12-21`, `getAIGenerationConfig` `:94`.
- `src/lib/ai/firebase-ai-client.ts`: imports it at `:8` and calls it at `:44` and `:91`. It reads `modelName`, `temperature`, `topP`, `topK` and `maxOutputTokens` (`:54-66`), and `maxOutputTokensAnalysis` (`:114`).
- `src/hooks/use-ai-chat.ts`: imports the function and type (`:11-14`), calls it at `:218`, and reads `aiConfig.maxOutputTokens` at `:500-502`.

**Alternatives excluded:**
- `src/lib/ai/constants.ts` only mentions remote-config in a comment (`:8`) and does not import it.

**Evidence:** `rg -n "getAIGenerationConfig|AIGenerationConfig|remote-config" src`.

## 10. edit-expose-organizations-module — editing-prep
**Why realistic:** Turning on a feature that is scaffolded but hidden needs both the menu configuration and the access guard. Agents often miss the second.

**Expected (all):**
- `src/lib/constants/navigation-modules.ts:53-60`: `OrganizationManagement` has `visible: false`, and `moduleToNavigationItem` returns null when `!config.visible`.
- `src/lib/utils/route-permissions.ts:58-63`: `routeModuleMap` has no `/organizations` entry, so the path falls through to the fail-closed `return false` (`:86-87`). `src/middleware.ts:147` then redirects.

**Alternatives excluded:**
- `src/hooks/use-navigation-items.ts` is generic over modules and needs no change.
- `src/components/layout/sidebar.tsx` already maps the `Building` icon (`iconMap`).
- `src/middleware.ts` only calls `canAccessRoute`.
- New route files do not exist yet, so they cannot be expected.
- The `navigation.organizations` translation key would be needed for the label. It is excluded as config, because the prompt asks about visibility and access only.

**Evidence:** `rg -n "OrganizationManagement|visible: false" src/lib/constants/navigation-modules.ts`; `rg -n "routeModuleMap|Default: Deny" src/lib/utils/route-permissions.ts`; `rg -n "canAccessRoute" src` → owner plus middleware only.

## 11. edit-new-ai-assistant-tool — editing-prep
**Why realistic:** Adding a function-calling tool is the most common extension of an LLM assistant.

**Expected (all):**
- `src/lib/ai/function-declarations.ts`: each `FunctionDeclaration` schema. The exported array at `:481-491` is what gets registered.
- `src/lib/ai/function-execution/index.ts`: `executeFunctionCall` switch (`:36-58`) from call name to `handle*` executor. An unknown name returns `Unknown function`.

**Alternatives excluded:**
- `src/lib/ai/firebase-ai-client.ts:56` passes the array through as `tools: [{ functionDeclarations }]`, so it needs no change.
- `src/hooks/use-ai-chat.ts:376` calls the dispatcher generically.
- `src/lib/ai/constants.ts` SYSTEM_PROMPT does not enumerate tool names (`rg -n "get_page_info|navigate_to_page" src/lib/ai/constants.ts` → no hits).
- The new executor file would be created, not inspected.

**Evidence:** `rg -n "functionDeclarations|executeFunctionCall" src`.

## 12. edit-group-admin-account-creation — editing-prep
**Why realistic:** This is a role-matrix change request. The allowed-role list and the submit branch live in different files, so editing only one silently fails: the dialog shows "insufficient permissions".

**Expected (all):**
- `src/lib/utils/role-filters.ts:38-48`: in org scope, `org_admin` gets `['org_user','org_group_admin']`, while `org_group_admin` and `org_user` get `[]`.
- `src/components/users/dialogs/create/create-user-dialog.tsx`:
  - `availableRoles` comes from `getAvailableRolesForCreation` (`:65-67`).
  - Submit handles only `system_admin` (`:148`) and `org_admin` (`:162`). Any other creator hits `toast.error(t('error.insufficientPermissions'))` (`:181`).
  - Field visibility also branches on these two roles (`:209`, `:215`).

**Alternatives excluded:**
- `src/components/users/user-dialog.tsx` is dead code (`UserDialog` is never imported).
- `create-user-schema.ts` enumerates assignable roles, but `org_user` is already allowed.
- `user.service.ts` `orgCreateUser` is reusable as-is.
- `user-management.tsx` gates the button on the backend `write` action, not on role names.

**Evidence:**
- `rg -n "getAvailableRolesForCreation" src` → owner plus dialog only.
- `rg -n "case 'org_admin'|case 'org_group_admin'|insufficientPermissions|currentUserRole\?\.name === '(system|org)_admin'" src/lib/utils/role-filters.ts src/components/users/dialogs/create/create-user-dialog.tsx`.
- `rg -n "UserDialog\b" src`.

---

## Confidence notes
- **Lowest:** task 4 (flow, 4 files, `all`). An agent might reasonably skip `login-form.tsx`, since the hook is the real orchestrator, or add `api-endpoints.ts` for the sign-in path. The four files kept are the ones that carry the asked-for behaviours.
- **Also watch:**
  - Task 5: `api-endpoints.ts` is required only because the prompt asks for the backend path.
  - Task 10: translation keys are deliberately out of scope.
