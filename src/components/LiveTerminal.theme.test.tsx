import { act, render } from "@testing-library/react";
import { createRef, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from "../terminalTheme";
import { LiveTerminal, type LiveTerminalHandle } from "./LiveTerminal";

interface MockTerminalInstance {
  options: Record<string, unknown>;
  cols: number;
  rows: number;
  refresh: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

const terminalMocks = vi.hoisted(() => ({
  instances: [] as MockTerminalInstance[],
  fit: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    buffer = { active: { viewportY: 0, baseY: 0 } };

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      terminalMocks.instances.push(this);
    }

    loadAddon() {}
    open() {}
    write = vi.fn();
    writeln() {}
    paste() {}
    focus() {}
    scrollToBottom() {}
    refresh = vi.fn();
    dispose = vi.fn();
    onData() { return { dispose: vi.fn() }; }
    onScroll() { return { dispose: vi.fn() }; }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = terminalMocks.fit;
  },
}));

type SocketListener = (event: Event) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly send = vi.fn();
  readonly close = vi.fn();
  readyState = MockWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  private readonly listeners = new Map<string, SocketListener[]>();

  constructor(readonly url: string) {
    socketMocks.instances.push(this);
  }

  addEventListener(type: string, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string) {
    if (type === "open") this.readyState = MockWebSocket.OPEN;
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }

  emitMessage(data: unknown) {
    const event = { data } as MessageEvent;
    for (const listener of this.listeners.get("message") ?? []) listener(event);
  }
}

const socketMocks = {
  instances: [] as MockWebSocket[],
};

class MockResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObserverMocks.instances.push(this);
  }

  observe = vi.fn();
  disconnect = vi.fn();

  emit() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const resizeObserverMocks = {
  instances: [] as MockResizeObserver[],
};

const callbacks = {
  onStateChange: vi.fn(),
  onPaneChange: vi.fn(),
};

function LayoutPhaseProbe({
  active,
  onLayout,
}: {
  active: boolean;
  onLayout: () => void;
}) {
  useLayoutEffect(() => {
    if (active) onLayout();
  }, [active, onLayout]);
  return null;
}

beforeEach(() => {
  terminalMocks.instances.length = 0;
  terminalMocks.fit.mockClear();
  socketMocks.instances.length = 0;
  resizeObserverMocks.instances.length = 0;
  callbacks.onStateChange.mockClear();
  callbacks.onPaneChange.mockClear();
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LiveTerminal themes", () => {
  it("refits and repaints an expanded layout without recreating the terminal or socket", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <LiveTerminal
        session="agent"
        ignoreSize={false}
        theme="dark"
        {...callbacks}
      />,
    );
    const terminal = terminalMocks.instances[0];
    const socket = socketMocks.instances[0];
    const resizeObserver = resizeObserverMocks.instances[0];
    socket.emit("open");
    terminalMocks.fit.mockClear();
    terminal.refresh.mockClear();
    socket.send.mockClear();
    terminalMocks.fit.mockImplementationOnce(() => {
      terminal.cols = 100;
      terminal.rows = 40;
    });

    act(() => {
      resizeObserver.emit();
      vi.advanceTimersByTime(80);
    });

    expect(terminalMocks.fit).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledWith(0, 39);
    expect(terminalMocks.fit.mock.invocationCallOrder[0])
      .toBeLessThan(terminal.refresh.mock.invocationCallOrder[0]);
    expect(socket.send).toHaveBeenCalledOnce();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: "resize",
      cols: 100,
      rows: 40,
    }));
    expect(terminalMocks.instances).toEqual([terminal]);
    expect(socketMocks.instances).toEqual([socket]);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();

    terminalMocks.fit.mockClear();
    terminal.refresh.mockClear();
    socket.send.mockClear();
    act(() => {
      resizeObserver.emit();
      vi.advanceTimersByTime(80);
    });

    expect(terminalMocks.fit).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledWith(0, 39);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("suspends layout fitting without recreating the terminal or socket and fits on resume", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const visualViewport = new EventTarget();
    vi.stubGlobal("visualViewport", visualViewport);
    let resizeObserver: MockResizeObserver | undefined;
    const runSuspendedLayoutPhase = vi.fn(() => {
      resizeObserver?.emit();
      vi.advanceTimersByTime(80);
    });
    const terminalView = (layoutSuspended: boolean) => (
      <>
        <LiveTerminal
          session="agent"
          ignoreSize={false}
          layoutSuspended={layoutSuspended}
          theme="dark"
          {...callbacks}
        />
        <LayoutPhaseProbe
          active={layoutSuspended}
          onLayout={runSuspendedLayoutPhase}
        />
      </>
    );
    const view = render(terminalView(false));
    const terminal = terminalMocks.instances[0];
    const socket = socketMocks.instances[0];
    resizeObserver = resizeObserverMocks.instances[0];
    socket.emit("open");
    terminalMocks.fit.mockClear();
    socket.send.mockClear();

    resizeObserver.emit();
    view.rerender(terminalView(true));
    terminal.cols = 100;
    visualViewport.dispatchEvent(new Event("resize"));
    visualViewport.dispatchEvent(new Event("scroll"));
    act(() => vi.advanceTimersByTime(80));

    expect(runSuspendedLayoutPhase).toHaveBeenCalledOnce();
    expect(terminalMocks.instances).toEqual([terminal]);
    expect(socketMocks.instances).toEqual([socket]);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    expect(terminalMocks.fit).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();

    view.rerender(terminalView(false));
    expect(terminalMocks.instances).toEqual([terminal]);
    expect(socketMocks.instances).toEqual([socket]);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    expect(terminalMocks.fit).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(80));

    expect(terminalMocks.fit).toHaveBeenCalledOnce();
    expect(socket.send).toHaveBeenCalledOnce();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: "resize",
      cols: 100,
      rows: 24,
    }));
  });

  it("sends typed terminal-history controls only while the socket is live", () => {
    const ref = createRef<LiveTerminalHandle>();
    render(
      <LiveTerminal
        ref={ref}
        session="agent"
        ignoreSize={false}
        theme="dark"
        {...callbacks}
      />,
    );
    const socket = socketMocks.instances[0];
    expect(ref.current?.navigateHistory("page-up")).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
    socket.emit("open");
    socket.send.mockClear();

    const accepted: boolean[] = [];
    act(() => {
      accepted.push(ref.current?.navigateHistory("page-up") ?? false);
      accepted.push(ref.current?.navigateHistory("page-down") ?? false);
      accepted.push(ref.current?.navigateHistory("exit") ?? false);
    });

    expect(accepted).toEqual([true, true, true]);
    expect(socket.send.mock.calls).toEqual([
      [JSON.stringify({ type: "history", action: "page-up" })],
      [JSON.stringify({ type: "history", action: "page-down" })],
      [JSON.stringify({ type: "history", action: "exit" })],
    ]);
  });

  it("constructs xterm with the requested initial palette", () => {
    render(
      <LiveTerminal
        session="agent"
        ignoreSize={false}
        theme="light"
        {...callbacks}
      />,
    );

    expect(terminalMocks.instances).toHaveLength(1);
    expect(terminalMocks.instances[0].options.theme).toBe(LIGHT_TERMINAL_THEME);
  });

  it("switches the palette in place without reconnecting, fitting, or sending", () => {
    const view = render(
      <LiveTerminal
        session="agent"
        ignoreSize={false}
        theme="dark"
        {...callbacks}
      />,
    );
    const terminal = terminalMocks.instances[0];
    const socket = socketMocks.instances[0];

    expect(terminal.options.theme).toBe(DARK_TERMINAL_THEME);
    expect(terminalMocks.instances).toHaveLength(1);
    expect(socketMocks.instances).toHaveLength(1);
    expect(terminalMocks.fit).toHaveBeenCalledTimes(1);

    socket.emit("open");
    expect(socket.send).toHaveBeenCalledTimes(1);

    view.rerender(
      <LiveTerminal
        session="agent"
        ignoreSize={false}
        theme="light"
        {...callbacks}
      />,
    );

    expect(terminal.options.theme).toBe(LIGHT_TERMINAL_THEME);
    expect(terminalMocks.instances).toHaveLength(1);
    expect(socketMocks.instances).toHaveLength(1);
    expect(terminalMocks.fit).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it("ignores queued events from the disposed socket after switching sessions", async () => {
    const view = render(
      <LiveTerminal
        session="alpha"
        ignoreSize={false}
        theme="dark"
        {...callbacks}
      />,
    );
    const oldTerminal = terminalMocks.instances[0];
    const oldSocket = socketMocks.instances[0];
    let resolveLateBlob: ((data: ArrayBuffer) => void) | undefined;
    const lateBlob = new Blob();
    Object.defineProperty(lateBlob, "arrayBuffer", {
      configurable: true,
      value: vi.fn(() => new Promise<ArrayBuffer>((resolve) => {
        resolveLateBlob = resolve;
      })),
    });
    oldSocket.emitMessage(lateBlob);

    view.rerender(
      <LiveTerminal
        session="beta"
        ignoreSize={false}
        theme="dark"
        {...callbacks}
      />,
    );

    const activeSocket = socketMocks.instances[1];
    activeSocket.emit("open");
    const stateCallCount = callbacks.onStateChange.mock.calls.length;

    oldSocket.emit("open");
    oldSocket.emitMessage(JSON.stringify({ type: "ready", paneId: "%old" }));
    oldSocket.emitMessage(new ArrayBuffer(2));
    resolveLateBlob?.(new ArrayBuffer(2));
    await Promise.resolve();

    expect(oldTerminal.dispose).toHaveBeenCalledOnce();
    expect(oldTerminal.write).not.toHaveBeenCalled();
    expect(callbacks.onPaneChange).not.toHaveBeenCalled();
    expect(callbacks.onStateChange).toHaveBeenCalledTimes(stateCallCount);
    expect(activeSocket.send).toHaveBeenCalledTimes(1);
  });
});
