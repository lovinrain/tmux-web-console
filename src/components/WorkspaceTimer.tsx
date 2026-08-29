import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { ClockIcon, CloseIcon, PinIcon } from "../icons";

const DESKTOP_TIMER_QUERY = "(min-width: 1025px), (min-width: 641px) and (min-height: 501px) and (pointer: fine)";
const DEFAULT_COUNTDOWN_MS = 25 * 60 * 1_000;
const MAX_COUNTDOWN_MS = ((99 * 60 * 60) + (59 * 60) + 59) * 1_000;
const TIMER_PANEL_WIDTH = 320;
const TIMER_PANEL_ESTIMATED_HEIGHT = 350;
const TIMER_PANEL_MARGIN = 12;
const TIMER_MOVE_STEP = 12;
const TIMER_MOVE_LARGE_STEP = 32;
const ALARM_REPEAT_MS = 1_250;
const ALARM_SOUND_LIMIT_MS = 60_000;

export const WORKSPACE_TIMER_STORAGE_PREFIX = "muxdeck.workspace-timer.v1:";

type TimerMode = "countdown" | "stopwatch";
type TimerPhase = "idle" | "running" | "paused" | "alarm";

interface TimerState {
  mode: TimerMode;
  phase: TimerPhase;
  durationMs: number;
  remainingMs: number;
  accumulatedMs: number;
  targetAt: number | null;
  startedAt: number | null;
}

interface TimerPosition {
  x: number;
  y: number;
}

interface TimerPanelState {
  open: boolean;
  pinned: boolean;
  position: TimerPosition;
}

interface WorkspaceTimerStore {
  identity: string;
  timer: TimerState;
  panel: TimerPanelState;
}

interface PersistedWorkspaceTimer {
  version: 1;
  timer: TimerState;
  panel: TimerPanelState;
}

interface WorkspaceTimerProps {
  sessionName: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
}

type AudioContextWithOptionalClose = AudioContext & {
  close?: () => Promise<void>;
};

function timerViewport(): { width: number; height: number } {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
}

function defaultTimerPosition(): TimerPosition {
  const viewport = timerViewport();
  return {
    x: Math.max(TIMER_PANEL_MARGIN, Math.round((viewport.width - TIMER_PANEL_WIDTH) / 2)),
    y: Math.max(TIMER_PANEL_MARGIN, Math.min(92, viewport.height - TIMER_PANEL_MARGIN)),
  };
}

function clampTimerPosition(
  position: TimerPosition,
  element?: HTMLElement | null,
): TimerPosition {
  const viewport = timerViewport();
  const rect = element?.getBoundingClientRect();
  const width = rect?.width || TIMER_PANEL_WIDTH;
  const height = rect?.height || TIMER_PANEL_ESTIMATED_HEIGHT;
  return {
    x: Math.round(Math.min(
      Math.max(TIMER_PANEL_MARGIN, position.x),
      Math.max(TIMER_PANEL_MARGIN, viewport.width - width - TIMER_PANEL_MARGIN),
    )),
    y: Math.round(Math.min(
      Math.max(TIMER_PANEL_MARGIN, position.y),
      Math.max(TIMER_PANEL_MARGIN, viewport.height - height - TIMER_PANEL_MARGIN),
    )),
  };
}

function defaultTimerState(): TimerState {
  return {
    mode: "countdown",
    phase: "idle",
    durationMs: DEFAULT_COUNTDOWN_MS,
    remainingMs: DEFAULT_COUNTDOWN_MS,
    accumulatedMs: 0,
    targetAt: null,
    startedAt: null,
  };
}

function defaultPanelState(): TimerPanelState {
  return {
    open: false,
    pinned: false,
    position: defaultTimerPosition(),
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeTimerState(value: unknown, now = Date.now()): TimerState {
  const fallback = defaultTimerState();
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<TimerState>;
  const mode: TimerMode = candidate.mode === "stopwatch" ? "stopwatch" : "countdown";
  let phase: TimerPhase = candidate.phase === "running"
    || candidate.phase === "paused"
    || candidate.phase === "alarm"
    ? candidate.phase
    : "idle";
  const durationMs = Math.min(
    MAX_COUNTDOWN_MS,
    Math.max(0, finiteNumber(candidate.durationMs, DEFAULT_COUNTDOWN_MS)),
  );
  let remainingMs = Math.min(
    MAX_COUNTDOWN_MS,
    Math.max(0, finiteNumber(candidate.remainingMs, durationMs)),
  );
  const accumulatedMs = Math.max(0, finiteNumber(candidate.accumulatedMs, 0));
  let targetAt = nullableFiniteNumber(candidate.targetAt);
  let startedAt = nullableFiniteNumber(candidate.startedAt);

  if (mode === "countdown") {
    startedAt = null;
    if (phase === "running") {
      if (targetAt === null) {
        phase = remainingMs > 0 ? "paused" : "idle";
      } else if (targetAt <= now) {
        phase = "alarm";
        remainingMs = 0;
        targetAt = null;
      }
    } else {
      targetAt = null;
    }
    if (phase === "alarm") remainingMs = 0;
    if (phase === "idle") remainingMs = durationMs;
  } else {
    targetAt = null;
    remainingMs = durationMs;
    if (phase === "alarm") phase = accumulatedMs > 0 ? "paused" : "idle";
    if (phase === "running" && startedAt === null) {
      phase = accumulatedMs > 0 ? "paused" : "idle";
    }
    if (phase !== "running") startedAt = null;
  }

  return {
    mode,
    phase,
    durationMs,
    remainingMs,
    accumulatedMs,
    targetAt,
    startedAt,
  };
}

function normalizePanelState(value: unknown): TimerPanelState {
  const fallback = defaultPanelState();
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<TimerPanelState>;
  const rawPosition = candidate.position as Partial<TimerPosition> | undefined;
  const position = rawPosition
    && Number.isFinite(rawPosition.x)
    && Number.isFinite(rawPosition.y)
    ? clampTimerPosition({ x: Number(rawPosition.x), y: Number(rawPosition.y) })
    : fallback.position;
  const pinned = candidate.pinned === true;
  return {
    open: pinned || candidate.open === true,
    pinned,
    position,
  };
}

function readWorkspaceTimer(identity: string): Omit<WorkspaceTimerStore, "identity"> {
  try {
    const raw = window.localStorage.getItem(`${WORKSPACE_TIMER_STORAGE_PREFIX}${identity}`);
    if (!raw) return { timer: defaultTimerState(), panel: defaultPanelState() };
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceTimer>;
    return {
      timer: normalizeTimerState(parsed.timer),
      panel: normalizePanelState(parsed.panel),
    };
  } catch {
    return { timer: defaultTimerState(), panel: defaultPanelState() };
  }
}

function writeWorkspaceTimer(
  identity: string,
  timer: TimerState,
  panel: TimerPanelState,
): void {
  try {
    const persisted: PersistedWorkspaceTimer = {
      version: 1,
      timer,
      panel,
    };
    window.localStorage.setItem(
      `${WORKSPACE_TIMER_STORAGE_PREFIX}${identity}`,
      JSON.stringify(persisted),
    );
  } catch {
    // The timer continues in memory when browser storage is unavailable.
  }
}

function desktopTimerViewport(): boolean {
  if (typeof window.matchMedia === "function") {
    return window.matchMedia(DESKTOP_TIMER_QUERY).matches;
  }
  const viewport = timerViewport();
  return viewport.width > 640 && viewport.height > 500;
}

function useDesktopTimer(): boolean {
  const [desktop, setDesktop] = useState(desktopTimerViewport);

  useEffect(() => {
    const query = window.matchMedia?.(DESKTOP_TIMER_QUERY);
    const viewport = window.visualViewport;
    const update = () => setDesktop(desktopTimerViewport());
    update();
    query?.addEventListener?.("change", update);
    window.addEventListener("resize", update);
    viewport?.addEventListener?.("resize", update);
    return () => {
      query?.removeEventListener?.("change", update);
      window.removeEventListener("resize", update);
      viewport?.removeEventListener?.("resize", update);
    };
  }, []);

  return desktop;
}

function timerDisplayMs(timer: TimerState, now: number): number {
  if (timer.mode === "countdown") {
    return timer.phase === "running" && timer.targetAt !== null
      ? Math.max(0, timer.targetAt - now)
      : timer.remainingMs;
  }
  return timer.phase === "running" && timer.startedAt !== null
    ? timer.accumulatedMs + Math.max(0, now - timer.startedAt)
    : timer.accumulatedMs;
}

function formatTimer(ms: number, mode: TimerMode): string {
  const totalSeconds = mode === "countdown"
    ? Math.ceil(Math.max(0, ms) / 1_000)
    : Math.floor(Math.max(0, ms) / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function phaseLabel(phase: TimerPhase): string {
  if (phase === "running") return "Running";
  if (phase === "paused") return "Paused";
  if (phase === "alarm") return "Time's up";
  return "Ready";
}

export function WorkspaceTimer({
  sessionName,
  workspaceId = null,
  workspaceName = null,
}: WorkspaceTimerProps) {
  const desktop = useDesktopTimer();
  const headingId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const interactionCleanupRef = useRef<(() => void) | null>(null);
  const audioContextRef = useRef<AudioContextWithOptionalClose | null>(null);
  const storageIdentity = workspaceId ? `workspace:${workspaceId}` : null;
  const renderIdentity = storageIdentity ?? "temporary-workspace";
  const initialStoreRef = useRef<WorkspaceTimerStore | null>(null);
  if (initialStoreRef.current === null) {
    const initial = storageIdentity
      ? readWorkspaceTimer(storageIdentity)
      : { timer: defaultTimerState(), panel: defaultPanelState() };
    initialStoreRef.current = { identity: renderIdentity, ...initial };
  }
  const [store, setStore] = useState<WorkspaceTimerStore>(initialStoreRef.current);
  const [now, setNow] = useState(Date.now);
  const previousSessionRef = useRef({ identity: renderIdentity, sessionName });

  useEffect(() => {
    if (store.identity === renderIdentity) return;
    const restored = storageIdentity
      ? readWorkspaceTimer(storageIdentity)
      : { timer: defaultTimerState(), panel: defaultPanelState() };
    setNow(Date.now());
    setStore({ identity: renderIdentity, ...restored });
  }, [renderIdentity, storageIdentity, store.identity]);

  useEffect(() => {
    if (!storageIdentity || store.identity !== renderIdentity) return;
    writeWorkspaceTimer(storageIdentity, store.timer, store.panel);
  }, [renderIdentity, storageIdentity, store]);

  useEffect(() => {
    const previous = previousSessionRef.current;
    if (
      previous.identity === renderIdentity
      && previous.sessionName !== sessionName
    ) {
      setStore((current) => {
        if (
          current.identity !== renderIdentity
          || !current.panel.open
          || current.panel.pinned
        ) return current;
        return {
          ...current,
          panel: { ...current.panel, open: false },
        };
      });
    }
    previousSessionRef.current = { identity: renderIdentity, sessionName };
  }, [renderIdentity, sessionName]);

  const active = store.identity === renderIdentity;
  const timer = active ? store.timer : defaultTimerState();
  const panel = active ? store.panel : defaultPanelState();
  const displayMs = timerDisplayMs(timer, now);
  const display = timer.phase === "alarm"
    ? "TIME'S UP"
    : formatTimer(displayMs, timer.mode);

  useEffect(() => {
    if (!active || timer.phase !== "running") return;
    const update = () => setNow(Date.now());
    update();
    const interval = window.setInterval(update, 250);
    const visibilityChanged = () => {
      if (!document.hidden) update();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [active, renderIdentity, timer.phase]);

  useEffect(() => {
    if (
      !active
      || timer.mode !== "countdown"
      || timer.phase !== "running"
      || timer.targetAt === null
      || now < timer.targetAt
    ) return;
    setStore((current) => {
      if (
        current.identity !== renderIdentity
        || current.timer.mode !== "countdown"
        || current.timer.phase !== "running"
        || current.timer.targetAt === null
        || Date.now() < current.timer.targetAt
      ) return current;
      return {
        ...current,
        timer: {
          ...current.timer,
          phase: "alarm",
          remainingMs: 0,
          targetAt: null,
        },
      };
    });
  }, [active, now, renderIdentity, timer.mode, timer.phase, timer.targetAt]);

  const ensureAudioContext = useCallback((): AudioContextWithOptionalClose | null => {
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      return audioContextRef.current;
    }
    const AudioContextConstructor = window.AudioContext
      || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return null;
    try {
      audioContextRef.current = new AudioContextConstructor();
      return audioContextRef.current;
    } catch {
      return null;
    }
  }, []);

  const playAlarmTone = useCallback((context = audioContextRef.current) => {
    if (!context || context.state === "closed") return;
    try {
      const startAt = context.currentTime;
      const gain = context.createGain();
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, startAt);
      oscillator.frequency.setValueAtTime(1_120, startAt + 0.16);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.16, startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.38);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + 0.4);
    } catch {
      // The visible alarm remains available if Web Audio is blocked.
    }
  }, []);

  const primeAlarmAudio = useCallback((ringNow = false) => {
    const context = ensureAudioContext();
    if (!context) return;
    if (context.state === "suspended") {
      const ready = context.resume();
      if (ringNow) void ready.then(() => playAlarmTone(context)).catch(() => undefined);
    } else if (ringNow) {
      playAlarmTone(context);
    }
  }, [ensureAudioContext, playAlarmTone]);

  useEffect(() => {
    if (!active || timer.phase !== "alarm") return;
    primeAlarmAudio(true);
    const repeat = window.setInterval(() => playAlarmTone(), ALARM_REPEAT_MS);
    const stopRepeating = window.setTimeout(() => {
      window.clearInterval(repeat);
    }, ALARM_SOUND_LIMIT_MS);
    return () => {
      window.clearInterval(repeat);
      window.clearTimeout(stopRepeating);
    };
  }, [active, playAlarmTone, primeAlarmAudio, renderIdentity, timer.phase]);

  useEffect(() => {
    if (!active || timer.phase !== "alarm") return;
    let baseTitle = document.title.replace(/^\[TIMER\]\s*/, "");
    const applyAlarmTitle = () => {
      if (!document.title.startsWith("[TIMER] ")) baseTitle = document.title;
      const alarmTitle = `[TIMER] ${baseTitle.replace(/^\[TIMER\]\s*/, "")}`;
      if (document.title !== alarmTitle) document.title = alarmTitle;
    };
    applyAlarmTitle();
    const observer = typeof MutationObserver === "function"
      ? new MutationObserver(applyAlarmTitle)
      : null;
    observer?.observe(document.head, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => {
      observer?.disconnect();
      if (document.title.startsWith("[TIMER] ")) document.title = baseTitle;
    };
  }, [active, renderIdentity, timer.phase]);

  useEffect(() => () => {
    interactionCleanupRef.current?.();
    document.documentElement.classList.remove("workspace-timer-moving");
    const context = audioContextRef.current;
    if (context && context.state !== "closed") void context.close?.().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!active || !panel.open) return;
    const keepVisible = () => {
      setStore((current) => {
        if (current.identity !== renderIdentity) return current;
        const position = clampTimerPosition(current.panel.position, panelRef.current);
        if (
          position.x === current.panel.position.x
          && position.y === current.panel.position.y
        ) return current;
        return { ...current, panel: { ...current.panel, position } };
      });
    };
    const viewport = window.visualViewport;
    window.addEventListener("resize", keepVisible);
    viewport?.addEventListener?.("resize", keepVisible);
    return () => {
      window.removeEventListener("resize", keepVisible);
      viewport?.removeEventListener?.("resize", keepVisible);
    };
  }, [active, panel.open, renderIdentity]);

  const updateTimer = useCallback((updater: (current: TimerState) => TimerState) => {
    setStore((current) => current.identity === renderIdentity
      ? { ...current, timer: updater(current.timer) }
      : current);
  }, [renderIdentity]);

  const updatePanel = useCallback((updater: (current: TimerPanelState) => TimerPanelState) => {
    setStore((current) => current.identity === renderIdentity
      ? { ...current, panel: updater(current.panel) }
      : current);
  }, [renderIdentity]);

  const setMode = (mode: TimerMode) => {
    updateTimer((current) => {
      if (current.mode === mode) return current;
      return mode === "countdown"
        ? {
            ...defaultTimerState(),
            durationMs: current.durationMs,
            remainingMs: current.durationMs,
          }
        : {
            ...defaultTimerState(),
            mode: "stopwatch",
            durationMs: current.durationMs,
            remainingMs: current.durationMs,
          };
    });
    setNow(Date.now());
  };

  const setCountdownDuration = (durationMs: number) => {
    const duration = Math.min(MAX_COUNTDOWN_MS, Math.max(0, durationMs));
    updateTimer((current) => ({
      ...current,
      phase: "idle",
      durationMs: duration,
      remainingMs: duration,
      targetAt: null,
    }));
    setNow(Date.now());
  };

  const startOrResume = () => {
    const startedAt = Date.now();
    primeAlarmAudio();
    updateTimer((current) => {
      if (current.phase === "running" || current.phase === "alarm") return current;
      if (current.mode === "countdown") {
        const remainingMs = current.phase === "paused"
          ? current.remainingMs
          : current.durationMs;
        if (remainingMs <= 0) return current;
        return {
          ...current,
          phase: "running",
          remainingMs,
          targetAt: startedAt + remainingMs,
        };
      }
      return {
        ...current,
        phase: "running",
        startedAt,
      };
    });
    setNow(startedAt);
  };

  const pause = () => {
    const pausedAt = Date.now();
    updateTimer((current) => {
      if (current.phase !== "running") return current;
      if (current.mode === "countdown") {
        return {
          ...current,
          phase: "paused",
          remainingMs: Math.max(0, (current.targetAt ?? pausedAt) - pausedAt),
          targetAt: null,
        };
      }
      return {
        ...current,
        phase: "paused",
        accumulatedMs: current.accumulatedMs
          + Math.max(0, pausedAt - (current.startedAt ?? pausedAt)),
        startedAt: null,
      };
    });
    setNow(pausedAt);
  };

  const reset = () => {
    updateTimer((current) => current.mode === "countdown"
      ? {
          ...current,
          phase: "idle",
          remainingMs: current.durationMs,
          targetAt: null,
          startedAt: null,
        }
      : {
          ...current,
          phase: "idle",
          accumulatedMs: 0,
          targetAt: null,
          startedAt: null,
        });
    setNow(Date.now());
  };

  const dismissAlarm = () => {
    updateTimer((current) => ({
      ...current,
      phase: "idle",
      remainingMs: current.durationMs,
      targetAt: null,
    }));
    setNow(Date.now());
  };

  const togglePanel = () => {
    if (timer.phase === "alarm") primeAlarmAudio(true);
    updatePanel((current) => current.open
      ? { ...current, open: false, pinned: false }
      : { ...current, open: true });
  };

  const startDragging = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (event.button !== 0 || target.closest("button, input, select, a")) return;
    event.preventDefault();
    event.stopPropagation();
    interactionCleanupRef.current?.();

    const pointerId = event.pointerId;
    const rect = panelRef.current?.getBoundingClientRect();
    const offsetX = event.clientX - (rect?.left ?? panel.position.x);
    const offsetY = event.clientY - (rect?.top ?? panel.position.y);

    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.documentElement.classList.remove("workspace-timer-moving");
      if (interactionCleanupRef.current === cleanup) interactionCleanupRef.current = null;
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const position = clampTimerPosition({
        x: moveEvent.clientX - offsetX,
        y: moveEvent.clientY - offsetY,
      }, panelRef.current);
      updatePanel((current) => ({ ...current, position }));
    };
    const finish = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      cleanup();
    };

    interactionCleanupRef.current = cleanup;
    document.documentElement.classList.add("workspace-timer-moving");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }, [panel.position.x, panel.position.y, updatePanel]);

  const moveWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const direction = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const distance = event.shiftKey ? TIMER_MOVE_LARGE_STEP : TIMER_MOVE_STEP;
    updatePanel((current) => ({
      ...current,
      position: clampTimerPosition({
        x: current.position.x + direction[0] * distance,
        y: current.position.y + direction[1] * distance,
      }, panelRef.current),
    }));
  }, [updatePanel]);

  if (!desktop || !active) return null;

  const countdownHours = Math.floor(timer.durationMs / 3_600_000);
  const countdownMinutes = Math.floor((timer.durationMs % 3_600_000) / 60_000);
  const countdownSeconds = Math.floor((timer.durationMs % 60_000) / 1_000);
  const timerLabel = timer.mode === "countdown" ? "Countdown" : "Stopwatch";
  const panelStyle: CSSProperties = {
    left: panel.position.x,
    top: panel.position.y,
  };

  const floatingPanel = panel.open ? (
    <section
      ref={panelRef}
      className={`workspace-timer-panel${panel.pinned ? " pinned" : ""}${timer.phase === "alarm" ? " alarm" : ""}`}
      style={panelStyle}
      role="dialog"
      aria-labelledby={headingId}
      data-pinned={panel.pinned ? "true" : "false"}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          updatePanel((current) => ({ ...current, open: false, pinned: false }));
        }
        event.stopPropagation();
      }}
      onKeyUp={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header
        className="workspace-timer-panel-header"
        tabIndex={0}
        aria-label="Move workspace timer window"
        title="Drag this title strip to move the timer. Arrow keys also move it."
        onPointerDown={startDragging}
        onKeyDown={moveWithKeyboard}
      >
        <ClockIcon />
        <div>
          <span>{workspaceName?.trim() || "Workspace"}</span>
          <h2 id={headingId}>Timer</h2>
        </div>
        {panel.pinned && <em aria-hidden="true">PINNED</em>}
        <button
          type="button"
          aria-label={panel.pinned ? "Unpin workspace timer" : "Pin workspace timer"}
          aria-pressed={panel.pinned}
          title={panel.pinned
            ? "Stop keeping this timer open"
            : "Keep this timer visible across session switches"}
          onClick={() => updatePanel((current) => ({
            ...current,
            open: true,
            pinned: !current.pinned,
          }))}
        >
          <PinIcon filled={panel.pinned} />
        </button>
        <button
          type="button"
          aria-label="Close workspace timer"
          onClick={() => updatePanel((current) => ({
            ...current,
            open: false,
            pinned: false,
          }))}
        >
          <CloseIcon />
        </button>
      </header>

      <div className="workspace-timer-body">
        <div className="workspace-timer-mode" role="group" aria-label="Timer mode">
          <button
            type="button"
            aria-pressed={timer.mode === "countdown"}
            disabled={timer.phase === "running" || timer.phase === "alarm"}
            onClick={() => setMode("countdown")}
          >
            Countdown
          </button>
          <button
            type="button"
            aria-pressed={timer.mode === "stopwatch"}
            disabled={timer.phase === "running" || timer.phase === "alarm"}
            onClick={() => setMode("stopwatch")}
          >
            Stopwatch
          </button>
        </div>

        <div className="workspace-timer-readout" data-phase={timer.phase}>
          <span>{phaseLabel(timer.phase)}</span>
          <output
            role="timer"
            aria-live={timer.phase === "alarm" ? "assertive" : "off"}
          >
            {display}
          </output>
        </div>

        {timer.mode === "countdown" && (
          <>
            <div className="workspace-timer-duration" aria-label="Countdown duration">
              <label>
                <span>HR</span>
                <input
                  type="number"
                  min="0"
                  max="99"
                  inputMode="numeric"
                  value={countdownHours}
                  disabled={timer.phase !== "idle"}
                  aria-label="Countdown hours"
                  onChange={(event) => setCountdownDuration(
                    (Math.min(99, Math.max(0, Number(event.target.value) || 0)) * 3_600
                      + countdownMinutes * 60
                      + countdownSeconds) * 1_000,
                  )}
                />
              </label>
              <b aria-hidden="true">:</b>
              <label>
                <span>MIN</span>
                <input
                  type="number"
                  min="0"
                  max="59"
                  inputMode="numeric"
                  value={countdownMinutes}
                  disabled={timer.phase !== "idle"}
                  aria-label="Countdown minutes"
                  onChange={(event) => setCountdownDuration(
                    (countdownHours * 3_600
                      + Math.min(59, Math.max(0, Number(event.target.value) || 0)) * 60
                      + countdownSeconds) * 1_000,
                  )}
                />
              </label>
              <b aria-hidden="true">:</b>
              <label>
                <span>SEC</span>
                <input
                  type="number"
                  min="0"
                  max="59"
                  inputMode="numeric"
                  value={countdownSeconds}
                  disabled={timer.phase !== "idle"}
                  aria-label="Countdown seconds"
                  onChange={(event) => setCountdownDuration(
                    (countdownHours * 3_600
                      + countdownMinutes * 60
                      + Math.min(59, Math.max(0, Number(event.target.value) || 0))) * 1_000,
                  )}
                />
              </label>
            </div>
            <div className="workspace-timer-presets" aria-label="Countdown presets">
              {[5, 15, 25, 45].map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  disabled={timer.phase !== "idle"}
                  aria-label={`Set countdown to ${minutes} minutes`}
                  onClick={() => setCountdownDuration(minutes * 60_000)}
                >
                  {minutes}m
                </button>
              ))}
            </div>
          </>
        )}

        <div className="workspace-timer-actions">
          {timer.phase === "alarm" ? (
            <button type="button" className="dismiss" onClick={dismissAlarm}>
              Dismiss alarm
            </button>
          ) : timer.phase === "running" ? (
            <button type="button" className="primary" onClick={pause}>
              Pause
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={timer.mode === "countdown" && timer.durationMs <= 0}
              onClick={startOrResume}
            >
              {timer.phase === "paused" ? "Resume" : "Start"}
            </button>
          )}
          {timer.phase !== "alarm" && (
            <button
              type="button"
              disabled={timer.phase === "idle" && (
                timer.mode === "countdown"
                  ? timer.remainingMs === timer.durationMs
                  : timer.accumulatedMs === 0
              )}
              onClick={reset}
            >
              Reset
            </button>
          )}
        </div>
      </div>
    </section>
  ) : null;

  return (
    <>
      <button
        type="button"
        className={`workspace-timer-card ${timer.mode} ${timer.phase}${panel.open ? " window-open" : ""}${panel.pinned ? " window-pinned" : ""}`}
        aria-label={panel.open ? "Hide workspace timer" : "Show workspace timer"}
        aria-expanded={panel.open}
        title={`${timerLabel}: ${display} - ${phaseLabel(timer.phase)}`}
        onClick={togglePanel}
      >
        <ClockIcon />
        <span>
          <strong>{timerLabel}</strong>
          <small>{display}</small>
        </span>
        {(panel.pinned || panel.open) && (
          <em aria-hidden="true">{panel.pinned ? "PIN" : "OPEN"}</em>
        )}
      </button>
      {floatingPanel && createPortal(floatingPanel, document.body)}
    </>
  );
}
