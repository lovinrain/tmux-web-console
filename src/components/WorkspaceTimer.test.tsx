import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTheme } from "../test-utils";
import {
  WORKSPACE_TIMER_STORAGE_PREFIX,
  WorkspaceTimer,
} from "./WorkspaceTimer";

function desktopMediaQuery(matches = true) {
  return vi.fn(() => ({
    matches,
    media: "",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function renderTimer(
  props: {
    sessionName?: string;
    workspaceId?: string | null;
    workspaceName?: string | null;
  } = {},
) {
  return renderWithTheme(
    <WorkspaceTimer
      sessionName={props.sessionName ?? "agent-one"}
      workspaceId={props.workspaceId === undefined ? "workspace-one" : props.workspaceId}
      workspaceName={props.workspaceName === undefined ? "Launch room" : props.workspaceName}
    />,
  );
}

function openTimer() {
  fireEvent.click(screen.getByRole("button", { name: "Show workspace timer" }));
  return screen.getByRole("dialog", { name: "Timer" });
}

function storedTimer(workspaceId = "workspace-one") {
  return JSON.parse(window.localStorage.getItem(
    `${WORKSPACE_TIMER_STORAGE_PREFIX}workspace:${workspaceId}`,
  ) || "null");
}

beforeEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.stubGlobal("matchMedia", desktopMediaQuery());
  window.localStorage.clear();
  document.title = "Muxdeck";
  document.documentElement.classList.remove("workspace-timer-moving");
});

describe("WorkspaceTimer", () => {
  it("opens a compact countdown panel and configures presets or exact durations", () => {
    renderTimer();

    const card = screen.getByRole("button", { name: "Show workspace timer" });
    expect(card).toHaveTextContent("Countdown");
    expect(card).toHaveTextContent("25:00");

    const timer = openTimer();
    expect(within(timer).getByRole("button", { name: "Countdown" }))
      .toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(timer).getByRole("button", {
      name: "Set countdown to 15 minutes",
    }));
    expect(within(timer).getByRole("timer")).toHaveTextContent("15:00");

    fireEvent.change(within(timer).getByRole("spinbutton", {
      name: "Countdown minutes",
    }), { target: { value: "2" } });
    fireEvent.change(within(timer).getByRole("spinbutton", {
      name: "Countdown seconds",
    }), { target: { value: "30" } });
    expect(within(timer).getByRole("timer")).toHaveTextContent("02:30");
    expect(storedTimer()).toMatchObject({
      version: 1,
      timer: { durationMs: 150_000, remainingMs: 150_000 },
      panel: { open: true, pinned: false },
    });
  });

  it("starts, pauses, resumes, and alarms a countdown with sound and tab title", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));
    const oscillatorStart = vi.fn();
    const oscillatorStop = vi.fn();
    const audioContext = {
      state: "running",
      currentTime: 3,
      destination: {},
      createGain: vi.fn(() => ({
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      })),
      createOscillator: vi.fn(() => ({
        type: "sine",
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: oscillatorStart,
        stop: oscillatorStop,
      })),
      resume: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    };
    vi.stubGlobal("AudioContext", vi.fn(function AudioContextMock() {
      return audioContext;
    }));
    renderTimer();
    const timer = openTimer();

    fireEvent.change(within(timer).getByRole("spinbutton", {
      name: "Countdown minutes",
    }), { target: { value: "0" } });
    fireEvent.change(within(timer).getByRole("spinbutton", {
      name: "Countdown seconds",
    }), { target: { value: "2" } });
    fireEvent.click(within(timer).getByRole("button", { name: "Start" }));
    expect(within(timer).getByRole("timer")).toHaveTextContent("02");

    act(() => vi.advanceTimersByTime(1_000));
    expect(within(timer).getByRole("timer")).toHaveTextContent("00:01");
    fireEvent.click(within(timer).getByRole("button", { name: "Pause" }));
    act(() => vi.advanceTimersByTime(5_000));
    expect(within(timer).getByRole("timer")).toHaveTextContent("00:01");

    fireEvent.click(within(timer).getByRole("button", { name: "Resume" }));
    act(() => vi.advanceTimersByTime(1_100));
    expect(within(timer).getByRole("timer")).toHaveTextContent("TIME'S UP");
    expect(document.title).toBe("[TIMER] Muxdeck");
    expect(oscillatorStart).toHaveBeenCalled();
    expect(oscillatorStop).toHaveBeenCalled();

    document.title = "Launch room - agent-two";
    await act(async () => Promise.resolve());
    expect(document.title).toBe("[TIMER] Launch room - agent-two");

    fireEvent.click(within(timer).getByRole("button", { name: "Dismiss alarm" }));
    expect(within(timer).getByRole("timer")).toHaveTextContent("00:02");
    expect(document.title).toBe("Launch room - agent-two");
  });

  it("runs a stopwatch across pause and resume, then resets it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));
    renderTimer();
    const timer = openTimer();

    fireEvent.click(within(timer).getByRole("button", { name: "Stopwatch" }));
    fireEvent.click(within(timer).getByRole("button", { name: "Start" }));
    act(() => vi.advanceTimersByTime(2_100));
    expect(within(timer).getByRole("timer")).toHaveTextContent("00:02");

    fireEvent.click(within(timer).getByRole("button", { name: "Pause" }));
    act(() => vi.advanceTimersByTime(4_000));
    expect(within(timer).getByRole("timer")).toHaveTextContent("00:02");
    fireEvent.click(within(timer).getByRole("button", { name: "Resume" }));
    act(() => vi.advanceTimersByTime(1_000));
    expect(within(timer).getByRole("timer")).toHaveTextContent("00:03");

    fireEvent.click(within(timer).getByRole("button", { name: "Pause" }));
    fireEvent.click(within(timer).getByRole("button", { name: "Reset" }));
    expect(within(timer).getByRole("timer")).toHaveTextContent("00:00");
  });

  it("restores elapsed wall-clock time and a pinned panel after reload", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));
    const first = renderTimer();
    let timer = openTimer();
    fireEvent.click(within(timer).getByRole("button", {
      name: "Set countdown to 5 minutes",
    }));
    fireEvent.click(within(timer).getByRole("button", { name: "Pin workspace timer" }));
    fireEvent.click(within(timer).getByRole("button", { name: "Start" }));
    act(() => vi.advanceTimersByTime(60_000));
    first.unmount();

    act(() => vi.advanceTimersByTime(60_000));
    renderTimer();
    timer = screen.getByRole("dialog", { name: "Timer" });
    expect(timer).toHaveAttribute("data-pinned", "true");
    expect(within(timer).getByRole("timer")).toHaveTextContent("03:00");
    expect(screen.getByRole("button", { name: "Hide workspace timer" }))
      .toHaveTextContent("PIN");
  });

  it("keeps a pinned panel across sessions but closes an unpinned panel", () => {
    const view = renderTimer();
    let timer = openTimer();
    fireEvent.click(within(timer).getByRole("button", { name: "Pin workspace timer" }));

    view.rerender(
      <WorkspaceTimer
        sessionName="agent-two"
        workspaceId="workspace-one"
        workspaceName="Launch room"
      />,
    );
    expect(screen.getByRole("dialog", { name: "Timer" })).toBeInTheDocument();

    timer = screen.getByRole("dialog", { name: "Timer" });
    fireEvent.click(within(timer).getByRole("button", { name: "Unpin workspace timer" }));
    view.rerender(
      <WorkspaceTimer
        sessionName="agent-three"
        workspaceId="workspace-one"
        workspaceName="Launch room"
      />,
    );
    expect(screen.queryByRole("dialog", { name: "Timer" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show workspace timer" }))
      .toBeInTheDocument();
  });

  it("persists keyboard movement and isolates panel state by workspace", () => {
    const first = renderTimer();
    const timer = openTimer();
    const titleStrip = within(timer).getByLabelText("Move workspace timer window");
    const initialLeft = Number.parseInt(timer.style.left, 10);
    fireEvent.keyDown(titleStrip, { key: "ArrowRight" });
    expect(timer).toHaveStyle({ left: `${initialLeft + 12}px` });
    fireEvent.click(within(timer).getByRole("button", { name: "Pin workspace timer" }));
    first.unmount();

    renderTimer({ workspaceId: "workspace-two", workspaceName: "Second room" });
    expect(screen.queryByRole("dialog", { name: "Timer" })).not.toBeInTheDocument();
    expect(storedTimer("workspace-one").panel.position.x).toBe(initialLeft + 12);
    expect(storedTimer("workspace-two").panel.open).toBe(false);
  });

  it("normalizes an expired persisted countdown into a visible alarm", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));
    window.localStorage.setItem(
      `${WORKSPACE_TIMER_STORAGE_PREFIX}workspace:workspace-one`,
      JSON.stringify({
        version: 1,
        timer: {
          mode: "countdown",
          phase: "running",
          durationMs: 60_000,
          remainingMs: 60_000,
          accumulatedMs: 0,
          targetAt: Date.now() - 1_000,
          startedAt: null,
        },
        panel: {
          open: true,
          pinned: true,
          position: { x: 80, y: 90 },
        },
      }),
    );

    renderTimer();
    expect(screen.getByRole("timer")).toHaveTextContent("TIME'S UP");
    expect(document.title).toBe("[TIMER] Muxdeck");
    expect(storedTimer().timer.phase).toBe("alarm");
  });

  it("does not render in compact/mobile view", () => {
    vi.stubGlobal("matchMedia", desktopMediaQuery(false));
    render(
      <WorkspaceTimer
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceName="Launch room"
      />,
    );

    expect(screen.queryByRole("button", { name: "Show workspace timer" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Timer" })).not.toBeInTheDocument();
  });
});
