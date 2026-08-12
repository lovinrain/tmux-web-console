import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from "../terminalTheme";
import { LiveTerminal } from "./LiveTerminal";

interface MockTerminalInstance {
  options: Record<string, unknown>;
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
    write() {}
    writeln() {}
    paste() {}
    focus() {}
    scrollToBottom() {}
    dispose() {}
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
}

const socketMocks = {
  instances: [] as MockWebSocket[],
};

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

const callbacks = {
  onStateChange: vi.fn(),
  onPaneChange: vi.fn(),
};

beforeEach(() => {
  terminalMocks.instances.length = 0;
  terminalMocks.fit.mockClear();
  socketMocks.instances.length = 0;
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
  vi.unstubAllGlobals();
});

describe("LiveTerminal themes", () => {
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
});
