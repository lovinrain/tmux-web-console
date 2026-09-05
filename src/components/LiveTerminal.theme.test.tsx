import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from "../terminalTheme";
import { LiveTerminal, type LiveTerminalHandle } from "./LiveTerminal";

interface MockTerminalInstance {
  options: Record<string, unknown>;
  buffer: {
    active: {
      viewportY: number;
      baseY: number;
      getLine: (index: number) => unknown;
      getNullCell: () => unknown;
    };
  };
  cols: number;
  rows: number;
  element?: HTMLElement;
  keyHandler?: (event: KeyboardEvent) => boolean;
  emitData: (data: string) => void;
  clearSelection: ReturnType<typeof vi.fn>;
  clearTextureAtlas: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  scrollLines: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

interface MockWebLinksAddonInstance {
  handler: (event: MouseEvent, uri: string) => void;
  options: {
    hover?: (event: MouseEvent, uri: string) => void;
    leave?: (event: MouseEvent, uri: string) => void;
  };
}

interface MockLinkProvider {
  provideLinks: (
    bufferLineNumber: number,
    callback: (links: MockProvidedLink[] | undefined) => void,
  ) => void;
}

interface MockProvidedLink {
  text: string;
  activate: (event: MouseEvent, text: string) => void;
  hover?: (event: MouseEvent, text: string) => void;
  leave?: (event: MouseEvent, text: string) => void;
}

const terminalMocks = vi.hoisted(() => ({
  instances: [] as MockTerminalInstance[],
  fit: vi.fn(),
}));

const webLinkMocks = vi.hoisted(() => ({
  instances: [] as MockWebLinksAddonInstance[],
}));

const fileLinkMocks = vi.hoisted(() => ({
  instances: [] as MockLinkProvider[],
  dispose: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        getLine: () => undefined,
        getNullCell: () => ({ getChars: () => "", getWidth: () => 1 }),
      },
    };
    element: HTMLElement | undefined;
    keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
    private dataHandler: ((data: string) => void) | undefined;

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      terminalMocks.instances.push(this);
    }

    loadAddon() {}
    registerLinkProvider(provider: MockLinkProvider) {
      fileLinkMocks.instances.push(provider);
      return { dispose: fileLinkMocks.dispose };
    }
    open(parent: HTMLElement) {
      this.element = document.createElement("div");
      this.element.className = "xterm";
      const screen = document.createElement("div");
      screen.className = "xterm-screen";
      this.element.append(screen);
      parent.append(this.element);
    }
    write = vi.fn();
    writeln() {}
    paste() {}
    focus() {}
    scrollToBottom() {}
    scrollLines = vi.fn();
    clearSelection = vi.fn();
    clearTextureAtlas = vi.fn();
    refresh = vi.fn();
    dispose = vi.fn();
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      this.keyHandler = handler;
    });
    emitData(data: string) { this.dataHandler?.(data); }
    onData(handler: (data: string) => void) {
      this.dataHandler = handler;
      return { dispose: vi.fn() };
    }
    onScroll() { return { dispose: vi.fn() }; }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = terminalMocks.fit;
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class MockWebLinksAddon {
    constructor(
      readonly handler: (event: MouseEvent, uri: string) => void,
      readonly options: MockWebLinksAddonInstance["options"],
    ) {
      webLinkMocks.instances.push(this);
    }
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

function setTerminalBufferLine(terminal: MockTerminalInstance, content: string) {
  const cell = {
    chars: "",
    width: 1,
    getChars() { return this.chars; },
    getWidth() { return this.width; },
  };
  terminal.buffer.active.getNullCell = () => cell;
  terminal.buffer.active.getLine = (index: number) => (index === 0 ? {
    isWrapped: false,
    length: 80,
    translateToString: () => content,
    getCell: (column: number, target: typeof cell) => {
      target.chars = content[column] || "";
      target.width = 1;
      return target;
    },
  } : undefined);
}

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
  webLinkMocks.instances.length = 0;
  fileLinkMocks.instances.length = 0;
  fileLinkMocks.dispose.mockClear();
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
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LiveTerminal browser copy mode", () => {
  it("forces xterm selection while blocking mouse frames and preserves the terminal instance", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const terminalView = (browserCopyMode: boolean) => (
      <LiveTerminal
        session="agent"
        ignoreSize={false}
        browserCopyMode={browserCopyMode}
        theme="dark"
        {...callbacks}
      />
    );
    const view = render(terminalView(false));
    const terminal = terminalMocks.instances[0];
    const socket = socketMocks.instances[0];
    const terminalElement = terminal.element!;
    const terminalScreen = terminalElement.querySelector<HTMLElement>(".xterm-screen")!;
    socket.emit("open");
    socket.send.mockClear();

    const selectionMouseDowns: MouseEvent[] = [];
    const selectionMouseMoves: MouseEvent[] = [];
    terminalElement.addEventListener("mousedown", (event) => {
      selectionMouseDowns.push(event);
      terminal.emitData("\x1b[mouse-down");
      document.addEventListener("mousemove", (moveEvent) => {
        selectionMouseMoves.push(moveEvent);
        terminal.emitData("\x1b[mouse-drag");
      }, { once: true });
    });

    view.rerender(terminalView(true));
    expect(view.container.querySelector(".terminal-stage"))
      .toHaveAttribute("data-copy-mode", "true");
    terminalScreen.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: 40,
      clientY: 20,
      detail: 1,
    }));

    expect(selectionMouseDowns).toHaveLength(1);
    expect(selectionMouseDowns[0].shiftKey).toBe(true);
    expect(selectionMouseDowns[0].altKey).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();

    terminalScreen.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      buttons: 1,
      clientX: 90,
      clientY: 40,
    }));
    expect(selectionMouseMoves).toHaveLength(1);
    expect(selectionMouseMoves[0].target).toBe(document);
    expect(selectionMouseMoves[0].shiftKey).toBe(true);
    expect(socket.send).not.toHaveBeenCalled();

    document.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 0,
      clientX: 90,
      clientY: 40,
    }));
    terminalScreen.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: 3,
    }));
    expect(terminal.scrollLines).toHaveBeenCalledWith(3);
    expect(socket.send).not.toHaveBeenCalled();

    expect(terminal.keyHandler?.(new KeyboardEvent("keydown", {
      key: "c",
      ctrlKey: true,
    }))).toBe(false);
    expect(terminal.keyHandler?.(new KeyboardEvent("keydown", {
      key: "v",
      ctrlKey: true,
    }))).toBe(false);
    expect(terminal.keyHandler?.(new KeyboardEvent("keydown", {
      key: "x",
      ctrlKey: true,
    }))).toBe(true);

    view.rerender(terminalView(false));
    expect(terminal.clearSelection).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".terminal-stage"))
      .toHaveAttribute("data-copy-mode", "false");
    expect(terminalMocks.instances).toEqual([terminal]);
    expect(socketMocks.instances).toEqual([socket]);

    socket.send.mockClear();
    terminalScreen.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      detail: 1,
    }));
    expect(selectionMouseDowns).toHaveLength(2);
    expect(selectionMouseDowns[1].shiftKey).toBe(false);
    expect(socket.send).toHaveBeenCalledOnce();
    document.dispatchEvent(new MouseEvent("mousemove"));
  });

  it("uses xterm's forced Option selection path on macOS", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    render(
      <LiveTerminal
        session="agent"
        ignoreSize={false}
        browserCopyMode
        theme="dark"
        {...callbacks}
      />,
    );
    const terminal = terminalMocks.instances[0];
    const terminalElement = terminal.element!;
    const terminalScreen = terminalElement.querySelector<HTMLElement>(".xterm-screen")!;
    let forcedMouseDown: MouseEvent | undefined;
    let macSelectionDuringDispatch: unknown;
    terminalElement.addEventListener("mousedown", (event) => {
      forcedMouseDown = event;
      macSelectionDuringDispatch = terminal.options.macOptionClickForcesSelection;
    });

    terminalScreen.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      detail: 1,
    }));

    expect(forcedMouseDown?.altKey).toBe(true);
    expect(forcedMouseDown?.shiftKey).toBe(false);
    expect(macSelectionDuringDispatch).toBe(true);
    expect(terminal.options.macOptionClickForcesSelection).toBeUndefined();
    expect(terminal.keyHandler?.(new KeyboardEvent("keydown", {
      key: "c",
      metaKey: true,
    }))).toBe(false);
    expect(terminal.keyHandler?.(new KeyboardEvent("keydown", {
      key: "c",
      ctrlKey: true,
    }))).toBe(true);
  });
});

describe("LiveTerminal web links", () => {
  it("opens HTTP links only with Ctrl-click and exposes the full target on hover", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(
      <LiveTerminal
        session="agent"
        ignoreSize={false}
        theme="dark"
        {...callbacks}
      />,
    );
    const terminal = terminalMocks.instances[0];
    const links = webLinkMocks.instances[0];
    const uri = "https://example.test/review?id=42";
    const plainClick = new MouseEvent("mouseup", { button: 0 });
    const metaClick = new MouseEvent("mouseup", { button: 0, metaKey: true });
    const ctrlClick = new MouseEvent("mouseup", { button: 0, ctrlKey: true });

    links.options.hover?.(new MouseEvent("mousemove"), uri);
    expect(terminal.element).toHaveAttribute("title", `Ctrl+click to open ${uri}`);

    links.handler(plainClick, uri);
    links.handler(metaClick, uri);
    links.handler(ctrlClick, "javascript:alert(1)");
    expect(open).not.toHaveBeenCalled();

    links.handler(ctrlClick, uri);
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(uri, "_blank", "noopener,noreferrer");

    const oscLinkHandler = terminal.options.linkHandler as {
      activate: (event: MouseEvent, uri: string) => void;
    };
    oscLinkHandler.activate(ctrlClick, "https://osc.example.test/path");
    expect(open).toHaveBeenLastCalledWith(
      "https://osc.example.test/path",
      "_blank",
      "noopener,noreferrer",
    );

    links.options.leave?.(new MouseEvent("mouseleave"), uri);
    expect(terminal.element).not.toHaveAttribute("title");
  });

  it("uses Cmd-click on macOS", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(
      <LiveTerminal
        session="agent"
        ignoreSize={false}
        theme="dark"
        {...callbacks}
      />,
    );
    const terminal = terminalMocks.instances[0];
    const links = webLinkMocks.instances[0];
    const uri = "https://example.test/mac";

    links.options.hover?.(new MouseEvent("mousemove"), uri);
    expect(terminal.element).toHaveAttribute("title", `Cmd+click to open ${uri}`);
    links.handler(new MouseEvent("mouseup", { button: 0, ctrlKey: true }), uri);
    expect(open).not.toHaveBeenCalled();
    links.handler(new MouseEvent("mouseup", { button: 0, metaKey: true }), uri);
    expect(open).toHaveBeenCalledWith(uri, "_blank", "noopener,noreferrer");
  });

  it("previews detected file paths only with Ctrl-click and blocks terminal mouse input", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const onOpenFilePath = vi.fn();
    render(
      <LiveTerminal
        session="agent"
        ignoreSize={false}
        theme="dark"
        onOpenFilePath={onOpenFilePath}
        {...callbacks}
      />,
    );
    const terminal = terminalMocks.instances[0];
    const socket = socketMocks.instances[0];
    const terminalElement = terminal.element!;
    const terminalScreen = terminalElement.querySelector<HTMLElement>(".xterm-screen")!;
    setTerminalBufferLine(terminal, "result: docs/report.md");
    let links: MockProvidedLink[] | undefined;
    fileLinkMocks.instances[0].provideLinks(1, (provided) => { links = provided; });
    const link = links?.[0];
    expect(link?.text).toBe("docs/report.md");

    link?.hover?.(new MouseEvent("mousemove"), link.text);
    expect(terminalElement).toHaveAttribute(
      "title",
      "Ctrl+click to preview docs/report.md",
    );
    link?.activate(new MouseEvent("mouseup", { button: 0 }), link.text);
    link?.activate(new MouseEvent("mouseup", { button: 0, metaKey: true }), link.text);
    expect(onOpenFilePath).not.toHaveBeenCalled();
    link?.activate(new MouseEvent("mouseup", { button: 0, ctrlKey: true }), link.text);
    expect(onOpenFilePath).toHaveBeenCalledOnce();

    socket.emit("open");
    socket.send.mockClear();
    onOpenFilePath.mockClear();
    terminalElement.addEventListener("mousedown", () => terminal.emitData("mouse-down"));
    terminalElement.addEventListener("mouseup", () => terminal.emitData("mouse-up"));
    terminalScreen.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      ctrlKey: true,
    }));
    terminalScreen.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    }));
    expect(onOpenFilePath).toHaveBeenCalledWith("docs/report.md");
    expect(socket.send).not.toHaveBeenCalled();

    link?.leave?.(new MouseEvent("mouseleave"), link.text);
    expect(terminalElement).not.toHaveAttribute("title");
  });

  it("does not send modified link clicks into the terminal application", async () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
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
    const links = webLinkMocks.instances[0];
    const terminalElement = terminal.element!;
    const terminalScreen = terminalElement.querySelector<HTMLElement>(".xterm-screen")!;
    socket.emit("open");
    socket.send.mockClear();
    links.options.hover?.(new MouseEvent("mousemove"), "https://example.test/safe");
    terminalElement.addEventListener("mousedown", () => terminal.emitData("mouse-down"));
    terminalElement.addEventListener("mouseup", () => terminal.emitData("mouse-up"));

    terminalScreen.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      ctrlKey: true,
    }));
    terminalScreen.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    }));
    expect(socket.send).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      "https://example.test/safe",
      "_blank",
      "noopener,noreferrer",
    );

    await act(async () => Promise.resolve());
    terminalScreen.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      buttons: 1,
    }));
    expect(socket.send).toHaveBeenCalledOnce();
  });
});

describe("LiveTerminal themes", () => {
  it("redraws the renderer without fitting, reconnecting, or sending terminal data", () => {
    const ref = createRef<LiveTerminalHandle>();
    const view = render(
      <LiveTerminal
        ref={ref}
        session="agent"
        ignoreSize={false}
        theme="dark"
        {...callbacks}
      />,
    );
    const terminal = terminalMocks.instances[0];
    const socket = socketMocks.instances[0];
    terminalMocks.fit.mockClear();
    socket.send.mockClear();

    let redrawn = false;
    act(() => {
      redrawn = ref.current?.redraw() ?? false;
    });

    expect(redrawn).toBe(true);
    expect(terminal.clearTextureAtlas).toHaveBeenCalledOnce();
    expect(terminalMocks.fit).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
    expect(terminalMocks.instances).toEqual([terminal]);
    expect(socketMocks.instances).toEqual([socket]);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();

    view.unmount();
    expect(terminal.dispose).toHaveBeenCalledOnce();
  });

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

  it("refits after a committed layout-mode change without recreating the terminal or socket", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const terminalView = (layoutRefreshToken: string) => (
      <LiveTerminal
        session="agent"
        ignoreSize={false}
        layoutRefreshToken={layoutRefreshToken}
        theme="dark"
        {...callbacks}
      />
    );
    const view = render(terminalView("standard"));
    const terminal = terminalMocks.instances[0];
    const socket = socketMocks.instances[0];
    socket.emit("open");
    terminalMocks.fit.mockClear();
    terminal.refresh.mockClear();
    socket.send.mockClear();
    terminalMocks.fit.mockImplementationOnce(() => {
      terminal.cols = 100;
      terminal.rows = 40;
    });

    view.rerender(terminalView("terminal-focus"));
    expect(terminalMocks.fit).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(80));

    expect(terminalMocks.fit).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledWith(0, 39);
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: "resize",
      cols: 100,
      rows: 40,
    }));
    expect(terminalMocks.instances).toEqual([terminal]);
    expect(socketMocks.instances).toEqual([socket]);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
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

describe("LiveTerminal desktop attachment drops", () => {
  function attachmentTransfer(file: File) {
    return {
      items: [{ kind: "file", type: file.type }],
      files: [file],
      dropEffect: "none",
    };
  }

  it("uploads a dropped file and pastes its path without Enter", async () => {
    const onUploadAttachment = vi.fn(async (_file: File, _signal: AbortSignal) => ({
      name: "context.json",
      path: "/uploads/context.json",
      terminalText: "/uploads/context.json",
      contentType: "application/json",
      size: 12,
    }));
    render(
      <LiveTerminal
        session="agent"
        ignoreSize={false}
        theme="dark"
        onUploadAttachment={onUploadAttachment}
        {...callbacks}
      />,
    );
    const socket = socketMocks.instances[0];
    socket.emit("open");
    socket.send.mockClear();
    const stage = screen.getByRole("tabpanel", { name: "agent live terminal" });
    const transfer = attachmentTransfer(new File(['{"ok":true}'], "context.json", {
      type: "application/json",
    }));

    expect(fireEvent.dragEnter(stage, { dataTransfer: transfer })).toBe(false);
    expect(screen.getByText("Drop files into terminal input")).toBeVisible();
    expect(fireEvent.dragOver(stage, { dataTransfer: transfer })).toBe(false);
    expect(transfer.dropEffect).toBe("copy");
    expect(fireEvent.drop(stage, { dataTransfer: transfer })).toBe(false);
    expect(stage).toHaveAttribute("aria-busy", "true");

    await waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    const frame = JSON.parse(String(socket.send.mock.calls[0][0])) as {
      type: string;
      id: string;
      data: string;
    };
    expect(frame).toMatchObject({
      type: "input",
      data: "/uploads/context.json ",
    });
    expect(frame.data).not.toContain("\r");
    expect(onUploadAttachment).toHaveBeenCalledOnce();
    expect(onUploadAttachment.mock.calls[0][1]).toBeInstanceOf(AbortSignal);

    act(() => socket.emitMessage(JSON.stringify({ type: "inputAck", id: frame.id })));
    expect(await screen.findByText("File path pasted")).toBeVisible();
    expect(screen.getByText("Inserted at the live terminal cursor without Enter."))
      .toBeVisible();
    expect(screen.getByRole("button", { name: "Copy uploaded file path" }))
      .toHaveAttribute("title", "/uploads/context.json");
    expect(stage).toHaveAttribute("aria-busy", "false");
  });

  it("surfaces a backend rejection for an empty file", async () => {
    const onUploadAttachment = vi.fn(async () => {
      throw new Error("attachment file cannot be empty");
    });
    render(
      <LiveTerminal
        session="agent"
        ignoreSize={false}
        theme="dark"
        onUploadAttachment={onUploadAttachment}
        {...callbacks}
      />,
    );
    socketMocks.instances[0].emit("open");
    const stage = screen.getByRole("tabpanel", { name: "agent live terminal" });
    const transfer = attachmentTransfer(new File([], "empty.txt", {
      type: "text/plain",
    }));

    fireEvent.dragEnter(stage, { dataTransfer: transfer });
    fireEvent.drop(stage, { dataTransfer: transfer });

    expect(await screen.findByRole("alert")).toHaveTextContent("File upload failed");
    expect(screen.getByRole("alert")).toHaveTextContent("attachment file cannot be empty");
    expect(onUploadAttachment).toHaveBeenCalledOnce();
  });

  it("leaves terminal file drops alone in the mobile layout", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const onUploadAttachment = vi.fn();
    render(
      <LiveTerminal
        session="agent"
        ignoreSize={false}
        theme="dark"
        onUploadAttachment={onUploadAttachment}
        {...callbacks}
      />,
    );
    socketMocks.instances[0].emit("open");
    const stage = screen.getByRole("tabpanel", { name: "agent live terminal" });
    const transfer = attachmentTransfer(new File(["notes"], "mobile.txt", {
      type: "text/plain",
    }));

    expect(fireEvent.dragEnter(stage, { dataTransfer: transfer })).toBe(true);
    expect(fireEvent.drop(stage, { dataTransfer: transfer })).toBe(true);
    expect(screen.queryByText("Drop files into terminal input")).not.toBeInTheDocument();
    expect(onUploadAttachment).not.toHaveBeenCalled();
  });

  it("aborts an in-flight upload instead of pasting it into a newly selected session", async () => {
    let finishUpload: ((value: {
      name: string;
      path: string;
      terminalText: string;
      contentType: "application/octet-stream";
      size: number;
    }) => void) | undefined;
    const onUploadAttachment = vi.fn((_file: File, _signal: AbortSignal) => new Promise<{
      name: string;
      path: string;
      terminalText: string;
      contentType: "application/octet-stream";
      size: number;
    }>((resolve) => {
      finishUpload = resolve;
    }));
    const terminalView = (session: string) => (
      <LiveTerminal
        session={session}
        ignoreSize={false}
        theme="dark"
        onUploadAttachment={onUploadAttachment}
        {...callbacks}
      />
    );
    const view = render(terminalView("alpha"));
    const oldSocket = socketMocks.instances[0];
    oldSocket.emit("open");
    oldSocket.send.mockClear();
    const transfer = attachmentTransfer(new File(["archive"], "late.tar", {
      type: "application/x-tar",
    }));
    fireEvent.drop(screen.getByRole("tabpanel", { name: "alpha live terminal" }), {
      dataTransfer: transfer,
    });
    await waitFor(() => expect(onUploadAttachment).toHaveBeenCalledOnce());
    const signal = onUploadAttachment.mock.calls[0][1];

    view.rerender(terminalView("beta"));
    expect(signal.aborted).toBe(true);
    finishUpload?.({
      name: "late.tar",
      path: "/uploads/late.tar",
      terminalText: "/uploads/late.tar",
      contentType: "application/octet-stream",
      size: 7,
    });
    await act(async () => Promise.resolve());

    expect(oldSocket.send).not.toHaveBeenCalled();
    expect(socketMocks.instances[1].send).not.toHaveBeenCalledWith(expect.stringContaining("late.tar"));
    expect(screen.queryByText("File path pasted")).not.toBeInTheDocument();
  });
});
