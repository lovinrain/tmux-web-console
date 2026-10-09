# Workspace frontend structure

Workspace navigation is split by responsibility so a session-picker change can
be understood without reading the entire tab rail or application coordinator.
The existing URLs, callbacks, keyboard shortcuts, CSS classes, and persistence
formats remain the contracts between these parts.

| Responsibility | Owner |
| --- | --- |
| Compose the tab rail, selection, nesting, groups, and dialog launch actions | `src/components/SessionWorkspaceNavigation.tsx` |
| Display the modal or floating session picker and own its input/focus behavior | `src/components/workspaceNavigation/WorkspaceTabSearchDialog.tsx` |
| Rank open tabs by title, tmux name, and group | `src/components/workspaceNavigation/search.ts` |
| Browse open, recent, and other live sessions | `src/components/workspaceNavigation/WorkspaceRecentsDialog.tsx` |
| Display a session row and its actions | `src/components/workspaceNavigation/WorkspaceSessionRow.tsx` |
| Build the available command catalogue | `src/components/workspaceNavigation/commands.ts` |
| Share session status, titles, parent descriptions, and workspace identity copy | `src/components/workspaceNavigation/presentation.ts` |
| Compute valid tab-movement targets | `src/components/workspaceNavigation/tabMovement.ts` |
| Share breakpoint and tab-rail sizing policy | `src/components/workspaceNavigation/viewport.ts` |
| Share static shortcut labels, element IDs, and navigation prop types | `src/components/workspaceNavigation/constants.ts`, `types.ts` |
| Provide the single active-pane session context | `src/components/workspaceNavigation/context.ts` |
| Explain new-window action failures | `src/components/workspaceNavigation/windowActions.tsx` |
| Own picker presentation and route/workspace lifetime | `src/useWorkspaceTabSearch.ts` |
| Parse and build workspace paths without browser side effects | `src/workspaceRoutes.ts` |
| Share session inventory streaming, recovery metadata, and polling fallback | `src/sessionInventory.ts` |

Import a constant, context, or type directly from its owner. Importing the full
navigation component for a shared value connects unrelated screens and their
tests to all navigation UI. Shared modules must not import the navigation
component or `App.tsx`; the application supplies callbacks and the live workspace
reference to the picker controller.

The picker owns its query and highlighted candidate. Live session metadata and
tab-order updates preserve a valid candidate. Session selection and saved
workspace/focus-sync persistence remain application responsibilities. The
controller remembers modal/floating presentation for the page, closes the picker
when its workspace is replaced or emptied, and keeps a floating picker open
while navigating within the workspace.

The active-pane context has one definition shared by navigation and pane boards.
Viewport thresholds also have one owner used by the rail, search picker, recents
dialog, and controller.

Dashboard, console, new-session, and pane-view inventory use the same stream
transport. Embedded pane consoles receive their parent's snapshots. Shared
read/unread markers come from the session registry through that inventory;
browser-local attention is only a fallback for an older backend.

The search component tests were moved from the navigation suite with their
assertions retained. A separate integration case checks that tabs, Overview,
and search agree on session status. Shared fixtures carry domain data and typed
navigation props; they do not import the navigation UI.

Start with the changed module's tests:

~~~bash
npm test -- src/components/workspaceNavigation/search.test.ts
npm test -- src/components/workspaceNavigation/WorkspaceTabSearchDialog.test.tsx
npm test -- src/useWorkspaceTabSearch.test.tsx src/workspaceRoutes.test.ts
npm run test:related -- src/components/workspaceNavigation/WorkspaceTabSearchDialog.tsx
~~~

Use the full frontend suite for changes spanning these boundaries. For browser
wiring, exercise Focus modal/floating selection, terminal input isolation,
desktop/mobile Overview, tab movement/groups, pane view, and focus sync as
appropriate. Build the tested frontend in a staging worktree as described in the
deployment guide.

Deferred command handoffs in tests should be flushed inside React `act` with a
controlled timer before sending the next key. For asynchronous actions, wait
for the completed UI state as well as the callback. This retains the behavioral
assertions while avoiding races against unfinished work.

Browser fixtures should state their viewport and UI mode explicitly. The
horizontal toolbar can crowd per-tab pointer actions at 1440 pixels; use a
sufficiently wide viewport when checking those actions and retain separate
sidebar/mobile coverage. Measure terminal fit against its available view and
control rows, rather than a fixed height that changes when header tools evolve.
Fuzzy-query fixtures should distinguish the intended command from the current
catalogue's other matches.
