import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openUtilityTerminal, terminateSession } from "../api";
import { FloatingTerminal, FLOATING_TERMINAL_STORAGE_PREFIX, type FloatingTerminalHandle } from "./FloatingTerminal";

vi.mock("../api", () => ({ openUtilityTerminal: vi.fn(), terminateSession: vi.fn() }));
vi.mock("./LiveTerminal", () => ({ LiveTerminal: ({ session, identity, elementId }: { session: string; identity: string; elementId: string }) => <div id={elementId} data-identity={identity}>{session}</div> }));
const shell = { name: "utility-one", id: "$8", created: 100, serverStarted: 50, serverPid: 10, activePaneId: null, panes: [] };
const props = { workspaceKey: "workspace:one", workspaceName: "One", sessionName: "agent", sessionId: "$1", enabled: true, theme: "dark" as const, onOpenChange: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(openUtilityTerminal).mockResolvedValue({ terminal: shell });
});

describe("FloatingTerminal", () => {
  it("restores a session-specific panel without offering a cross-session pin", async () => {
    const key = "session:$1:100:50:10";
    localStorage.setItem(`${FLOATING_TERMINAL_STORAGE_PREFIX}${key}`, JSON.stringify({ open: true, pinned: false, x: 20, y: 30, width: 480, height: 300 }));
    const view = render(<FloatingTerminal {...props} workspaceKey={key} />);
    await screen.findByText("utility-one", { selector: "#muxdeck-session-utility-console" });
    expect(openUtilityTerminal).toHaveBeenCalledWith(key, "agent", "$1", false, expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: "Pin utility terminal" })).not.toBeInTheDocument();
    view.rerender(<FloatingTerminal {...props} workspaceKey={key} sessionName="renamed-agent" />);
    expect(screen.getByRole("dialog", { name: "Session terminal" })).toBeInTheDocument();
    expect(openUtilityTerminal).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Hide utility terminal" }));
    expect(JSON.parse(localStorage.getItem(`${FLOATING_TERMINAL_STORAGE_PREFIX}${key}`) || "null").open).toBe(false);
    expect(terminateSession).not.toHaveBeenCalled();
  });

  it("creates only on demand and hiding does not terminate the shell", async () => {
    const ref = createRef<FloatingTerminalHandle>();
    render(<FloatingTerminal {...props} ref={ref} />);
    expect(openUtilityTerminal).not.toHaveBeenCalled();
    act(() => ref.current?.toggle());
    await screen.findByText("utility-one", { selector: "#muxdeck-utility-console" });
    expect(openUtilityTerminal).toHaveBeenCalledWith("workspace:one", "agent", "$1", true, expect.any(AbortSignal));
    expect(document.getElementById("muxdeck-utility-console")).toHaveAttribute("data-identity", "$8:100:50:10");
    fireEvent.click(screen.getByRole("button", { name: "Hide utility terminal" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(terminateSession).not.toHaveBeenCalled();
  });

  it("keeps a pinned shell across tabs without reconnecting, closes when unpinned", async () => {
    const ref = createRef<FloatingTerminalHandle>();
    const view = render(<FloatingTerminal {...props} ref={ref} />);
    act(() => ref.current?.toggle());
    await screen.findByText("utility-one", { selector: "#muxdeck-utility-console" });
    fireEvent.click(screen.getByRole("button", { name: "Pin utility terminal" }));
    view.rerender(<FloatingTerminal {...props} sessionName="second" sessionId="$2" ref={ref} />);
    expect(screen.getByRole("dialog", { name: "Utility terminal" })).toHaveAttribute("data-pinned", "true");
    expect(openUtilityTerminal).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Unpin utility terminal" }));
    view.rerender(<FloatingTerminal {...props} ref={ref} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("restores layout and checks for an existing shell without silently creating one", async () => {
    localStorage.setItem(`${FLOATING_TERMINAL_STORAGE_PREFIX}workspace:one`, JSON.stringify({ open: true, pinned: true, x: 20, y: 30, width: 480, height: 300 }));
    vi.mocked(openUtilityTerminal).mockResolvedValue({ terminal: null });
    render(<FloatingTerminal {...props} />);
    await screen.findByRole("button", { name: "Start shell" });
    expect(openUtilityTerminal).toHaveBeenCalledWith("workspace:one", "agent", "$1", false, expect.any(AbortSignal));
    const panel = screen.getByRole("dialog", { name: "Utility terminal" });
    expect(panel).toHaveStyle({ left: "20px", width: "480px" });
    const strip = screen.getByLabelText("Move utility terminal");
    fireEvent.keyDown(strip, { key: "ArrowLeft", shiftKey: true });
    expect(panel).toHaveStyle({ width: "464px" });
    fireEvent.keyDown(strip, { key: "ArrowRight" });
    expect(panel).toHaveStyle({ left: "36px" });
    expect(JSON.parse(localStorage.getItem(`${FLOATING_TERMINAL_STORAGE_PREFIX}workspace:one`) || "null").width).toBe(464);
  });

  it("does not open or connect on mobile", () => {
    const ref = createRef<FloatingTerminalHandle>();
    render(<FloatingTerminal {...props} enabled={false} ref={ref} />);
    act(() => ref.current?.toggle());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(openUtilityTerminal).not.toHaveBeenCalled();
  });

  it("ignores a late response after closing", async () => {
    let resolve!: (value: { terminal: typeof shell }) => void;
    vi.mocked(openUtilityTerminal).mockReturnValue(new Promise((done) => { resolve = done; }));
    const ref = createRef<FloatingTerminalHandle>();
    render(<FloatingTerminal {...props} ref={ref} />);
    act(() => ref.current?.toggle());
    fireEvent.click(screen.getByRole("button", { name: "Hide utility terminal" }));
    await act(async () => resolve({ terminal: shell }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("requires confirmation before ending only the utility shell", async () => {
    const ref = createRef<FloatingTerminalHandle>();
    render(<FloatingTerminal {...props} ref={ref} />);
    act(() => ref.current?.toggle());
    await screen.findByText("utility-one", { selector: "#muxdeck-utility-console" });
    fireEvent.click(screen.getByRole("button", { name: "End shell" }));
    expect(terminateSession).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog", { name: "Terminate tmux session?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Terminate session" }));
    await waitFor(() => expect(terminateSession).toHaveBeenCalledWith("utility-one", "$8", 100, 50, 10));
  });
});
