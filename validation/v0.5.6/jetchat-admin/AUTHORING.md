# jetchat-admin — v0.5.6 holdout authoring record

- Repository commit: `c9256c06ff39fb2d3c4f5f73fe5be2439423cd9f` (clean detached worktree)
- Stack: Next.js (App Router) admin frontend, TypeScript/React, Firebase AI
- Task set: `tasks.json` sha256 `9b37b0d66c2abf3408fd357823faa992a31ae30ce1c2cdfecee50ae3bc1fdf98` (frozen before any v0.5.6 benchmark run on this repo)
- Tasks: 12 — navigation 3, flow 3, impact 3, editing-prep 3
- StellarCode used during authoring or review: **NO**

## Method

1. Author (fresh Opus agent) wrote tasks from the clean worktree using only git, ls/find, rg/grep, sed/cat and reading source; it was forbidden to run `stellar`, open `.stellar/`, or read the StellarCode repository (older validation folders hold tool output). Per-task rationale and file:line evidence: `authoring/AUTHORING-draft.md`.
2. Independent reviewer (separate fresh Opus agent, same restrictions) checked each task for filename/stem leaks, source grounding, over-breadth, ambiguity, match mode and category, with file:line evidence: `authoring/REVIEW.md`.
3. Reviewer changes applied verbatim (below); `stellar benchmark lint-tasks` (git-only checks: files exist at the commit, no filename leaks, flow ≥ 2 files) passed with 0 errors and 0 warnings; hash recorded.

## Changes from draft after independent review

- nav-malformed-ai-chart-rejection: expectedMatch any → all (the two files hold two different asked behaviours, not alternatives).
- impact-shared-date-picker-props: prompt reworded to drop the "date-range" file-stem and to ask explicitly for the picker itself plus every renderer.
- impact-ai-generation-settings-shape: added src/components/ai-assistant/dialogs/ai-assistant-dialog.tsx (direct consumer the draft missed).
- edit-new-ai-assistant-tool: prompt reworded ("function-call name" mirrored the function-* file stems).

## Tasks

| id | category | match | expected files | why realistic |
|---|---|---|---|---|
| nav-unauthenticated-redirect-and-token-cache | navigation | any | `src/middleware.ts` | When someone opens a dashboard URL without a valid session cookie, where does the app bounce them to the sign-in screen, and where is the backend token-verification result cached between requests (and for how long)? |
| nav-malformed-ai-chart-rejection | navigation | all | `src/components/ai-assistant/report/dynamic-chart-renderer.tsx`<br>`src/lib/ai/chart-validation.ts` | In the AI assistant's generated reports, where is an AI-produced chart specification checked for structural validity, and what decides to show an 'invalid configuration' error box instead of drawing the chart? |
| nav-all-organizations-account-listing | navigation | any | `src/hooks/use-users-list.ts` | On the admin-account management screen, when a system admin picks the 'All Organizations' option in the organization picker, which code decides to call the system-wide account listing endpoint instead of the organization/group-scoped one? |
| flow-sign-in-to-session-cookie | flow | all | `src/components/auth/login-form.tsx`<br>`src/hooks/use-auth.ts`<br>`src/lib/services/auth.ts`<br>`src/app/actions/auth.ts` | Trace what happens when an admin submits the email/password sign-in form: where the credentials go to Firebase and then to the backend sign-in endpoint, where accounts without any dashboard access are rejected, how the post-sign-in landing route is chosen, and where the 'remember me' choice becomes the session cookie's lifetime. |
| flow-member-disable-and-enable | flow | all | `src/app/[locale]/(dashboard)/members/[id]/page.tsx`<br>`src/lib/services/member.service.ts`<br>`src/lib/constants/api-endpoints.ts` | On a member's detail screen, trace disabling a member with an optional reason (and re-enabling them): from the confirm handler to the outgoing HTTP request, including which backend path is hit, and how the response updates the displayed 'disabled by / disabled at' fields. |
| flow-conversation-list-date-window | flow | all | `src/components/conversations/conversations-management.tsx`<br>`src/hooks/use-conversations-list.ts`<br>`src/lib/services/conversation.service.ts` | How does the conversation list get its rows? Trace from the default 30-day date window (or the date range the admin picks) through to the backend list request and its start_date/end_date query parameters. |
| impact-shared-date-picker-props | impact | all | `src/components/shared/date-range-filter.tsx`<br>`src/components/members/member-management.tsx`<br>`src/components/users/user-data-table.tsx`<br>`src/components/conversations/conversation-table.tsx` | The shared calendar-popover picker for choosing a from/to period, shown above the list tables, takes a value, a change callback and a placeholder translation key. If those props are renamed or their types change, which production files — the picker itself and every component that renders it — must be reviewed? |
| impact-browser-readable-access-cookie | impact | all | `src/middleware.ts`<br>`src/stores/permission-store.ts` | If the JSON shape of the non-httpOnly cookie that exposes the signed-in user's role and module access rights to browser code changes, which code writes that cookie and which code parses it? |
| impact-ai-generation-settings-shape | impact | all | `src/lib/firebase/remote-config.ts`<br>`src/lib/ai/firebase-ai-client.ts`<br>`src/hooks/use-ai-chat.ts`<br>`src/components/ai-assistant/dialogs/ai-assistant-dialog.tsx` | The AI assistant's model name, temperature, topK/topP and its two output-token limits are loaded at runtime from Firebase rather than hard-coded. If that settings object gains or renames a field, which production modules that load or consume it need review? |
| edit-expose-organizations-module | editing-prep | all | `src/lib/constants/navigation-modules.ts`<br>`src/lib/utils/route-permissions.ts` | The system-level organization management module is already defined but hidden from the left-hand menu, and its URL is refused for every role. Before exposing it to system admins, which files control its menu visibility and whether the server-side route guard lets a user holding that module through? |
| edit-new-ai-assistant-tool | editing-prep | all | `src/lib/ai/function-declarations.ts`<br>`src/lib/ai/function-execution/index.ts` | Before adding a new tool the AI assistant can call (for example 'search organizations'), which files define the tool schemas offered to the Gemini model and route a tool call returned by the model to the code that runs it? |
| edit-group-admin-account-creation | editing-prep | all | `src/lib/utils/role-filters.ts`<br>`src/components/users/dialogs/create/create-user-dialog.tsx` | Product wants organization group admins to be able to create plain organization users from the organization-scoped admin-account screen. Before changing this, which files decide which roles a creator may assign and which creator roles the new-account dialog's submit logic actually supports? |

Why each expected file is required, which plausible alternatives were excluded and why, and the verification command/lines for every task are in `authoring/AUTHORING-draft.md` and `authoring/REVIEW.md`.
