import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import type {
  WorkspacePaneLayout
} from "../api";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CheckIcon,
  CloseIcon,
  EditIcon,
  ExternalLinkIcon,
  FolderIcon,
  GridIcon,
  HistoryIcon,
  ListIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  TerminalIcon,
  TrashIcon,
  UnreadIcon,
  WindowCopyIcon,
  WindowMoveIcon,
} from "../icons";
import { sessionHasOnlyDeadPanes } from "../sessionLifecycle";
import {
  directShortcutAria,
  directShortcutLabel,
  launcherShortcutLabel,
  useShortcutSettings
} from "../shortcutSettings";
import type { Session } from "../types";
import { useWorkspaceSeparatorDrag } from "../useWorkspaceSeparatorDrag";
import { adjacentSeparatorCrossing } from "../workspaceSeparatorMovement";
import { WORKSPACE_SESSION_DRAG_TYPE } from "../workspaceSessionDrag";
import {
  expandWorkspaceTabSelection,
  MAX_WORKSPACE_TAB_GROUPS,
  moveWorkspaceSessions,
  previousWorkspaceSibling,
  workspaceSessionParent,
  workspaceSubtree,
  type WorkspaceTabGroup
} from "../workspaceState";
import { MAX_WORKSPACE_TABS } from "../workspaceValidation";
import "./DeadPaneTabs.css";
import { NEW_SESSION_PANEL_ID } from "./NewSessionScreen";
import { SessionAgentIcon, sessionAgentInfo } from "./SessionAgentIcon";
import { SessionHistoryDialog } from "./SessionHistoryDialog";
import { SessionTerminateDialog } from "./SessionTerminateDialog";
import {
  WorkspaceCommandPalette
} from "./WorkspaceCommandPalette";
import { WorkspaceGroupDialog } from "./WorkspaceGroupDialog";
import { WorkspaceQuickSwitcher } from "./WorkspaceQuickSwitcher";
import { WorkspaceSaveDialog } from "./WorkspaceSaveDialog";
import { WorkspaceSessionAddDialog } from "./WorkspaceSessionAddDialog";

import { buildWorkspaceCommands } from "./workspaceNavigation/commands";
import { MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID } from "./workspaceNavigation/constants";
import { ActivePaneSessionContext } from "./workspaceNavigation/context";
import { EMPTY_SESSION_PARENTS, sessionTreeContext, sessionTreeStyle, STATE_LABELS, tabTitle, WORKSPACE_PERSISTENCE_COPY, workspaceIdentityName, workspaceSessionState } from "./workspaceNavigation/presentation";
import { tabMoveResultIndex, tabMoveTargetIndex } from "./workspaceNavigation/tabMovement";
import type { SessionWorkspaceNavigationProps, WorkspaceTabOrientation } from "./workspaceNavigation/types";
import { clampDesktopTabRailWidth, clampDesktopTabRailWidthForViewport, COMPACT_DESKTOP_TAB_RAIL_MAX_WIDTH, DEFAULT_DESKTOP_TAB_RAIL_WIDTH, DESKTOP_TAB_RAIL_KEYBOARD_LARGE_STEP, DESKTOP_TAB_RAIL_KEYBOARD_STEP, isCompactWorkspaceViewport, MIN_DESKTOP_TAB_RAIL_WIDTH, useDesktopTabRailMaxWidth, useWorkspaceTabOrientation } from "./workspaceNavigation/viewport";
import { moveToNewWindowDisabledReason, newWindowFailureMessage, WorkspaceWindowActionError } from "./workspaceNavigation/windowActions";
import { WorkspaceRecentsDialog } from "./workspaceNavigation/WorkspaceRecentsDialog";
export type { OpenTabInNewWindowMode, OpenTabInNewWindowResult, SessionWorkspaceNavigationProps, WorkspacePersistenceState, WorkspaceTabOrientation } from "./workspaceNavigation/types";


type WorkspaceTabDropEdge = "before" | "after";

interface WorkspaceTabDragTarget {
  kind: "tab" | "group" | "nest" | "root";
  id: string;
  edge: WorkspaceTabDropEdge;
  targetIndex: number;
}

interface WorkspaceTabDragState {
  groupId?: string;
  sessionNames: string[];
  target: WorkspaceTabDragTarget | null;
}

function sameSessionNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((sessionName, index) => sessionName === right[index]);
}

function workspaceTabDropEdge(
  element: HTMLElement,
  clientX: number,
  clientY: number,
  orientation: WorkspaceTabOrientation,
): WorkspaceTabDropEdge {
  const bounds = element.getBoundingClientRect();
  const coordinate = orientation === "vertical" ? clientY : clientX;
  const midpoint = orientation === "vertical"
    ? bounds.top + bounds.height / 2
    : bounds.left + bounds.width / 2;
  return coordinate < midpoint ? "before" : "after";
}

function workspaceTabDropIndex(
  sourceIndex: number,
  boundaryIndex: number,
  tabCount: number,
): number {
  const targetIndex = boundaryIndex - (sourceIndex < boundaryIndex ? 1 : 0);
  return Math.max(0, Math.min(tabCount - 1, targetIndex));
}

function tabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
  const tabList = event.currentTarget.closest("[role='tablist']");
  const orientation = tabList?.getAttribute("aria-orientation") === "vertical"
    ? "vertical"
    : "horizontal";
  const previousKey = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
  const nextKey = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  if (![previousKey, nextKey, "Home", "End"].includes(event.key)) return;
  const tabs = tabList
    ? Array.from(tabList.querySelectorAll<HTMLButtonElement>("[role='tab']"))
    : [];
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0 || tabs.length === 0) return;

  event.preventDefault();
  let nextIndex = currentIndex;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = tabs.length - 1;
  if (event.key === previousKey) nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  if (event.key === nextKey) nextIndex = (currentIndex + 1) % tabs.length;
  tabs[nextIndex]?.focus();
}

function assignedPaneSessionCount(node: WorkspacePaneLayout["root"]): number {
  if (node.kind === "pane") return Number(Boolean(node.session));
  return assignedPaneSessionCount(node.first) + assignedPaneSessionCount(node.second);
}

export function SessionWorkspaceNavigation(props: SessionWorkspaceNavigationProps) {
  const {
    activeSession,
    openSessions,
    recentSessions,
    groups = [],
    sessionParents = EMPTY_SESSION_PARENTS,
    separators = [],
    separatorsBefore = [],
    separatorsBusy = false,
    separatorsError = "",
    onChangeSeparator,
    sessions,
    recentsOpen,
    orientation: preferredOrientation = "horizontal",
    desktopTabRailWidth,
    onDesktopTabRailWidthChange,
    tabsVisible = true,
    tabActionsVisible = true,
    newSessionActive = false,
    onSelect,
    onCloseTab,
    onMoveTab,
    onMoveTabs,
    onReparentSession,
    onSortTabsByWorkingState,
    onToggleTabActions,
    onOpenTabInNewWindow,
    onSaveTabGroup,
    onDeleteTabGroup,
    onToggleTabGroup,
    onMoveTabGroup,
    onCloseNewSession,
    onOpenRecents,
    onCloseRecents,
    onOpenDashboard,
    dashboardWindowHref,
    onNewSession,
    onAddSession,
    onQuickNewSession,
    onToggleCallbackSession,
    quickNewSessionBusy = false,
    quickNewSessionError = null,
    onDismissQuickNewSessionError,
    onOpenTabSearch,
    paneLayouts = [],
    activePaneLayoutId = null,
    paneLayoutsBusy = false,
    onSelectPaneLayout,
    onCreatePaneLayout,
    workspacePersistenceState = "unsaved",
    activeWorkspaceId = null,
    workspaceName,
    onSwitchWorkspace,
    onSaveWorkspace,
    onRenameWorkspace,
    onSessionTerminated,
    missingSessionCount = 0,
    onRecreateAllMissing,
    recoverableSessions = [],
    onRecreateSession,
  } = props;
  const { orientation, compactViewport } = useWorkspaceTabOrientation(
    preferredOrientation,
  );
  const [sessionHistoryOpen, setSessionHistoryOpen] = useState(false);
  const activePaneSession = useContext(ActivePaneSessionContext);
  const [sessionAddOpen, setSessionAddOpen] = useState(false);
  const { bindings: shortcutBindings } = useShortcutSettings();
  const quickSessionShortcutHint = (() => {
    const launcher = launcherShortcutLabel(
      shortcutBindings["workspace-quick-new-session"],
    );
    const launcherChord = directShortcutLabel(shortcutBindings["shortcut-launcher"]);
    return launcher && launcherChord ? `${launcherChord}, then ${launcher}` : null;
  })();
  const desktopTabRailMaxWidth = useDesktopTabRailMaxWidth();
  const [internalDesktopTabRailWidth, setInternalDesktopTabRailWidth] = useState(() => (
    clampDesktopTabRailWidth(desktopTabRailWidth ?? DEFAULT_DESKTOP_TAB_RAIL_WIDTH)
  ));
  const committedDesktopTabRailWidth = clampDesktopTabRailWidthForViewport(
    desktopTabRailWidth ?? internalDesktopTabRailWidth,
    desktopTabRailMaxWidth,
  );
  const [liveDesktopTabRailWidth, setLiveDesktopTabRailWidth] = useState(
    committedDesktopTabRailWidth,
  );
  const liveDesktopTabRailWidthRef = useRef(liveDesktopTabRailWidth);
  const desktopTabRailDragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const visibleDesktopTabRailWidth = clampDesktopTabRailWidthForViewport(
    liveDesktopTabRailWidth,
    desktopTabRailMaxWidth,
  );
  liveDesktopTabRailWidthRef.current = visibleDesktopTabRailWidth;
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const persistenceStatusRef = useRef<HTMLSpanElement>(null);
  const recentsOpenRef = useRef(recentsOpen);
  recentsOpenRef.current = recentsOpen;
  const recentsScrollTopRef = useRef(0);
  const completedTerminationRef = useRef<Session | null>(null);
  const focusActiveTabAfterClose = useRef(false);
  const previousTabNavigation = useRef<{
    activeSession: string | null;
    activeWorkspaceId: string | null;
    newSessionActive: boolean;
    orientation: WorkspaceTabOrientation;
    tabsVisible: boolean;
  } | null>(null);
  const reorderFocusIntent = useRef<{
    sessionName: string;
    direction: "previous" | "next";
  } | null>(null);
  const groupReorderFocusIntent = useRef<{
    groupId: string;
    direction: "previous" | "next";
  } | null>(null);
  const groupDialogTriggerRef = useRef<HTMLElement | null>(null);
  const workspaceTabSelectionAnchorRef = useRef<string | null>(activeSession);
  const workspaceTabDragSessionsRef = useRef<string[]>([]);
  const workspaceTabDragGroupRef = useRef<string | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [saveAfterRecents, setSaveAfterRecents] = useState(false);
  const [terminateTarget, setTerminateTarget] = useState<Session | null>(null);
  const [recentsQuery, setRecentsQuery] = useState("");
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const [windowActionError, setWindowActionError] = useState("");
  const [selectedWorkspaceTabs, setSelectedWorkspaceTabs] = useState<string[]>([]);
  const [deadTabsOnlySelected, setDeadTabsOnlySelected] = useState(false);
  const [workspaceTabDrag, setWorkspaceTabDrag] = useState<WorkspaceTabDragState | null>(
    null,
  );
  const [groupDialog, setGroupDialog] = useState<{
    groupId: string | null;
    initialSession: string | null;
  } | null>(null);
  const sessionsByName = useMemo(
    () => new Map(sessions.map((session) => [session.name, session])),
    [sessions],
  );
  const deadSessionTabs = useMemo(
    () => openSessions.filter((name) => sessionHasOnlyDeadPanes(sessionsByName.get(name))),
    [openSessions, sessionsByName],
  );
  const groupsBySession = useMemo(() => {
    const result = new Map<string, WorkspaceTabGroup>();
    groups.forEach((group) => group.tabs.forEach((sessionName) => {
      result.set(sessionName, group);
    }));
    return result;
  }, [groups]);
  const workspaceTabItems = useMemo<Array<
    { kind: "tab"; sessionName: string } | { kind: "group"; group: WorkspaceTabGroup }
  >>(() => {
    const items: Array<
      { kind: "tab"; sessionName: string } | { kind: "group"; group: WorkspaceTabGroup }
    > = [];
    openSessions.forEach((sessionName) => {
      const group = groupsBySession.get(sessionName);
      if (!group) items.push({ kind: "tab", sessionName });
      else if (group.tabs[0] === sessionName) items.push({ kind: "group", group });
    });
    return items;
  }, [groupsBySession, openSessions]);
  const closedRecentCount = recentSessions.filter((name) => !openSessions.includes(name)).length;
  const addableSessionCount = sessions.filter((session) => (
    !openSessions.includes(session.name)
  )).length;
  const persistenceCopy = workspacePersistenceState === "unsaved"
    ? null
    : WORKSPACE_PERSISTENCE_COPY[workspacePersistenceState];
  const identityName = workspaceIdentityName(workspacePersistenceState, workspaceName);
  const canRenameWorkspace = Boolean(
    activeWorkspaceId
    && onRenameWorkspace
    && ["saved", "limited"].includes(workspacePersistenceState),
  );
  const showRenameWorkspaceButton = canRenameWorkspace && !compactViewport;
  const newSessionDisabled = newSessionActive || workspacePersistenceState === "loading";
  const quickNewSessionDisabled = quickNewSessionBusy
    || workspacePersistenceState === "loading";
  const windowMoveDisabledReason = moveToNewWindowDisabledReason(
    workspacePersistenceState,
  );
  const canCreateGroup = Boolean(
    onSaveTabGroup
    && openSessions.length > 0
    && groups.length < MAX_WORKSPACE_TAB_GROUPS,
  );
  const desktopTabDragEnabled = Boolean(
    onMoveTab
    && (openSessions.length > 1 || (activePaneLayoutId && openSessions.length > 0))
    && !compactViewport
    && tabsVisible,
  );
  const desktopTabMultiSelectEnabled = !compactViewport && tabsVisible
    && Boolean(onMoveTabs || props.onBulkSessionAction);
  const groupDragEnabled = desktopTabDragEnabled && Boolean(onMoveTabs)
    && !deadTabsOnlySelected
    && workspacePersistenceState !== "loading" && workspacePersistenceState !== "error"
    && !separatorsBusy;
  const separatorDragEnabled = Boolean(props.onCrossSeparator && orientation === "vertical"
    && !compactViewport && tabsVisible && !separatorsBusy
    && workspacePersistenceState !== "loading" && workspacePersistenceState !== "error");
  const nestingEnabled = Boolean(onReparentSession && workspacePersistenceState !== "loading"
    && workspacePersistenceState !== "error" && !separatorsBusy);
  const placementSession = newSessionActive ? null : activeSession ?? activePaneSession;
  const placementSessionAvailable = Boolean(placementSession && openSessions.includes(placementSession));
  const unreadTarget = placementSessionAvailable && placementSession && sessionsByName.has(placementSession)
    ? placementSession : null;
  const unreadTargetUnchecked = Boolean(unreadTarget && props.uncheckedReadySessions?.has(unreadTarget));
  const unreadLabel = unreadTargetUnchecked ? "Already unread" : "Mark as unread";
  const unreadHint = !unreadTarget
    ? "Select a live session to mark as unread"
    : unreadTargetUnchecked
      ? `${tabTitle(unreadTarget, sessionsByName)} is already unread`
      : `Mark ${tabTitle(unreadTarget, sessionsByName)} as unread until its next visit`;
  const placementParent = placementSessionAvailable
    ? workspaceSessionParent(placementSession!, sessionParents) : undefined;
  const placementPreviousSibling = placementSessionAvailable
    ? previousWorkspaceSibling({ openSessions, parents: sessionParents, groups }, placementSession!)
    : null;
  const placementLevelUnavailableHint = !placementSessionAvailable
    ? "Select a session to change its nesting level"
    : !nestingEnabled ? "Wait for the workspace to finish syncing" : null;
  const placementUpHint = placementLevelUnavailableHint ?? (placementParent
    ? `Move ${tabTitle(placementSession!, sessionsByName)} out of ${tabTitle(placementParent, sessionsByName)}; its nested sessions come with it`
    : "This session is already at the top level");
  const placementDownHint = placementLevelUnavailableHint ?? (placementPreviousSibling
    ? `Nest ${tabTitle(placementSession!, sessionsByName)} under ${tabTitle(placementPreviousSibling, sessionsByName)}; its nested sessions come with it`
    : "There is no previous session at this level in the same tab group");
  const placementHint = !placementSessionAvailable
    ? "Select a session to move or nest"
    : !nestingEnabled
      ? "Wait for the workspace to finish syncing"
      : `Organize ${tabTitle(placementSession!, sessionsByName)}: change its nesting level, choose a parent session, or move to another workspace`;
  const changePlacementLevel = (direction: "up" | "down") => {
    if (!nestingEnabled || !placementSessionAvailable || !placementSession) return;
    const target = direction === "up"
      ? placementParent ? workspaceSessionParent(placementParent, sessionParents) ?? null : undefined
      : placementPreviousSibling ?? undefined;
    if (target === undefined) return;
    try {
      onReparentSession?.(placementSession, target);
      setReorderAnnouncement(`${tabTitle(placementSession, sessionsByName)} moved ${direction} one level.`);
      window.requestAnimationFrame(() => activeTabRef.current?.focus());
    } catch (error) {
      setReorderAnnouncement(error instanceof Error ? error.message : "Unable to move this session.");
    }
  };
  const selectedWorkspaceTabSet = useMemo(
    () => new Set(selectedWorkspaceTabs),
    [selectedWorkspaceTabs],
  );
  const orderedSelection = useMemo(
    () => openSessions.filter((name) => selectedWorkspaceTabSet.has(name)
      && (!deadTabsOnlySelected || deadSessionTabs.includes(name))),
    [deadSessionTabs, deadTabsOnlySelected, openSessions, selectedWorkspaceTabSet],
  );
  const onTabSelectionChange = props.onTabSelectionChange;
  useEffect(() => {
    onTabSelectionChange?.(orderedSelection);
  }, [onTabSelectionChange, orderedSelection]);
  useEffect(() => () => onTabSelectionChange?.([]), [onTabSelectionChange]);
  useEffect(() => {
    setSelectedWorkspaceTabs([]);
    setDeadTabsOnlySelected(false);
  }, [activeWorkspaceId]);
  const unselectedTabs = openSessions.filter((name) => !selectedWorkspaceTabSet.has(name));
  const previousSelectionNeighbor = openSessions[openSessions.indexOf(orderedSelection[0]) - 1];
  const nextSelectionNeighbor = openSessions[openSessions.indexOf(orderedSelection.at(-1)!) + 1];
  const selectionMoveTargets = {
    previous: previousSelectionNeighbor ? unselectedTabs.indexOf(previousSelectionNeighbor) : -1,
    next: nextSelectionNeighbor ? unselectedTabs.indexOf(nextSelectionNeighbor) + 1 : -1,
  };
  const separatorCrossing = (names: string[], direction: "previous" | "next") => (
    orientation === "vertical" && !compactViewport && props.onCrossSeparator
      ? adjacentSeparatorCrossing(openSessions, names, separatorsBefore, separators, direction) : null
  );
  const crossAdjacentSeparator = (names: string[], direction: "previous" | "next") => {
    const crossing = separatorCrossing(names, direction);
    if (!crossing) return false;
    if (!separatorsBusy) props.onCrossSeparator?.(crossing);
    return true;
  };

  const clearWorkspaceTabSelection = useCallback((announce = true) => {
    setDeadTabsOnlySelected(false);
    if (selectedWorkspaceTabs.length === 0) return;
    setSelectedWorkspaceTabs([]);
    if (announce) setReorderAnnouncement("Tab move selection cleared.");
  }, [selectedWorkspaceTabs.length]);

  const updateWorkspaceTabSelection = useCallback((
    sessionName: string,
    range: boolean,
    additive: boolean,
  ) => {
    if (!desktopTabMultiSelectEnabled || !openSessions.includes(sessionName)) return;
    setDeadTabsOnlySelected(false);

    let candidates: string[];
    if (range) {
      const currentAnchor = workspaceTabSelectionAnchorRef.current;
      const anchor = currentAnchor && openSessions.includes(currentAnchor)
        ? currentAnchor
        : activeSession && openSessions.includes(activeSession)
          ? activeSession
          : sessionName;
      workspaceTabSelectionAnchorRef.current = anchor;
      const anchorIndex = openSessions.indexOf(anchor);
      const targetIndex = openSessions.indexOf(sessionName);
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const selectedRange = openSessions.slice(start, end + 1);
      candidates = additive
        ? [...selectedWorkspaceTabs, ...selectedRange]
        : selectedRange;
    } else {
      workspaceTabSelectionAnchorRef.current = sessionName;
      const unit = expandWorkspaceTabSelection(openSessions, groups, [sessionName], sessionParents);
      const current = new Set(selectedWorkspaceTabs);
      const remove = unit.every((name) => current.has(name));
      candidates = remove
        ? selectedWorkspaceTabs.filter((name) => !unit.includes(name))
        : [...selectedWorkspaceTabs, ...unit];
    }

    const next = expandWorkspaceTabSelection(openSessions, groups, candidates, sessionParents);
    setSelectedWorkspaceTabs(next);
    setReorderAnnouncement(next.length === 0
      ? "Tab move selection cleared."
      : `${next.length} tab${next.length === 1 ? "" : "s"} selected for moving. Drag any selected tab to move ${next.length === 1 ? "it" : "them"} together.`);
  }, [
    activeSession,
    desktopTabMultiSelectEnabled,
    groups,
    openSessions,
    selectedWorkspaceTabs,
    sessionParents,
  ]);

  const selectWorkspaceTab = useCallback((
    event: ReactMouseEvent<HTMLButtonElement>,
    sessionName: string,
  ) => {
    const additive = event.ctrlKey || event.metaKey;
    if (desktopTabMultiSelectEnabled && (event.shiftKey || additive)) {
      event.preventDefault();
      updateWorkspaceTabSelection(sessionName, event.shiftKey, additive);
      return;
    }
    workspaceTabSelectionAnchorRef.current = sessionName;
    clearWorkspaceTabSelection(false);
    onSelect(sessionName);
  }, [
    clearWorkspaceTabSelection,
    desktopTabMultiSelectEnabled,
    onSelect,
    updateWorkspaceTabSelection,
  ]);

  useEffect(() => {
    setSelectedWorkspaceTabs((current) => {
      if (!desktopTabMultiSelectEnabled) return current.length > 0 ? [] : current;
      // Cleanup selects exact dead sessions, even inside mixed groups or trees.
      // A respawned pane removes its session from this selection on refresh.
      const next = deadTabsOnlySelected
        ? current.filter((name) => deadSessionTabs.includes(name))
        : expandWorkspaceTabSelection(openSessions, groups, current, sessionParents);
      return sameSessionNames(current, next) ? current : next;
    });
  }, [deadSessionTabs, deadTabsOnlySelected, desktopTabMultiSelectEnabled, groups, openSessions, sessionParents]);

  const selectDeadSessionTabs = () => {
    setDeadTabsOnlySelected(true);
    workspaceTabSelectionAnchorRef.current = deadSessionTabs[0] ?? null;
    setSelectedWorkspaceTabs(deadSessionTabs);
    setReorderAnnouncement(`${deadSessionTabs.length} dead session tab${deadSessionTabs.length === 1 ? "" : "s"} selected. Close tabs to remove them here, or End sessions to remove them from tmux.`);
  };

  useEffect(() => {
    if (selectedWorkspaceTabs.length > 0) return;
    workspaceTabSelectionAnchorRef.current = activeSession && openSessions.includes(activeSession)
      ? activeSession
      : null;
  }, [activeSession, openSessions, selectedWorkspaceTabs.length]);

  const finishWorkspaceTabDrag = useCallback(() => {
    workspaceTabDragGroupRef.current = null;
    workspaceTabDragSessionsRef.current = [];
    setWorkspaceTabDrag(null);
  }, []);

  useEffect(() => {
    if (workspaceTabDragGroupRef.current) finishWorkspaceTabDrag();
  }, [activeWorkspaceId, finishWorkspaceTabDrag]);

  const clearWorkspaceTabDropTarget = useCallback(() => {
    setWorkspaceTabDrag((current) => (
      current?.target ? { ...current, target: null } : current
    ));
  }, []);

  const previewWorkspaceTabDrop = useCallback((target: WorkspaceTabDragTarget) => {
    const sessionNames = workspaceTabDragSessionsRef.current;
    if (sessionNames.length === 0) return;
    setWorkspaceTabDrag((current) => {
      if (
        current
        && sameSessionNames(current.sessionNames, sessionNames)
        && current.target?.kind === target.kind
        && current.target.id === target.id
        && current.target.edge === target.edge
        && current.target.targetIndex === target.targetIndex
      ) return current;
      return { sessionNames, target, groupId: workspaceTabDragGroupRef.current ?? undefined };
    });
  }, []);

  const startWorkspaceTabDrag = useCallback((
    event: ReactDragEvent<HTMLButtonElement>,
    sessionName: string,
  ) => {
    if (!desktopTabDragEnabled) {
      event.preventDefault();
      return;
    }
    const selectedDrag = selectedWorkspaceTabSet.has(sessionName)
      ? selectedWorkspaceTabs
      : [];
    const sessionNames = selectedDrag.length > 1 && onMoveTabs
      ? selectedDrag
      : [sessionName];
    if (selectedDrag.length === 0 && selectedWorkspaceTabs.length > 0) {
      setSelectedWorkspaceTabs([]);
    }
    workspaceTabDragGroupRef.current = null;
    workspaceTabDragSessionsRef.current = sessionNames;
    setWorkspaceTabDrag({ sessionNames, target: null });
    event.dataTransfer.effectAllowed = "move";
    // A pane accepts the grabbed session, even when tabs are multi-selected.
    event.dataTransfer.setData(WORKSPACE_SESSION_DRAG_TYPE, sessionName);
    event.dataTransfer.setData("text/plain", sessionNames.join("\n"));
    if (sessionNames.length > 1) {
      event.dataTransfer.setData("application/x-muxdeck-tabs", JSON.stringify(sessionNames));
    }
  }, [
    desktopTabDragEnabled,
    onMoveTabs,
    selectedWorkspaceTabSet,
    selectedWorkspaceTabs,
  ]);

  const startWorkspaceGroupDrag = (
    event: ReactDragEvent<HTMLButtonElement>, group: WorkspaceTabGroup,
  ) => {
    if (!groupDragEnabled) { event.preventDefault(); return; }
    event.stopPropagation();
    clearWorkspaceTabSelection(false);
    workspaceTabDragGroupRef.current = group.id;
    workspaceTabDragSessionsRef.current = [...group.tabs];
    setWorkspaceTabDrag({ sessionNames: [...group.tabs], target: null, groupId: group.id });
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-muxdeck-tabs", JSON.stringify(group.tabs));
    event.dataTransfer.setData("text/plain", group.tabs.join("\n"));
  };

  const tabDragTarget = useCallback((
    targetSessionName: string,
    element: HTMLElement,
    clientX: number,
    clientY: number,
  ): WorkspaceTabDragTarget | null => {
    const sourceSessionNames = workspaceTabDragSessionsRef.current;
    const sourceSessionName = sourceSessionNames[0];
    if (!sourceSessionName) return null;
    const sourceIndex = openSessions.indexOf(sourceSessionName);
    const targetIndex = openSessions.indexOf(targetSessionName);
    if (sourceIndex < 0 || targetIndex < 0) return null;

    if (nestingEnabled && sourceSessionNames.length === 1 && !workspaceTabDragGroupRef.current) {
      const bounds = element.getBoundingClientRect();
      const length = orientation === "vertical" ? bounds.height : bounds.width;
      const offset = orientation === "vertical" ? clientY - bounds.top : clientX - bounds.left;
      if (length > 0 && offset >= length * 0.25 && offset <= length * 0.75) {
        if (workspaceSubtree(sourceSessionName, openSessions, sessionParents).includes(targetSessionName)) return null;
        return { kind: "nest", id: targetSessionName, edge: "after", targetIndex };
      }
    }

    if (sourceSessionNames.length > 1 || workspaceTabDragGroupRef.current) {
      const selected = new Set(sourceSessionNames);
      if (selected.has(targetSessionName)) return null;
      const targetGroup = groupsBySession.get(targetSessionName);
      const edge = workspaceTabDropEdge(element, clientX, clientY, orientation);
      const blockStart = targetGroup
        ? openSessions.indexOf(targetGroup.tabs[0])
        : targetIndex;
      const blockEnd = targetGroup
        ? openSessions.indexOf(targetGroup.tabs.at(-1)!)
        : targetIndex;
      const boundaryIndex = edge === "before" ? blockStart : blockEnd + 1;
      return {
        kind: targetGroup ? "group" : "tab",
        id: targetGroup?.id ?? targetSessionName,
        edge,
        targetIndex: openSessions
          .slice(0, boundaryIndex)
          .filter((sessionName) => !selected.has(sessionName)).length,
      };
    }

    const sourceGroup = groupsBySession.get(sourceSessionName);
    const targetGroup = groupsBySession.get(targetSessionName);
    if (sourceGroup?.id !== targetGroup?.id || targetGroup?.collapsed) return null;

    const edge = workspaceTabDropEdge(element, clientX, clientY, orientation);
    const boundaryIndex = targetIndex + (edge === "after" ? 1 : 0);
    return {
      kind: "tab",
      id: targetSessionName,
      edge,
      targetIndex: workspaceTabDropIndex(
        sourceIndex,
        boundaryIndex,
        openSessions.length,
      ),
    };
  }, [groupsBySession, nestingEnabled, openSessions, orientation, sessionParents]);

  const groupDragTarget = useCallback((
    group: WorkspaceTabGroup,
    element: HTMLElement,
    clientX: number,
    clientY: number,
  ): WorkspaceTabDragTarget | null => {
    const sourceSessionNames = workspaceTabDragSessionsRef.current;
    const sourceSessionName = sourceSessionNames[0];
    if (!sourceSessionName) return null;
    const sourceIndex = openSessions.indexOf(sourceSessionName);
    const groupStart = openSessions.indexOf(group.tabs[0]);
    const groupEnd = openSessions.indexOf(group.tabs.at(-1)!);
    if (sourceIndex < 0 || groupStart < 0 || groupEnd < groupStart) return null;

    const edge = workspaceTabDropEdge(element, clientX, clientY, orientation);
    const boundaryIndex = edge === "before" ? groupStart : groupEnd + 1;
    if (sourceSessionNames.length > 1 || workspaceTabDragGroupRef.current) {
      const selected = new Set(sourceSessionNames);
      if (group.tabs.some((sessionName) => selected.has(sessionName))) return null;
      return {
        kind: "group",
        id: group.id,
        edge,
        targetIndex: openSessions
          .slice(0, boundaryIndex)
          .filter((sessionName) => !selected.has(sessionName)).length,
      };
    }
    if (groupsBySession.has(sourceSessionName)) return null;
    return {
      kind: "group",
      id: group.id,
      edge,
      targetIndex: workspaceTabDropIndex(
        sourceIndex,
        boundaryIndex,
        openSessions.length,
      ),
    };
  }, [groupsBySession, openSessions, orientation]);

  const nudgeWorkspaceTabViewport = useCallback((
    element: HTMLElement,
    clientX: number,
    clientY: number,
  ) => {
    const viewport = element.closest<HTMLElement>(".workspace-tab-viewport");
    if (!viewport?.scrollBy) return;
    const bounds = viewport.getBoundingClientRect();
    const coordinate = orientation === "vertical" ? clientY : clientX;
    const start = orientation === "vertical" ? bounds.top : bounds.left;
    const end = orientation === "vertical" ? bounds.bottom : bounds.right;
    const threshold = Math.min(48, Math.max(24, (end - start) * 0.15));
    const delta = coordinate < start + threshold
      ? -20
      : coordinate > end - threshold
        ? 20
        : 0;
    if (!delta) return;
    viewport.scrollBy(orientation === "vertical" ? { top: delta } : { left: delta });
  }, [orientation]);

  const separatorDrag = useWorkspaceSeparatorDrag({
    enabled: separatorDragEnabled, workspaceId: activeWorkspaceId ?? null,
    tabs: openSessions, before: separatorsBefore, after: separators,
    onMove: props.onCrossSeparator, onDragOver: nudgeWorkspaceTabViewport,
  });

  const dragOverWorkspaceTab = useCallback((
    event: ReactDragEvent<HTMLDivElement>,
    targetSessionName: string,
  ) => {
    const target = tabDragTarget(
      targetSessionName,
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    if (!target) {
      clearWorkspaceTabDropTarget();
      if (workspaceTabDragSessionsRef.current.length > 0) event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    previewWorkspaceTabDrop(target);
    nudgeWorkspaceTabViewport(event.currentTarget, event.clientX, event.clientY);
  }, [clearWorkspaceTabDropTarget, nudgeWorkspaceTabViewport, previewWorkspaceTabDrop, tabDragTarget]);

  const dragOverWorkspaceTabGroup = useCallback((
    event: ReactDragEvent<HTMLDivElement>,
    group: WorkspaceTabGroup,
  ) => {
    const target = groupDragTarget(
      group,
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    previewWorkspaceTabDrop(target);
    nudgeWorkspaceTabViewport(event.currentTarget, event.clientX, event.clientY);
  }, [groupDragTarget, nudgeWorkspaceTabViewport, previewWorkspaceTabDrop]);

  const commitWorkspaceTabDrop = useCallback((target: WorkspaceTabDragTarget) => {
    const sourceGroupId = workspaceTabDragGroupRef.current;
    const sourceSessionNames = workspaceTabDragSessionsRef.current;
    const sourceSessionName = sourceSessionNames[0];
    const sourceIndex = sourceSessionName
      ? openSessions.indexOf(sourceSessionName)
      : -1;
    finishWorkspaceTabDrag();
    if (target.kind === "nest" || target.kind === "root") {
      if (sourceGroupId || !nestingEnabled || !sourceSessionName || sourceSessionNames.length !== 1 || !onReparentSession) return;
      try {
        onReparentSession(sourceSessionName, target.kind === "root" ? null : target.id);
        setReorderAnnouncement(target.kind === "root"
          ? `${tabTitle(sourceSessionName, sessionsByName)} moved to the top level.`
          : `${tabTitle(sourceSessionName, sessionsByName)} nested under ${tabTitle(target.id, sessionsByName)}.`);
      } catch (error) {
        setReorderAnnouncement(error instanceof Error ? error.message : "Unable to move this session.");
      }
      return;
    }
    if (sourceSessionNames.length > 1 || sourceGroupId) {
      if (!onMoveTabs) return;
      const preview = moveWorkspaceSessions({
        openSessions: [...openSessions],
        recentSessions: [],
        groups: [...groups],
        parents: sessionParents,
      }, sourceSessionNames, target.targetIndex);
      if (sameSessionNames(preview.openSessions, openSessions)) return;
      onMoveTabs(sourceSessionNames, target.targetIndex);
      const firstIndex = Math.min(...sourceSessionNames.map((sessionName) => (
        preview.openSessions.indexOf(sessionName)
      )));
      const lastIndex = firstIndex + sourceSessionNames.length - 1;
      setReorderAnnouncement(
        sourceGroupId
          ? `${groups.find((group) => group.id === sourceGroupId)?.name ?? "Session"} group moved with all ${sourceSessionNames.length} sessions. Their nesting was preserved.`
          : `${sourceSessionNames.length} selected tabs moved to positions ${firstIndex + 1} through ${lastIndex + 1} of ${openSessions.length}. Their relative order was preserved.`,
      );
      return;
    }
    if (
      !sourceSessionName
      || !onMoveTab
      || sourceIndex < 0
      || sourceIndex === target.targetIndex
    ) return;
    onMoveTab(sourceSessionName, target.targetIndex);
    const resultIndex = tabMoveResultIndex(
      openSessions,
      groups,
      sourceSessionName,
      target.targetIndex,
      sessionParents,
    );
    setReorderAnnouncement(
      `${tabTitle(sourceSessionName, sessionsByName)} moved to position ${resultIndex + 1} of ${openSessions.length}.`,
    );
  }, [
    finishWorkspaceTabDrag,
    groups,
    onMoveTab,
    onMoveTabs,
    onReparentSession,
    nestingEnabled,
    openSessions,
    sessionParents,
    sessionsByName,
  ]);

  const dropOnWorkspaceTab = useCallback((
    event: ReactDragEvent<HTMLDivElement>,
    targetSessionName: string,
  ) => {
    const target = tabDragTarget(
      targetSessionName,
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    commitWorkspaceTabDrop(target);
  }, [commitWorkspaceTabDrop, tabDragTarget]);

  const dropOnWorkspaceTabGroup = useCallback((
    event: ReactDragEvent<HTMLDivElement>,
    group: WorkspaceTabGroup,
  ) => {
    const target = groupDragTarget(
      group,
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    commitWorkspaceTabDrop(target);
  }, [commitWorkspaceTabDrop, groupDragTarget]);

  useEffect(() => {
    const draggedSessions = workspaceTabDragSessionsRef.current;
    const draggedSession = draggedSessions[0];
    const draggedGroup = draggedSession
      ? groupsBySession.get(draggedSession)
      : undefined;
    if (workspaceTabDragGroupRef.current) {
      if (groupDragEnabled && draggedGroup?.id === workspaceTabDragGroupRef.current
        && sameSessionNames(draggedGroup.tabs, draggedSessions)) return;
      finishWorkspaceTabDrag();
      return;
    }
    if (
      desktopTabDragEnabled
      && (!draggedSession || openSessions.includes(draggedSession))
      && draggedSessions.every((sessionName) => openSessions.includes(sessionName))
      && (draggedSessions.length > 1
        ? desktopTabMultiSelectEnabled
        : !draggedGroup || (!draggedGroup.collapsed && draggedGroup.tabs.length > 1))
    ) return;
    finishWorkspaceTabDrag();
  }, [
    desktopTabDragEnabled,
    desktopTabMultiSelectEnabled,
    finishWorkspaceTabDrag,
    groupsBySession,
    groupDragEnabled,
    openSessions,
  ]);

  const previewDesktopTabRailWidth = useCallback((width: number) => {
    const nextWidth = clampDesktopTabRailWidthForViewport(width, desktopTabRailMaxWidth);
    liveDesktopTabRailWidthRef.current = nextWidth;
    setLiveDesktopTabRailWidth(nextWidth);
    return nextWidth;
  }, [desktopTabRailMaxWidth]);

  const commitDesktopTabRailWidth = useCallback((width: number) => {
    const nextWidth = previewDesktopTabRailWidth(width);
    if (desktopTabRailWidth === undefined) setInternalDesktopTabRailWidth(nextWidth);
    if (nextWidth !== committedDesktopTabRailWidth) {
      onDesktopTabRailWidthChange?.(nextWidth);
    }
  }, [
    committedDesktopTabRailWidth,
    desktopTabRailWidth,
    onDesktopTabRailWidthChange,
    previewDesktopTabRailWidth,
  ]);

  const stopDesktopTabRailDrag = useCallback(() => {
    desktopTabRailDragRef.current = null;
    document.documentElement.classList.remove("workspace-tab-rail-resizing");
  }, []);

  const commitDesktopTabRailDrag = useCallback((pointerId: number) => {
    const drag = desktopTabRailDragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    const nextWidth = liveDesktopTabRailWidthRef.current;
    stopDesktopTabRailDrag();
    commitDesktopTabRailWidth(nextWidth);
  }, [commitDesktopTabRailWidth, stopDesktopTabRailDrag]);

  useEffect(() => {
    if (desktopTabRailDragRef.current) return;
    previewDesktopTabRailWidth(committedDesktopTabRailWidth);
  }, [committedDesktopTabRailWidth, previewDesktopTabRailWidth]);

  useEffect(() => {
    const pointerMove = (event: PointerEvent) => {
      const drag = desktopTabRailDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      previewDesktopTabRailWidth(drag.startWidth + event.clientX - drag.startX);
    };
    const pointerUp = (event: PointerEvent) => {
      commitDesktopTabRailDrag(event.pointerId);
    };
    const pointerCancel = (event: PointerEvent) => {
      const drag = desktopTabRailDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      stopDesktopTabRailDrag();
      previewDesktopTabRailWidth(committedDesktopTabRailWidth);
    };

    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerCancel);
    return () => {
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
    };
  }, [
    commitDesktopTabRailDrag,
    committedDesktopTabRailWidth,
    previewDesktopTabRailWidth,
    stopDesktopTabRailDrag,
  ]);

  useEffect(() => {
    if (orientation === "vertical") return;
    stopDesktopTabRailDrag();
    previewDesktopTabRailWidth(committedDesktopTabRailWidth);
  }, [
    committedDesktopTabRailWidth,
    orientation,
    previewDesktopTabRailWidth,
    stopDesktopTabRailDrag,
  ]);

  useEffect(() => () => {
    document.documentElement.classList.remove("workspace-tab-rail-resizing");
  }, []);

  const startDesktopTabRailDrag = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (
      desktopTabRailDragRef.current
      || event.button !== 0
      || event.isPrimary === false
    ) return;
    event.preventDefault();
    event.currentTarget.focus();
    desktopTabRailDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: liveDesktopTabRailWidthRef.current,
    };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Window-level listeners still keep the drag usable without pointer capture.
    }
    document.documentElement.classList.add("workspace-tab-rail-resizing");
  }, []);

  const desktopTabRailKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const step = event.shiftKey
      ? DESKTOP_TAB_RAIL_KEYBOARD_LARGE_STEP
      : DESKTOP_TAB_RAIL_KEYBOARD_STEP;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = visibleDesktopTabRailWidth - step;
    if (event.key === "ArrowRight") nextWidth = visibleDesktopTabRailWidth + step;
    if (event.key === "Home") nextWidth = MIN_DESKTOP_TAB_RAIL_WIDTH;
    if (event.key === "End") nextWidth = desktopTabRailMaxWidth;
    if (event.key === "Enter") nextWidth = DEFAULT_DESKTOP_TAB_RAIL_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    commitDesktopTabRailWidth(nextWidth);
  }, [
    commitDesktopTabRailWidth,
    desktopTabRailMaxWidth,
    visibleDesktopTabRailWidth,
  ]);

  const navigationStyle = orientation === "vertical"
    ? {
      position: "relative",
      width: `${visibleDesktopTabRailWidth}px`,
      "--desktop-tab-rail-width": `${visibleDesktopTabRailWidth}px`,
    } as CSSProperties
    : undefined;
  const navigationStackStyle = orientation === "vertical"
    ? {
      width: `${visibleDesktopTabRailWidth}px`,
      "--desktop-tab-rail-width": `${visibleDesktopTabRailWidth}px`,
    } as CSSProperties
    : undefined;
  const compactDesktopTabRail = orientation === "vertical"
    && visibleDesktopTabRailWidth <= COMPACT_DESKTOP_TAB_RAIL_MAX_WIDTH;

  const focusSaveReplacement = useCallback(() => {
    if (isCompactWorkspaceViewport()) {
      const overviewControl = document.getElementById(MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID);
      if (overviewControl instanceof HTMLElement) {
        overviewControl.focus();
        return;
      }
    }
    const target = persistenceStatusRef.current || saveButtonRef.current;
    target?.focus();
  }, []);

  const focusRenameReplacement = useCallback(() => {
    if (isCompactWorkspaceViewport()) {
      const overviewControl = document.getElementById(MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID);
      if (overviewControl instanceof HTMLElement) {
        overviewControl.focus();
        return;
      }
    }
    renameButtonRef.current?.focus();
  }, []);

  const focusTerminateDestination = useCallback((): boolean => {
    const focusAvailable = (target: HTMLElement | null | undefined): boolean => {
      if (!target?.isConnected || target.hasAttribute("disabled")) return false;
      for (let element: HTMLElement | null = target; element; element = element.parentElement) {
        if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
      }
      target.focus({ preventScroll: true });
      return document.activeElement === target;
    };

    if (recentsOpenRef.current) {
      const overview = document.querySelector<HTMLElement>(".workspace-recents-sheet");
      if (overview) {
        const search = overview.querySelector<HTMLInputElement>(
          "input[aria-label='Find a workspace session']",
        );
        const preferred = isCompactWorkspaceViewport() ? overview : search;
        if (focusAvailable(preferred) || focusAvailable(overview)) return true;
      }
    }

    const candidates: Array<HTMLElement | null | undefined> = [
      activeTabRef.current,
      navigationRef.current?.querySelector<HTMLButtonElement>("[role='tab']"),
      document.querySelector<HTMLButtonElement>(".mobile-console-focus-button.terminal"),
      document.querySelector<HTMLButtonElement>(".console-header .back-button"),
      document.querySelector<HTMLButtonElement>(".console-bar-toggle"),
      document.querySelector<HTMLTextAreaElement>(".terminal-host .xterm-helper-textarea"),
      navigationRef.current?.querySelector<HTMLButtonElement>(".workspace-dashboard-button"),
      document.querySelector<HTMLInputElement>(".search-field input"),
    ];
    return candidates.some(focusAvailable);
  }, []);

  const focusTerminateReplacement = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusTerminateDestination();
      // Route-driven session switches can remove the first target one frame later.
      window.requestAnimationFrame(focusTerminateDestination);
    });
  }, [focusTerminateDestination]);

  useEffect(() => {
    if (recentsOpen) return;
    setRecentsQuery("");
    recentsScrollTopRef.current = 0;
  }, [recentsOpen]);

  useEffect(() => {
    if (workspacePersistenceState === "unsaved") return;
    setSaveDialogOpen(false);
    setSaveAfterRecents(false);
  }, [workspacePersistenceState]);

  useEffect(() => {
    if (canRenameWorkspace) return;
    setRenameDialogOpen(false);
  }, [canRenameWorkspace]);

  useEffect(() => {
    setRenameDialogOpen(false);
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (
      recentsOpen
      || !saveAfterRecents
      || workspacePersistenceState !== "unsaved"
      || !onSaveWorkspace
    ) return;
    setSaveAfterRecents(false);
    setSaveDialogOpen(true);
  }, [onSaveWorkspace, recentsOpen, saveAfterRecents, workspacePersistenceState]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const activeTab = activeTabRef.current;
      const previous = previousTabNavigation.current;
      // Removing tabs can select a replacement, but must leave the list where
      // the user was working. Reconcile/list refreshes are not navigation.
      const revealActiveTab = !previous
        || previous.activeWorkspaceId !== activeWorkspaceId
        || previous.orientation !== orientation
        || (!previous.tabsVisible && tabsVisible)
        || previous.newSessionActive !== newSessionActive
        || (previous.activeSession !== activeSession
          && (!previous.activeSession || openSessions.includes(previous.activeSession)));
      previousTabNavigation.current = {
        activeSession,
        activeWorkspaceId,
        newSessionActive,
        orientation,
        tabsVisible,
      };
      if (revealActiveTab && activeTab && orientation === "vertical") {
        const viewport = activeTab.closest<HTMLElement>(".workspace-tab-viewport");
        if (viewport) {
          const viewportBounds = viewport.getBoundingClientRect();
          const tabBounds = activeTab.getBoundingClientRect();
          const viewportCenter = viewportBounds.top + viewportBounds.height / 2;
          const tabCenter = tabBounds.top + tabBounds.height / 2;
          viewport.scrollTop += tabCenter - viewportCenter;
        } else {
          activeTab.scrollIntoView?.({ block: "center", inline: "nearest" });
        }
      } else if (revealActiveTab) {
        activeTab?.scrollIntoView?.({ block: "nearest", inline: "center" });
      }
      if (focusActiveTabAfterClose.current && activeTab) {
        focusActiveTabAfterClose.current = false;
        activeTab.focus({ preventScroll: true });
      }
      const intent = reorderFocusIntent.current;
      if (intent) {
        const tab = Array.from(
          navigationRef.current?.querySelectorAll<HTMLElement>(".workspace-tab") ?? [],
        ).find((item) => item.dataset.workspaceSessionName === intent.sessionName);
        const controls = Array.from(
          tab?.querySelectorAll<HTMLButtonElement>(".workspace-tab-move") ?? [],
        );
        const preferred = controls[intent.direction === "previous" ? 0 : 1];
        const target = preferred && !preferred.disabled
          ? preferred
          : controls.find((control) => !control.disabled)
            ?? tab?.querySelector<HTMLButtonElement>("[role='tab']");
        target?.focus();
        reorderFocusIntent.current = null;
      }
      const groupIntent = groupReorderFocusIntent.current;
      if (groupIntent) {
        const groupElement = Array.from(
          navigationRef.current?.querySelectorAll<HTMLElement>(
            "[data-workspace-tab-group-id]",
          ) ?? [],
        ).find((element) => element.dataset.workspaceTabGroupId === groupIntent.groupId);
        const controls = Array.from(
          groupElement?.querySelectorAll<HTMLButtonElement>(".workspace-tab-group-move") ?? [],
        );
        const preferred = controls[groupIntent.direction === "previous" ? 0 : 1];
        const target = preferred && !preferred.disabled
          ? preferred
          : controls.find((control) => !control.disabled)
            ?? groupElement?.querySelector<HTMLButtonElement>(".workspace-tab-group-toggle");
        target?.focus();
        groupReorderFocusIntent.current = null;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeSession,
    activeWorkspaceId,
    newSessionActive,
    openSessions,
    groups,
    orientation,
    reorderAnnouncement,
    tabsVisible,
  ]);

  const closeQuickTab = (sessionName: string) => {
    focusActiveTabAfterClose.current = true;
    onCloseTab(sessionName);
  };

  const openQuickTabInNewWindow = (
    sessionName: string,
    title: string,
    move: boolean,
  ) => {
    if (!onOpenTabInNewWindow) return;
    const result = onOpenTabInNewWindow(sessionName, move ? "move" : "copy");
    if (result !== "opened") {
      setReorderAnnouncement("");
      setWindowActionError(newWindowFailureMessage(result, title));
      return;
    }
    setWindowActionError("");
    setReorderAnnouncement(
      move
        ? `${title} moved to a new window. The tmux session keeps running.`
        : `${title} copied to a new window and remains open here.`,
    );
    if (move) closeQuickTab(sessionName);
  };

  const closeNewSession = () => {
    onCloseNewSession?.();
  };

  const moveSelectedTabs = (direction: "previous" | "next") => {
    if (crossAdjacentSeparator(orderedSelection, direction)) return;
    const targetIndex = selectionMoveTargets[direction];
    if (!onMoveTabs || orderedSelection.length === 0 || targetIndex < 0) return;
    onMoveTabs(orderedSelection, targetIndex);
    setReorderAnnouncement(
      `${orderedSelection.length} selected tabs moved ${direction === "previous" ? "backward" : "forward"} together. Their relative order was preserved.`,
    );
  };

  const moveQuickTab = (sessionName: string, title: string, targetIndex: number) => {
    if (selectedWorkspaceTabSet.has(sessionName) && orderedSelection.length > 1 && onMoveTabs) {
      const direction = targetIndex < openSessions.indexOf(sessionName) ? "previous" : "next";
      reorderFocusIntent.current = { sessionName, direction };
      moveSelectedTabs(direction);
      return;
    }
    if (crossAdjacentSeparator([sessionName], targetIndex < openSessions.indexOf(sessionName) ? "previous" : "next")) return;
    if (!onMoveTab || targetIndex < 0 || targetIndex >= openSessions.length) return;
    const resultIndex = tabMoveResultIndex(openSessions, groups, sessionName, targetIndex, sessionParents);
    reorderFocusIntent.current = {
      sessionName,
      direction: targetIndex < openSessions.indexOf(sessionName) ? "previous" : "next",
    };
    onMoveTab(sessionName, targetIndex);
    setReorderAnnouncement(
      `${title} moved to position ${resultIndex + 1} of ${openSessions.length}.`,
    );
  };

  const workspaceTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    sessionName: string,
  ) => {
    if (event.key === "Escape" && selectedWorkspaceTabs.length > 0) {
      event.preventDefault();
      clearWorkspaceTabSelection();
      return;
    }
    if (
      event.key === " "
      && desktopTabMultiSelectEnabled
      && (event.shiftKey || event.ctrlKey || event.metaKey)
    ) {
      event.preventDefault();
      updateWorkspaceTabSelection(
        sessionName,
        event.shiftKey,
        event.ctrlKey || event.metaKey,
      );
      return;
    }
    tabKeyDown(event);
  };

  const sortTabsByWorkingState = () => {
    if (!onSortTabsByWorkingState) return;
    onSortTabsByWorkingState();
    setReorderAnnouncement(
      "Tabs sorted with non-working sessions first and working sessions second. Relative order within each status was preserved.",
    );
  };

  const openGroupDialog = (
    groupId: string | null,
    initialSession: string | null,
    trigger?: HTMLElement | null,
  ) => {
    if (!onSaveTabGroup) return;
    groupDialogTriggerRef.current = trigger ?? null;
    setGroupDialog({ groupId, initialSession });
  };

  const closeGroupDialog = () => {
    setGroupDialog(null);
    if (recentsOpen) return;
    window.requestAnimationFrame(() => {
      const trigger = groupDialogTriggerRef.current;
      if (trigger?.isConnected) trigger.focus();
      else activeTabRef.current?.focus();
    });
  };

  const moveGroup = (group: WorkspaceTabGroup, direction: -1 | 1) => {
    if (onMoveTabs && group.tabs.every((name) => selectedWorkspaceTabSet.has(name))) {
      moveSelectedTabs(direction < 0 ? "previous" : "next");
      return;
    }
    if (!onMoveTabGroup) return;
    groupReorderFocusIntent.current = {
      groupId: group.id,
      direction: direction < 0 ? "previous" : "next",
    };
    onMoveTabGroup(group.id, direction);
    setReorderAnnouncement(
      `${group.name} group moved ${direction < 0 ? "back" : "forward"}.`,
    );
  };

  const requestSaveFromRecents = () => {
    if (!onSaveWorkspace || workspacePersistenceState !== "unsaved") return;
    setSaveAfterRecents(true);
    onCloseRecents();
  };

  const requestRenameFromRecents = () => {
    if (!canRenameWorkspace) return;
    onCloseRecents();
    setRenameDialogOpen(true);
  };

  const terminateSelectedSession = useCallback(async () => {
    if (!terminateTarget || !onSessionTerminated) {
      throw new Error("This tmux session is no longer available.");
    }
    const completedTarget = terminateTarget;
    await onSessionTerminated(
      completedTarget.name,
      completedTarget.id,
      completedTarget.created,
      completedTarget.serverStarted,
      completedTarget.serverPid,
    );
    completedTerminationRef.current = completedTarget;
  }, [onSessionTerminated, terminateTarget]);

  useLayoutEffect(() => {
    const completedTarget = completedTerminationRef.current;
    if (!completedTarget || terminateTarget) return;
    const currentSession = sessionsByName.get(completedTarget.name);
    if (
      currentSession
      && currentSession.id === completedTarget.id
      && currentSession.created === completedTarget.created
      && currentSession.serverStarted === completedTarget.serverStarted
      && currentSession.serverPid === completedTarget.serverPid
    ) return;

    let followupFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      if (focusTerminateDestination()) {
        completedTerminationRef.current = null;
        return;
      }
      followupFrame = window.requestAnimationFrame(() => {
        if (focusTerminateDestination()) completedTerminationRef.current = null;
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (followupFrame) window.cancelAnimationFrame(followupFrame);
    };
  }, [
    activeSession,
    focusTerminateDestination,
    openSessions,
    recentsOpen,
    sessionsByName,
    tabsVisible,
    terminateTarget,
  ]);

  const renderSeparator = (sessionName: string, title: string, side: "before" | "after") => (
    orientation === "vertical" && (side === "before" ? separatorsBefore : separators).includes(sessionName)
      ? <div className="workspace-tab-separator" data-separator-after={side === "after" ? sessionName : undefined}
          data-separator-before={side === "before" ? sessionName : undefined}
          data-separator-dragging={separatorDrag.source?.name === sessionName && separatorDrag.source.side === side ? "true" : undefined}
          onDragOver={(event) => {
            const crossing = ["previous", "next"].map((direction) => separatorCrossing(workspaceTabDragSessionsRef.current, direction as "previous" | "next"))
              .find((value) => value?.from.name === sessionName && value.from.side === side);
            if (!crossing || separatorsBusy) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            event.currentTarget.dataset.crossing = "true";
          }}
          onDragLeave={(event) => { delete event.currentTarget.dataset.crossing; }}
          onDrop={(event) => {
            const crossing = ["previous", "next"].map((direction) => separatorCrossing(workspaceTabDragSessionsRef.current, direction as "previous" | "next"))
              .find((value) => value?.from.name === sessionName && value.from.side === side);
            delete event.currentTarget.dataset.crossing;
            if (!crossing || separatorsBusy) return;
            event.preventDefault();
            event.stopPropagation();
            props.onCrossSeparator?.(crossing);
            finishWorkspaceTabDrag();
          }}
          title="Drag this separator to another session row, or drop adjacent tabs here to move them across it">
          <span role="separator" aria-label={`Separator ${side} ${title}`}
            draggable={separatorDragEnabled}
            aria-description="Drag to the top or bottom half of a session row to place this separator before or after it."
            onDragStart={(event) => {
              finishWorkspaceTabDrag();
              separatorDrag.start(event, { name: sessionName, side });
            }}
            onDragEnd={separatorDrag.cancel} />
          {onChangeSeparator && (
            <button
              type="button"
              disabled={separatorsBusy}
              onClick={() => onChangeSeparator(sessionName, false, side)}
              aria-label={`Remove separator ${side} ${title}`}
              title="Remove separator"
            ><CloseIcon /></button>
          )}
        </div>
      : null
  );

  const renderWorkspaceTab = (
    sessionName: string,
    group?: WorkspaceTabGroup,
  ) => {
    const index = openSessions.indexOf(sessionName);
    const session = sessionsByName.get(sessionName);
    const state = workspaceSessionState(session);
    const dead = state === "dead";
    const title = tabTitle(sessionName, sessionsByName);
    const agentLabel = sessionAgentInfo(session).label;
    const tree = sessionTreeContext(sessionName, sessionParents, sessionsByName);
    const active = !newSessionActive && sessionName === activeSession;
    const readyUnchecked = props.uncheckedReadySessions?.has(sessionName) ?? false;
    const selectedForMove = selectedWorkspaceTabSet.has(sessionName);
    const selectedDrag = selectedForMove && selectedWorkspaceTabs.length > 1 && !deadTabsOnlySelected;
    const previousMoveIndex = tabMoveTargetIndex(openSessions, group, sessionParents, sessionName, -1);
    const nextMoveIndex = tabMoveTargetIndex(openSessions, group, sessionParents, sessionName, 1);
    const crossingNames = selectedDrag ? orderedSelection : [sessionName];
    const canMovePrevious = !separatorsBusy && (Boolean(separatorCrossing(crossingNames, "previous")) || (selectedDrag && onMoveTabs
      ? selectionMoveTargets.previous >= 0 : previousMoveIndex >= 0));
    const canMoveNext = !separatorsBusy && (Boolean(separatorCrossing(crossingNames, "next")) || (selectedDrag && onMoveTabs
      ? selectionMoveTargets.next >= 0 : nextMoveIndex >= 0));
    const canDragTab = desktopTabDragEnabled && !deadTabsOnlySelected && (
      nestingEnabled || (selectedDrag && onMoveTabs)
        ? true
        : !group || (!group.collapsed && group.tabs.length > 1)
    );
    const dropEdge = workspaceTabDrag?.target?.kind === "tab"
      && workspaceTabDrag.target.id === sessionName
      ? workspaceTabDrag.target.edge
      : undefined;
    const tabShortcutBinding = index < 9
      ? shortcutBindings[
        `workspace-tab-${index + 1}` as keyof typeof shortcutBindings
      ]
      : undefined;
    const tabShortcut = directShortcutLabel(tabShortcutBinding);
    return (
      <Fragment key={sessionName}>
      {renderSeparator(sessionName, title, "before")}
      <div
        className={active ? "workspace-tab active" : "workspace-tab"}
        data-workspace-session-name={sessionName}
        data-session-dead={dead ? "true" : undefined}
        data-ready-unchecked={readyUnchecked ? "true" : undefined}
        data-session-parent={tree?.parentName}
        data-session-depth={tree?.depth}
        style={sessionTreeStyle(tree)}
        data-tab-group-color={group?.color}
        data-tab-move-selected={selectedForMove ? "true" : undefined}
        data-tab-dragging={workspaceTabDrag?.sessionNames.includes(sessionName)
          ? "true"
          : undefined}
        data-tab-drop-edge={dropEdge}
        data-separator-drop-edge={separatorDrag.target?.name === sessionName ? separatorDrag.target.side : undefined}
        data-tab-drop-nest={workspaceTabDrag?.target?.kind === "nest" && workspaceTabDrag.target.id === sessionName ? "true" : undefined}
        key={sessionName}
        onDragOver={desktopTabDragEnabled || separatorDragEnabled
          ? (event) => {
            if (!separatorDrag.over(event, sessionName)) dragOverWorkspaceTab(event, sessionName);
          }
          : undefined}
        onDrop={desktopTabDragEnabled || separatorDragEnabled
          ? (event) => {
            if (!separatorDrag.drop(event, sessionName)) dropOnWorkspaceTab(event, sessionName);
          }
          : undefined}
      >
        <button
          ref={active ? activeTabRef : undefined}
          type="button"
          role="tab"
          aria-selected={active}
          aria-controls={active ? "muxdeck-active-console" : undefined}
          aria-label={`${title}${group ? `, ${group.name} group` : ""}${session ? `, ${STATE_LABELS[state]}` : ", unavailable"}${readyUnchecked ? ", unread" : ""}${selectedForMove ? deadTabsOnlySelected ? ", selected for cleanup" : ", selected for moving" : ""}`}
          aria-keyshortcuts={directShortcutAria(tabShortcutBinding)}
          title={`${tabShortcut ? `${title} (${tabShortcut})` : title} · ${agentLabel}${dead ? " · Dead: all tmux panes have exited" : ""}${readyUnchecked ? " · Unread — open this session to mark it as read" : ""}${tree ? ` · ${tree.description}` : ""}${desktopTabMultiSelectEnabled ? " - Shift-click a range; Ctrl/Cmd-click individual tabs" : ""}`}
          tabIndex={active ? 0 : -1}
          draggable={canDragTab ? true : undefined}
          aria-description={`${agentLabel}. ${tree ? `${tree.description} ` : ""}${canDragTab
            ? selectedDrag
              ? `${selectedWorkspaceTabs.length} tabs selected. Drag to move them together; their relative order is preserved.`
              : nestingEnabled
                ? "Drag onto a session to nest; drag at its edges to reorder. Drop on Top level to promote. Right-click for Move / Nest; Alt+Shift+Left or Right moves up or down a level."
                : desktopTabMultiSelectEnabled
                  ? "Drag to reorder this tab. Shift-click selects a range; Control or Command-click toggles individual tabs."
                  : "Drag to reorder this tab. Reorder buttons are also available in Actions."
            : ""}`.trim()}
          onContextMenu={props.onTransferSelectedSessions && nestingEnabled ? (event) => {
            event.preventDefault();
            props.onTransferSelectedSessions?.([sessionName]);
          } : undefined}
          onKeyDown={(event) => {
            if (nestingEnabled && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
              event.preventDefault();
              event.stopPropagation();
              props.onTransferSelectedSessions?.([sessionName]);
            } else if (nestingEnabled && event.altKey && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
              event.preventDefault();
              event.stopPropagation();
              const parent = workspaceSessionParent(sessionName, sessionParents);
              const previous = previousWorkspaceSibling({ openSessions, parents: sessionParents, groups }, sessionName);
              const target = event.key === "ArrowLeft"
                ? parent ? workspaceSessionParent(parent, sessionParents) ?? null : undefined
                : previous ?? undefined;
              if (target !== undefined) {
                try { onReparentSession?.(sessionName, target); }
                catch (error) { setReorderAnnouncement(error instanceof Error ? error.message : "Unable to move this session."); }
              }
            } else workspaceTabKeyDown(event, sessionName);
          }}
          onClick={(event) => selectWorkspaceTab(event, sessionName)}
          onDragStart={canDragTab
            ? (event) => startWorkspaceTabDrag(event, sessionName)
            : undefined}
          onDragEnd={canDragTab ? finishWorkspaceTabDrag : undefined}
        >
          {tree && <span className="workspace-tab-child-marker" aria-hidden="true" />}
          {selectedForMove && (
            <span className="workspace-tab-selection-mark" aria-hidden="true">
              <CheckIcon />
            </span>
          )}
          <span className={`workspace-state-dot ${state}`} aria-hidden="true" />
          <span
            className="workspace-tab-compact-index"
            data-index={index + 1}
            aria-hidden="true"
          />
          <span className="workspace-tab-title">{title}</span>
          {dead && <span className="workspace-tab-dead-label" aria-hidden="true">Dead</span>}
          <SessionAgentIcon session={session} />
        </button>
        {tree && onReparentSession && props.onTransferSelectedSessions && (
          <button
            type="button"
            className="workspace-tab-move workspace-tab-placement"
            disabled={!nestingEnabled}
            aria-label={`Move / Nest ${title}`}
            aria-haspopup="dialog"
            title={`Move ${title} up a level or under another session`}
            onClick={() => props.onTransferSelectedSessions?.([sessionName])}
          >
            <WindowMoveIcon />
          </button>
        )}
        {workspaceTabDrag?.target?.kind === "nest" && workspaceTabDrag.target.id === sessionName && (
          <span className="workspace-tab-nest-hint" aria-hidden="true">↳ Nest under this session</span>
        )}
        {tabActionsVisible && onMoveTab && (openSessions.length > 1 || canMovePrevious || canMoveNext) && (
          <span
            className="workspace-tab-reorder"
            role="group"
            aria-label={`Reorder ${title} tab${group ? ` inside ${group.name}` : ""}`}
          >
            <button
              type="button"
              className={`workspace-tab-move workspace-tab-move-${orientation === "vertical" ? "up" : "left"}`}
              onClick={() => moveQuickTab(sessionName, title, previousMoveIndex >= 0 ? previousMoveIndex : index - 1)}
              disabled={!canMovePrevious}
              aria-label={`Move ${title} tab ${orientation === "vertical" ? "up" : "left"}`}
              title={`Move ${selectedDrag ? "selected tabs" : "tab"} ${orientation === "vertical" ? "up" : "left"}`}
              aria-description={selectedDrag ? "Moves all selected tabs together" : undefined}
            >
              {orientation === "vertical" ? <ArrowUpIcon /> : <ArrowLeftIcon />}
            </button>
            <button
              type="button"
              className={`workspace-tab-move workspace-tab-move-${orientation === "vertical" ? "down" : "right"}`}
              onClick={() => moveQuickTab(sessionName, title, nextMoveIndex >= 0 ? nextMoveIndex : index + 1)}
              disabled={!canMoveNext}
              aria-label={`Move ${title} tab ${orientation === "vertical" ? "down" : "right"}`}
              title={`Move ${selectedDrag ? "selected tabs" : "tab"} ${orientation === "vertical" ? "down" : "right"}`}
              aria-description={selectedDrag ? "Moves all selected tabs together" : undefined}
            >
              {orientation === "vertical" ? <ArrowDownIcon /> : <ArrowLeftIcon />}
            </button>
          </span>
        )}
        {tabActionsVisible && onOpenTabInNewWindow && (
          <span
            className="workspace-tab-window-actions"
            role="group"
            aria-label={`${title} tab window actions`}
          >
            <button
              type="button"
              className="workspace-tab-window-move"
              onClick={() => openQuickTabInNewWindow(sessionName, title, true)}
              disabled={Boolean(windowMoveDisabledReason)}
              aria-label={`Move ${title} tab to new window`}
              aria-description={windowMoveDisabledReason
                ?? "Opens this session in a separate browser window and removes this quick tab here. The tmux session keeps running."}
              title={windowMoveDisabledReason ?? "Move tab to new window"}
            >
              <WindowMoveIcon />
            </button>
            <button
              type="button"
              className="workspace-tab-window-copy"
              onClick={() => openQuickTabInNewWindow(sessionName, title, false)}
              aria-label={`Copy ${title} tab to new window`}
              aria-description="Opens this session in a separate browser window and keeps this quick tab here."
              title="Copy tab to new window"
            >
              <WindowCopyIcon />
            </button>
          </span>
        )}
        {tabActionsVisible && session && onSessionTerminated && (
          <button
            type="button"
            className="workspace-tab-terminate"
            onClick={() => setTerminateTarget(session)}
            aria-label={`Terminate ${title} tmux session`}
            aria-haspopup="dialog"
            title="Terminate tmux session"
          >
            <TrashIcon />
          </button>
        )}
        {tabActionsVisible && (
          <button
            type="button"
            className="workspace-tab-close"
            onClick={() => closeQuickTab(sessionName)}
            aria-label={`Close ${title} quick tab`}
            title="Close quick tab"
          >
            <CloseIcon />
          </button>
        )}
      </div>
      {renderSeparator(sessionName, title, "after")}
      </Fragment>
    );
  };

  const commandPaletteCommands = buildWorkspaceCommands({
    activeSession,
    snippetSessionAvailable: !newSessionActive && sessionsByName.has(
      activeSession ?? activePaneSession ?? "",
    ),
    newSessionActive,
    openSessions,
    sessionsByName,
    tabsVisible,
    tabActionsVisible,
    paneLayoutActive: Boolean(activePaneLayoutId),
    workspacePersistenceState,
    newSessionDisabled,
    quickNewSessionDisabled,
    onNewSession,
    onQuickNewSession,
    onToggleCallbackSession,
    onOpenTabSearch,
    onOpenRecents,
    onOpenDashboard,
    onSelect,
    onRequestSaveWorkspace: workspacePersistenceState === "unsaved" && onSaveWorkspace
      ? () => setSaveDialogOpen(true)
      : undefined,
    onRequestRenameWorkspace: canRenameWorkspace
      ? () => setRenameDialogOpen(true)
      : undefined,
    onCreateTabGroup: canCreateGroup
      ? () => openGroupDialog(null, activeSession, null)
      : undefined,
    onSortTabsByWorkingState: onSortTabsByWorkingState && openSessions.length > 1
      ? sortTabsByWorkingState
      : undefined,
    onToggleTabActions,
    onCloseActiveTab: activeSession && onCloseTab
      ? () => onCloseTab(activeSession)
      : undefined,
  });

  return (
    <>
      <div
        className={`workspace-navigation-stack workspace-navigation-stack-${orientation}`}
        data-orientation={orientation}
        data-compact={compactDesktopTabRail ? "true" : undefined}
        style={navigationStackStyle}
        hidden={!tabsVisible}
      >
        <nav
          ref={navigationRef}
          id="muxdeck-session-tabs"
          className={`workspace-navigation workspace-navigation-${orientation}`}
          data-orientation={orientation}
          data-compact={compactDesktopTabRail ? "true" : undefined}
          data-session-tree={Object.keys(sessionParents).length > 0 ? "true" : undefined}
          data-tab-actions-visible={tabActionsVisible ? "true" : "false"}
          data-tab-drag-active={workspaceTabDrag ? "true" : undefined}
          style={navigationStyle}
          aria-label="Session workspace"
          hidden={!tabsVisible}
        >
          <div
            className="workspace-dashboard-actions"
            role="group"
            aria-label="Sessions page actions"
          >
            <button
              type="button"
              className="workspace-dashboard-button"
              onClick={onOpenDashboard}
              aria-label="All sessions"
              title="Open Sessions in this window"
            >
              <GridIcon />
              <span>Sessions</span>
            </button>
            {dashboardWindowHref && (
              <a
                className="workspace-dashboard-window-button"
                href={dashboardWindowHref}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open all sessions in new window"
                title="Open Sessions in new window"
              >
                <ExternalLinkIcon />
              </a>
            )}
          </div>
          {onNewSession && (
            <div
              className="workspace-new-session-actions"
              role="group"
              aria-label="New session actions"
            >
              <button
                type="button"
                className={newSessionActive
                  ? "workspace-new-session-button active"
                  : "workspace-new-session-button"}
                onClick={onNewSession}
                disabled={newSessionDisabled}
                aria-label="New session"
                aria-keyshortcuts={directShortcutAria(
                  shortcutBindings["workspace-new-session"],
                )}
                aria-current={newSessionActive ? "page" : undefined}
                title={newSessionActive
                  ? "New session is already open"
                  : workspacePersistenceState === "loading"
                    ? "Wait for workspace to finish opening"
                    : `New session${directShortcutLabel(
                      shortcutBindings["workspace-new-session"],
                    ) ? ` (${directShortcutLabel(
                        shortcutBindings["workspace-new-session"],
                      )})` : ""}`}
              >
                <PlusIcon />
                <span>New session</span>
              </button>
              {onQuickNewSession && (
                <button
                  type="button"
                  className="workspace-quick-new-session-button"
                  onClick={() => void onQuickNewSession()}
                  disabled={quickNewSessionDisabled}
                  aria-label="Quick new temporary session"
                  aria-busy={quickNewSessionBusy || undefined}
                  aria-keyshortcuts={directShortcutAria(
                    shortcutBindings["workspace-quick-new-session"],
                  )}
                  title={quickNewSessionBusy
                    ? "Creating a quick temporary session"
                    : workspacePersistenceState === "loading"
                      ? "Wait for workspace to finish opening"
                      : `Quick temporary session from workspace memory${quickSessionShortcutHint
                        ? ` (${quickSessionShortcutHint})`
                        : ""}`}
                >
                  <TerminalIcon />
                </button>
              )}
            </div>
          )}
          {onAddSession && (
            <button
              type="button"
              className="workspace-add-session-button"
              onClick={() => setSessionAddOpen(true)}
              disabled={workspacePersistenceState === "loading"
                || workspacePersistenceState === "error"
                || openSessions.length >= MAX_WORKSPACE_TABS
                || addableSessionCount === 0}
              aria-label={`Add running sessions to workspace, ${addableSessionCount} available`}
              aria-haspopup="dialog"
              aria-expanded={sessionAddOpen}
              title={openSessions.length >= MAX_WORKSPACE_TABS
                ? `Workspace already has the maximum ${MAX_WORKSPACE_TABS} sessions`
                : addableSessionCount === 0
                  ? "Every running session is already in this workspace"
                  : workspacePersistenceState === "loading"
                    || workspacePersistenceState === "error"
                    ? "Wait for the workspace to finish syncing"
                    : "Find and add running sessions without leaving this workspace"}
            >
              <PlusIcon />
              <span>Add sessions</span>
              {addableSessionCount > 0 && <strong>{addableSessionCount}</strong>}
            </button>
          )}
          {onReparentSession && (
            <div className="workspace-session-placement-controls" role="group" aria-label="Session placement">
              {props.onTransferSelectedSessions && (
                <button
                  type="button"
                  className="workspace-session-placement-button"
                  disabled={!nestingEnabled || !placementSessionAvailable}
                  aria-label="Move / Nest"
                  aria-haspopup="dialog"
                  aria-description={placementHint}
                  title={placementHint}
                  onClick={() => {
                    if (placementSession) props.onTransferSelectedSessions?.([placementSession]);
                  }}
                >
                  <WindowMoveIcon />
                  <span>Move / Nest</span>
                </button>
              )}
              <div className="workspace-session-level-controls" role="group" aria-label="Session nesting level">
                <button
                  type="button"
                  className="workspace-session-placement-button"
                  disabled={!nestingEnabled || !placementParent}
                  aria-label="Up one level"
                  aria-description={placementUpHint}
                  title={placementUpHint}
                  onClick={() => changePlacementLevel("up")}
                >
                  <ArrowLeftIcon />
                  <span>Up</span>
                </button>
                <button
                  type="button"
                  className="workspace-session-placement-button"
                  disabled={!nestingEnabled || !placementPreviousSibling}
                  aria-label="Down one level"
                  aria-description={placementDownHint}
                  title={placementDownHint}
                  onClick={() => changePlacementLevel("down")}
                >
                  <ArrowRightIcon />
                  <span>Down</span>
                </button>
              </div>
            </div>
          )}
          {orientation === "vertical" && onSortTabsByWorkingState && openSessions.length > 1 && (
            <button
              type="button"
              className="workspace-tab-status-sort"
              onClick={sortTabsByWorkingState}
              aria-label="Stable sort tabs: non-working first, then working"
              aria-description="Preserves the existing relative order within each status. Tab groups stay together."
              title="Stable sort: non-working first, then working"
            >
              <ListIcon />
              <span>Non-working first</span>
              <small>Stable</small>
            </button>
          )}
          {desktopTabMultiSelectEnabled && props.onBulkSessionAction && deadSessionTabs.length > 0 && (
            <button
              type="button"
              className="workspace-select-dead-tabs"
              disabled={workspacePersistenceState === "loading" || workspacePersistenceState === "error"}
              aria-label={`Select ${deadSessionTabs.length} dead session tab${deadSessionTabs.length === 1 ? "" : "s"}`}
              title="Select only sessions whose tmux panes have all exited, then close their tabs or end their sessions"
              onClick={selectDeadSessionTabs}
            >
              <CheckIcon /><span>Select dead</span><strong>{deadSessionTabs.length}</strong>
            </button>
          )}
          {orientation === "vertical" && onChangeSeparator && (
            <>
              <div className="workspace-separator-controls" role="group" aria-label="Separator placement">
              <button
                type="button"
                className="workspace-add-separator"
                disabled={!activeSession || separatorsBusy || separatorsBefore.includes(activeSession)
                  || workspacePersistenceState === "loading"}
                onClick={() => activeSession && onChangeSeparator(activeSession, true, "before")}
                aria-label="Insert separator before current session"
                title="Insert a colored separator before the current session"
              >
                <ArrowUpIcon /><span>Insert separator</span>
              </button>
              <button
                type="button"
                className="workspace-add-separator"
                disabled={!activeSession || separatorsBusy || separators.includes(activeSession)
                  || workspacePersistenceState === "loading"}
                onClick={() => activeSession && onChangeSeparator(activeSession, true, "after")}
                aria-label="Append separator after current session"
                title="Append a colored separator after the current session"
              >
                <ArrowDownIcon /><span>Append separator</span>
              </button>
              </div>
              {separatorsError && (
                <div className="workspace-separator-error" role="alert">
                  <span>Separators: {separatorsError}</span>
                </div>
              )}
              </>
          )}
          {orientation === "vertical" && (paneLayouts.length > 0 || onCreatePaneLayout) && (
            <div className="workspace-pane-layout-heading">
              <span><GridIcon /> Pane views</span>
              {onCreatePaneLayout && (
                <button
                  type="button"
                  disabled={paneLayoutsBusy || paneLayouts.length >= 16}
                  onClick={() => void onCreatePaneLayout()}
                  aria-label="Create multi-pane view"
                  title="Create a named, saved multi-pane view"
                >
                  <PlusIcon />
                </button>
              )}
            </div>
          )}
          {nestingEnabled && workspaceTabDrag?.sessionNames.length === 1 && !workspaceTabDrag.groupId && (
            <div className="workspace-tab-root-drop" role="group" aria-label="Top level drop target"
              data-drop-active={workspaceTabDrag.target?.kind === "root" ? "true" : undefined}
              onDragOver={(event) => {
                event.preventDefault(); event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                previewWorkspaceTabDrop({ kind: "root", id: "", edge: "before", targetIndex: -1 });
              }}
              onDragLeave={clearWorkspaceTabDropTarget}
              onDrop={(event) => {
                event.preventDefault(); event.stopPropagation();
                commitWorkspaceTabDrop({ kind: "root", id: "", edge: "before", targetIndex: -1 });
              }}>
              <ArrowUpIcon /><span>Top level</span>
            </div>
          )}
          <div className="workspace-tab-viewport">
            <div
              className="workspace-tab-list"
              role="tablist"
              aria-label="Session workspace tabs"
              aria-orientation={orientation}
              onDragOver={desktopTabDragEnabled || separatorDragEnabled
                ? () => { clearWorkspaceTabDropTarget(); separatorDrag.clearTarget(); }
                : undefined}
              onDragLeave={desktopTabDragEnabled || separatorDragEnabled
                ? (event) => {
                  const relatedTarget = event.relatedTarget;
                  if (
                    relatedTarget instanceof Node
                    && event.currentTarget.contains(relatedTarget)
                  ) return;
                  clearWorkspaceTabDropTarget();
                  separatorDrag.clearTarget();
                }
                : undefined}
              onDrop={desktopTabDragEnabled || separatorDragEnabled
                ? () => { finishWorkspaceTabDrag(); separatorDrag.cancel(); }
                : undefined}
            >
              {workspaceTabItems.map((item) => {
                if (item.kind === "tab") return renderWorkspaceTab(item.sessionName);
                const { group } = item;
                const groupStart = openSessions.indexOf(group.tabs[0]);
                const groupEnd = groupStart + group.tabs.length - 1;
                const visibleTabs = group.collapsed ? [] : group.tabs;
                const groupActive = !newSessionActive && Boolean(activeSession && group.tabs.includes(activeSession));
                const uncheckedCount = group.tabs.filter((name) => props.uncheckedReadySessions?.has(name)).length;
                const groupHint = [
                  groupActive ? `Active session: ${tabTitle(activeSession!, sessionsByName)}.` : "",
                  uncheckedCount ? `${uncheckedCount} unread ${uncheckedCount === 1 ? "session" : "sessions"}.` : "",
                  groupDragEnabled ? "Drag this header to move the whole group, including nested sessions." : "",
                ].filter(Boolean).join(" ");
                const dropEdge = workspaceTabDrag?.target?.kind === "group"
                  && workspaceTabDrag.target.id === group.id
                  ? workspaceTabDrag.target.edge
                  : undefined;
                const selectedForMove = group.tabs.every((sessionName) => (
                  selectedWorkspaceTabSet.has(sessionName)
                ));
                return (
                  <div
                    className={group.collapsed
                      ? "workspace-tab-group collapsed"
                      : "workspace-tab-group"}
                    data-workspace-tab-group-id={group.id}
                    data-active-group={groupActive ? "true" : undefined}
                    data-tab-dragging={workspaceTabDrag?.groupId === group.id ? "true" : undefined}
                    data-tab-group-color={group.color}
                    data-tab-move-selected={selectedForMove ? "true" : undefined}
                    data-tab-drop-edge={dropEdge}
                    key={group.id}
                    onDragOver={desktopTabDragEnabled
                      ? (event) => dragOverWorkspaceTabGroup(event, group)
                      : undefined}
                    onDrop={desktopTabDragEnabled
                      ? (event) => dropOnWorkspaceTabGroup(event, group)
                      : undefined}
                  >
                    <div className="workspace-tab-group-chip">
                      {onToggleTabGroup ? (
                        <button
                          type="button"
                          className="workspace-tab-group-toggle"
                          ref={groupActive && group.collapsed ? activeTabRef : undefined}
                          draggable={groupDragEnabled || undefined}
                          onDragStart={groupDragEnabled ? (event) => startWorkspaceGroupDrag(event, group) : undefined}
                          onDragEnd={groupDragEnabled ? finishWorkspaceTabDrag : undefined}
                          aria-description={groupHint || undefined}
                          onClick={() => onToggleTabGroup(group.id, !group.collapsed)}
                          aria-expanded={!group.collapsed}
                          aria-controls={`workspace-tab-group-tabs-${group.id}`}
                          aria-label={`${group.collapsed ? "Expand" : "Collapse"} ${group.name} tab group`}
                          title={`${group.collapsed ? "Expand" : "Collapse"} ${group.name}${groupHint ? ` · ${groupHint}` : ""}`}
                        >
                          <span className="workspace-tab-group-color" aria-hidden="true" />
                          <FolderIcon />
                          <strong>{group.name}</strong>
                          <small>{group.tabs.length}</small>
                          {uncheckedCount > 0 && <span className="workspace-tab-group-ready-count"
                            aria-label={`${uncheckedCount} unread ${uncheckedCount === 1 ? "session" : "sessions"}`}>{uncheckedCount}</span>}
                          <ArrowDownIcon aria-hidden="true" />
                        </button>
                      ) : (
                        <span className="workspace-tab-group-toggle">
                          <span className="workspace-tab-group-color" aria-hidden="true" />
                          <FolderIcon />
                          <strong>{group.name}</strong>
                          <small>{group.tabs.length}</small>
                          {uncheckedCount > 0 && <span className="workspace-tab-group-ready-count"
                            aria-label={`${uncheckedCount} unread ${uncheckedCount === 1 ? "session" : "sessions"}`}>{uncheckedCount}</span>}
                        </span>
                      )}
                      {onMoveTabGroup && (
                        <span className="workspace-tab-group-reorder" role="group" aria-label={`Move ${group.name} group`}>
                          <button
                            type="button"
                            className="workspace-tab-group-move workspace-tab-group-move-previous"
                            onClick={() => moveGroup(group, -1)}
                            disabled={selectedForMove && onMoveTabs
                              ? selectionMoveTargets.previous < 0 : groupStart === 0}
                            aria-label={`Move ${group.name} group ${orientation === "vertical" ? "up" : "left"}`}
                            title={`Move group ${orientation === "vertical" ? "up" : "left"}`}
                          >
                            {orientation === "vertical" ? <ArrowUpIcon /> : <ArrowLeftIcon />}
                          </button>
                          <button
                            type="button"
                            className="workspace-tab-group-move workspace-tab-group-move-next"
                            onClick={() => moveGroup(group, 1)}
                            disabled={selectedForMove && onMoveTabs
                              ? selectionMoveTargets.next < 0 : groupEnd === openSessions.length - 1}
                            aria-label={`Move ${group.name} group ${orientation === "vertical" ? "down" : "right"}`}
                            title={`Move group ${orientation === "vertical" ? "down" : "right"}`}
                          >
                            {orientation === "vertical" ? <ArrowDownIcon /> : <ArrowLeftIcon />}
                          </button>
                        </span>
                      )}
                      {onSaveTabGroup && onDeleteTabGroup && (
                        <button
                          type="button"
                          className="workspace-tab-group-edit"
                          onClick={(event) => openGroupDialog(
                            group.id,
                            null,
                            event.currentTarget,
                          )}
                          aria-label={`Edit ${group.name} tab group`}
                          title="Edit tab group"
                        >
                          <EditIcon />
                        </button>
                      )}
                    </div>
                    <div
                      id={`workspace-tab-group-tabs-${group.id}`}
                      className="workspace-tab-group-tabs"
                    >
                      {visibleTabs.map((sessionName) => renderWorkspaceTab(sessionName, group))}
                    </div>
                  </div>
                );
              })}
              {canCreateGroup && (
                <button
                  type="button"
                  className="workspace-new-group-button"
                  onClick={(event) => openGroupDialog(
                    null,
                    activeSession,
                    event.currentTarget,
                  )}
                  aria-label="Create tab group"
                  title="Create tab group"
                >
                  <PlusIcon />
                  <span>New group</span>
                </button>
              )}
              {paneLayouts.map((paneLayout) => {
                const active = paneLayout.id === activePaneLayoutId;
                const assignedCount = assignedPaneSessionCount(paneLayout.root);
                return (
                  <div
                    key={paneLayout.id}
                    className={active
                      ? "workspace-tab workspace-pane-layout-tab active"
                      : "workspace-tab workspace-pane-layout-tab"}
                    data-workspace-pane-layout-id={paneLayout.id}
                  >
                    <button
                      ref={active ? activeTabRef : undefined}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-controls={active ? "muxdeck-workspace-pane-board" : undefined}
                      tabIndex={active ? 0 : -1}
                      title={`${paneLayout.name} - ${assignedCount} assigned ${assignedCount === 1 ? "session" : "sessions"}`}
                      onClick={() => onSelectPaneLayout?.(paneLayout.id)}
                      onKeyDown={tabKeyDown}
                    >
                      <span className="workspace-pane-layout-icon"><GridIcon /></span>
                      <span className="workspace-tab-title">{paneLayout.name}</span>
                      <small>{assignedCount}</small>
                    </button>
                  </div>
                );
              })}
              {orientation === "horizontal" && onCreatePaneLayout && (
                <button
                  type="button"
                  className="workspace-pane-layout-create-inline"
                  disabled={paneLayoutsBusy || paneLayouts.length >= 16}
                  onClick={() => void onCreatePaneLayout()}
                  aria-label="Create multi-pane view"
                  title="Create a named, saved multi-pane view"
                >
                  <GridIcon /><PlusIcon /><span>Pane view</span>
                </button>
              )}
              {newSessionActive && (
                <div className="workspace-tab workspace-new-session-tab active">
                  <button
                    ref={activeTabRef}
                    type="button"
                    role="tab"
                    aria-selected="true"
                    aria-controls={NEW_SESSION_PANEL_ID}
                    aria-label="New session, not created yet"
                    tabIndex={0}
                    onKeyDown={tabKeyDown}
                  >
                    <span className="workspace-state-dot new-session" aria-hidden="true" />
                    <span
                      className="workspace-tab-compact-index"
                      data-index="+"
                      aria-hidden="true"
                    />
                    <span className="workspace-tab-title">New session</span>
                  </button>
                  {tabActionsVisible && onCloseNewSession && (
                    <button
                      type="button"
                      className="workspace-tab-close"
                      onClick={closeNewSession}
                      aria-label="Close New session tab"
                      title="Close new session"
                    >
                      <CloseIcon />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          {orderedSelection.length > 0 && (
            <div
              className="workspace-tab-selection-status"
              role="group"
              aria-label={deadTabsOnlySelected
                ? `${orderedSelection.length} dead session tabs selected`
                : `${orderedSelection.length} tabs selected for moving`}
            >
              <span className="workspace-tab-selection-status-count">
                <CheckIcon />
                <strong>{orderedSelection.length}</strong>
                <span>selected</span>
              </span>
              <small>{deadTabsOnlySelected ? "Dead only" : "Drag together"}</small>
              {onMoveTabs && !deadTabsOnlySelected && (
                <>
                  <button
                    type="button"
                    onClick={() => moveSelectedTabs("previous")}
                    disabled={separatorsBusy || (selectionMoveTargets.previous < 0 && !separatorCrossing(orderedSelection, "previous"))}
                    aria-label={`Move selected tabs ${orientation === "vertical" ? "up" : "left"}`}
                    title={`Move selected tabs ${orientation === "vertical" ? "up" : "left"}`}
                  >{orientation === "vertical" ? <ArrowUpIcon /> : <ArrowLeftIcon />}</button>
                  <button
                    type="button"
                    onClick={() => moveSelectedTabs("next")}
                    disabled={separatorsBusy || (selectionMoveTargets.next < 0 && !separatorCrossing(orderedSelection, "next"))}
                    aria-label={`Move selected tabs ${orientation === "vertical" ? "down" : "right"}`}
                    title={`Move selected tabs ${orientation === "vertical" ? "down" : "right"}`}
                  >{orientation === "vertical" ? <ArrowDownIcon /> : <ArrowLeftIcon />}</button>
                </>
              )}
              {props.onTransferSelectedSessions && !deadTabsOnlySelected && (
                <button
                  type="button"
                  className="workspace-selection-bulk-action"
                  disabled={workspacePersistenceState === "loading"
                    || workspacePersistenceState === "error"}
                  aria-label={`Move or copy ${orderedSelection.length} selected sessions to a workspace`}
                  title="Move or copy the selected sessions to another workspace"
                  onClick={() => props.onTransferSelectedSessions?.(orderedSelection)}
                >
                  <WindowMoveIcon /><span>Move / Copy</span>
                </button>
              )}
              {props.onBulkSessionAction && <>
                <button type="button" className="workspace-selection-bulk-action" aria-label={`Close ${orderedSelection.length} selected tabs`}
                  title="Close selected tabs; keep their sessions running"
                  onClick={() => props.onBulkSessionAction?.("close", orderedSelection)}>
                  <CloseIcon /><span>Close tabs</span>
                </button>
                {onSessionTerminated && <button type="button" className="workspace-selection-bulk-action" aria-label={`End ${orderedSelection.length} selected sessions`}
                  title="End selected tmux sessions everywhere; confirmation required"
                  onClick={() => props.onBulkSessionAction?.("end", orderedSelection)}>
                  <TrashIcon /><span>End sessions</span>
                </button>}
              </>}
              <button
                type="button"
                onClick={() => clearWorkspaceTabSelection()}
                aria-label="Clear tab move selection"
                title="Clear tab selection (Escape)"
              >
                <CloseIcon />
              </button>
            </div>
          )}
          {workspacePersistenceState === "unsaved" ? onSaveWorkspace && (
            <button
              ref={saveButtonRef}
              type="button"
              className="workspace-save-button"
              onClick={() => setSaveDialogOpen(true)}
              aria-haspopup="dialog"
              aria-controls="workspace-save-dialog"
              aria-expanded={saveDialogOpen}
              aria-label="Save workspace"
              aria-description={`Workspace: ${identityName}`}
              title={`${identityName} - Save workspace`}
            >
              <SaveIcon />
              <span className="workspace-identity-copy">
                <span className="workspace-identity-name" title={identityName}>
                  {identityName}
                </span>
                <span className="workspace-identity-state">Save</span>
              </span>
            </button>
          ) : persistenceCopy && (
            <span
              ref={persistenceStatusRef}
              className={`workspace-saved-indicator ${workspacePersistenceState}`}
              role="status"
              tabIndex={-1}
              aria-label={persistenceCopy.accessibleLabel}
              aria-description={`Workspace: ${identityName}`}
              title={`${identityName} - ${persistenceCopy.label}`}
            >
              {workspacePersistenceState === "saved"
                ? <CheckIcon />
                : workspacePersistenceState === "loading"
                  ? <HistoryIcon />
                  : <SaveIcon />}
              <span className="workspace-identity-copy">
                <span className="workspace-identity-name" title={identityName}>
                  {identityName}
                </span>
                <span className="workspace-identity-state">{persistenceCopy.label}</span>
              </span>
            </span>
          )}
          {onRecreateAllMissing && missingSessionCount > 0 && (
            <button
              type="button"
              className="workspace-recreate-missing"
              onClick={onRecreateAllMissing}
              aria-label={`Recreate ${missingSessionCount} missing ${missingSessionCount === 1 ? "shell" : "shells"} in this workspace`}
              title={`Recreate ${missingSessionCount} missing ${missingSessionCount === 1 ? "shell" : "shells"}`}
            >
              <TerminalIcon />
              <span>Recreate {missingSessionCount}</span>
            </button>
          )}
          {(showRenameWorkspaceButton || props.onMarkSessionUnread) && (
            <div className="workspace-rename-unread-actions" role="group" aria-label="Rename and unread actions">
              {showRenameWorkspaceButton && (
                <button
                  ref={renameButtonRef}
                  type="button"
                  className="workspace-rename-button"
                  onClick={() => setRenameDialogOpen(true)}
                  aria-haspopup="dialog"
                  aria-controls="workspace-rename-dialog"
                  aria-expanded={renameDialogOpen}
                  aria-label={`Rename workspace ${identityName}`}
                  title={`Rename ${identityName}`}
                >
                  <EditIcon />
                  <span>Rename</span>
                </button>
              )}
              {props.onMarkSessionUnread && (
                <button
                  type="button"
                  className="workspace-session-placement-button workspace-mark-unread-button"
                  disabled={!unreadTarget || unreadTargetUnchecked}
                  aria-label={unreadLabel}
                  aria-description={unreadHint}
                  title={unreadHint}
                  onClick={() => {
                    if (!unreadTarget) return;
                    props.onMarkSessionUnread?.(unreadTarget);
                    setReorderAnnouncement(`${tabTitle(unreadTarget, sessionsByName)} marked as unread.`);
                  }}
                >
                  <UnreadIcon />
                  <span>{unreadLabel}</span>
                </button>
              )}
            </div>
          )}
          {!compactViewport && onSwitchWorkspace && (
            <WorkspaceQuickSwitcher
              activeWorkspaceId={activeWorkspaceId}
              activeWorkspaceName={identityName}
              disabled={workspacePersistenceState === "loading"}
              onSwitch={onSwitchWorkspace}
            />
          )}
          {onOpenTabSearch && openSessions.length > 0 && (
            <button
              type="button"
              className="workspace-tab-search-button"
              onClick={onOpenTabSearch}
              aria-label="Search open tabs"
              aria-keyshortcuts={directShortcutAria(
                shortcutBindings["workspace-find-tab"],
              )}
              title={`Search open tabs${directShortcutLabel(
                shortcutBindings["workspace-find-tab"],
              ) ? ` (${directShortcutLabel(shortcutBindings["workspace-find-tab"])})` : ""}`}
            >
              <SearchIcon />
              <span>Find tab</span>
              {directShortcutLabel(shortcutBindings["workspace-find-tab"]) && (
                <kbd>{directShortcutLabel(shortcutBindings["workspace-find-tab"])}</kbd>
              )}
            </button>
          )}
          <WorkspaceCommandPalette
            commands={commandPaletteCommands}
            compactViewport={compactViewport}
          />
          <button
            type="button"
            className={recentsOpen ? "workspace-recents-button active" : "workspace-recents-button"}
            onClick={onOpenRecents}
            aria-haspopup="dialog"
            aria-expanded={recentsOpen}
            aria-label={`Open session switcher${closedRecentCount > 0 ? `, ${closedRecentCount} recently visited` : ""}`}
          >
            <ListIcon />
            <span>Switch session</span>
            {closedRecentCount > 0 && <strong>{closedRecentCount}</strong>}
          </button>
          <button type="button" className="workspace-recents-button"
            onClick={() => setSessionHistoryOpen(true)} aria-haspopup="dialog"
            title={activeWorkspaceId ? "Session history for this workspace" : "Session history: save this workspace to track its own sessions"}>
            <HistoryIcon /><span>Session history</span>
          </button>
          {orientation === "vertical" && (
            <div
              className="workspace-tab-rail-resize-handle"
              role="separator"
              tabIndex={0}
              aria-label="Resize vertical session tabs"
              aria-orientation="vertical"
              aria-valuemin={MIN_DESKTOP_TAB_RAIL_WIDTH}
              aria-valuemax={desktopTabRailMaxWidth}
              aria-valuenow={visibleDesktopTabRailWidth}
              aria-valuetext={`${visibleDesktopTabRailWidth} pixels`}
              title="Drag to resize. Use Left/Right, Shift for larger steps, Home/End, or Enter to reset."
              onPointerDown={startDesktopTabRailDrag}
              onLostPointerCapture={(event) => commitDesktopTabRailDrag(event.pointerId)}
              onDoubleClick={() => commitDesktopTabRailWidth(DEFAULT_DESKTOP_TAB_RAIL_WIDTH)}
              onKeyDown={desktopTabRailKeyDown}
            >
              <span className="workspace-tab-rail-resize-grip" aria-hidden="true" />
            </div>
          )}
        </nav>
      </div>

      <WorkspaceWindowActionError
        message={windowActionError}
        onDismiss={() => setWindowActionError("")}
      />
      {sessionHistoryOpen && <SessionHistoryDialog workspaceId={activeWorkspaceId} workspaceName={workspaceName}
        onClose={() => setSessionHistoryOpen(false)} onOpenSession={onSelect} />}

      {sessionAddOpen && onAddSession && (
        <WorkspaceSessionAddDialog
          sessions={sessions}
          openSessions={openSessions}
          recoverableSessions={recoverableSessions}
          onRecreate={onRecreateSession}
          workspaceName={identityName}
          workspaceFull={openSessions.length >= MAX_WORKSPACE_TABS}
          onAdd={onAddSession}
          onClose={() => setSessionAddOpen(false)}
        />
      )}

      {quickNewSessionError && onDismissQuickNewSessionError && (
        <WorkspaceWindowActionError
          message={quickNewSessionError}
          onDismiss={onDismissQuickNewSessionError}
          dismissLabel="Dismiss quick session error"
        />
      )}

      <p className="workspace-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {newSessionActive
          ? "Active view: New session"
          : `Active session: ${activeSession
            ? tabTitle(activeSession, sessionsByName)
            : "None"}`}
      </p>

      {reorderAnnouncement && (
        <p className="workspace-sr-only" role="status" aria-live="polite" aria-atomic="true">
          {reorderAnnouncement}
        </p>
      )}

      {recentsOpen && !terminateTarget && !groupDialog && (
        <WorkspaceRecentsDialog
          {...props}
          sessionsByName={sessionsByName}
          query={recentsQuery}
          initialScrollTop={recentsScrollTopRef.current}
          onQueryChange={setRecentsQuery}
          onScrollPositionChange={(scrollTop) => {
            recentsScrollTopRef.current = scrollTop;
          }}
          onRequestSaveWorkspace={requestSaveFromRecents}
          onRequestRenameWorkspace={canRenameWorkspace
            ? requestRenameFromRecents
            : undefined}
          onRequestTerminateSession={setTerminateTarget}
          onRequestNewTabGroup={(initialSession) => openGroupDialog(
            null,
            initialSession ?? activeSession,
            null,
          )}
          onRequestEditTabGroup={(groupId) => openGroupDialog(
            groupId,
            null,
            null,
          )}
        />
      )}

      {terminateTarget && onSessionTerminated && (
        <SessionTerminateDialog
          sessionName={terminateTarget.name}
          sessionTitle={terminateTarget.customTitle}
          onClose={() => setTerminateTarget(null)}
          onTerminate={terminateSelectedSession}
          onFallbackFocus={focusTerminateReplacement}
        />
      )}

      {saveDialogOpen && onSaveWorkspace && workspacePersistenceState === "unsaved" && (
        <WorkspaceSaveDialog
          tabs={openSessions}
          activeSession={activeSession}
          onSave={onSaveWorkspace}
          onClose={() => setSaveDialogOpen(false)}
          onFallbackFocus={focusSaveReplacement}
        />
      )}

      {renameDialogOpen && onRenameWorkspace && canRenameWorkspace && (
        <WorkspaceSaveDialog
          variant="rename"
          initialName={identityName}
          workspaceId={activeWorkspaceId ?? undefined}
          groupCount={groups.length}
          paneViewCount={paneLayouts.length}
          tabs={openSessions}
          activeSession={activeSession}
          onSave={onRenameWorkspace}
          onClose={() => setRenameDialogOpen(false)}
          onFallbackFocus={focusRenameReplacement}
        />
      )}

      {groupDialog && onSaveTabGroup && (
        <WorkspaceGroupDialog
          groups={groups}
          openSessions={openSessions}
          sessions={sessions}
          groupId={groupDialog.groupId}
          initialSession={groupDialog.initialSession}
          onSave={onSaveTabGroup}
          onDelete={(groupId) => onDeleteTabGroup?.(groupId)}
          onClose={closeGroupDialog}
        />
      )}
    </>
  );
}
