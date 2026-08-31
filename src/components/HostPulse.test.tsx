import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHostMetrics, type HostMetricsSnapshot } from "../api";
import {
  HOST_PULSE_STORAGE_PREFIX,
  HostPulse,
} from "./HostPulse";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, getHostMetrics: vi.fn() };
});

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

function snapshot(range: HostMetricsSnapshot["range"] = "15m"): HostMetricsSnapshot {
  const gib = 1024 ** 3;
  return {
    hostname: "mux-host",
    cpuCount: 8,
    sampleSeconds: 5,
    range,
    latest: {
      observedAt: Date.now() / 1_000 - 2,
      cpuPercent: 27,
      memoryUsedBytes: 22.4 * gib,
      memoryTotalBytes: 31.3 * gib,
      memoryAvailableBytes: 8.9 * gib,
      swapUsedBytes: 26 * gib,
      swapTotalBytes: 64 * gib,
      loadAverage: [1.71, 2.37, 2.52],
    },
    history: [
      { observedAt: 1, cpuPercent: 18, memoryUsedBytes: 21.8 * gib },
      { observedAt: 2, cpuPercent: 35, memoryUsedBytes: 22.1 * gib },
      { observedAt: 3, cpuPercent: 27, memoryUsedBytes: 22.4 * gib },
    ],
  };
}

function renderPulse(overrides: {
  sessionName?: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
} = {}) {
  return render(
    <HostPulse
      sessionName={overrides.sessionName ?? "agent-one"}
      workspaceId={overrides.workspaceId === undefined ? "workspace-one" : overrides.workspaceId}
      workspaceName={overrides.workspaceName === undefined ? "Launch room" : overrides.workspaceName}
    />,
  );
}

function storedPulse(workspaceId = "workspace-one") {
  return JSON.parse(window.localStorage.getItem(
    `${HOST_PULSE_STORAGE_PREFIX}workspace:${workspaceId}`,
  ) || "null");
}

beforeEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal("matchMedia", desktopMediaQuery());
  window.localStorage.clear();
  document.documentElement.classList.remove("host-pulse-moving", "host-pulse-resizing");
  vi.mocked(getHostMetrics).mockImplementation(async (range) => snapshot(range));
});

describe("HostPulse", () => {
  it("shows compact live metrics and opens the detailed floating panel", async () => {
    renderPulse();

    const card = screen.getByRole("button", { name: "Show host metrics" });
    await waitFor(() => expect(card).toHaveTextContent("27%"));
    expect(card).toHaveTextContent("72%");
    expect(getHostMetrics).toHaveBeenCalledWith("15m", expect.any(AbortSignal));

    fireEvent.click(card);
    const panel = screen.getByRole("dialog", { name: "Host Pulse" });
    expect(within(panel).getByText("mux-host")).toBeInTheDocument();
    expect(within(panel).getByText("Nominal")).toBeInTheDocument();
    expect(within(panel).getByText("1.71 / 2.37 / 2.52")).toBeInTheDocument();
    expect(within(panel).getByText("22.4 GB")).toBeInTheDocument();
    expect(within(panel).getByText("8.9 GB")).toBeInTheDocument();
    expect(within(panel).getByText("26.0 GB / 64.0 GB")).toBeInTheDocument();
  });

  it("changes history range and pauses only browser updates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00Z"));
    renderPulse();
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Show host metrics" }));
    const panel = screen.getByRole("dialog", { name: "Host Pulse" });

    fireEvent.click(within(panel).getByRole("button", { name: "1 H" }));
    await act(async () => Promise.resolve());
    expect(getHostMetrics).toHaveBeenCalledWith("1h", expect.any(AbortSignal));

    fireEvent.click(within(panel).getByRole("button", {
      name: "Pause Host Pulse live updates",
    }));
    await act(async () => Promise.resolve());
    const pausedCalls = vi.mocked(getHostMetrics).mock.calls.length;
    act(() => vi.advanceTimersByTime(15_000));
    expect(vi.mocked(getHostMetrics).mock.calls).toHaveLength(pausedCalls);
    expect(within(panel).getByRole("button", {
      name: "Resume Host Pulse live updates",
    })).toBeInTheDocument();
    expect(storedPulse().panel).toMatchObject({ range: "1h", paused: true });
  });

  it("persists pinned movement and size per workspace", async () => {
    const first = renderPulse();
    await waitFor(() => expect(screen.getByRole("button", { name: "Show host metrics" }))
      .toHaveTextContent("27%"));
    fireEvent.click(screen.getByRole("button", { name: "Show host metrics" }));
    let panel = screen.getByRole("dialog", { name: "Host Pulse" });
    const initialLeft = Number.parseInt(panel.style.left, 10);
    const initialWidth = Number.parseInt(panel.style.width, 10);

    fireEvent.click(within(panel).getByRole("button", { name: "Pin Host Pulse" }));
    fireEvent.keyDown(within(panel).getByLabelText("Move Host Pulse window"), {
      key: "ArrowLeft",
    });
    fireEvent.keyDown(within(panel).getByRole("button", {
      name: "Resize Host Pulse window",
    }), { key: "ArrowLeft" });
    expect(panel).toHaveStyle({
      left: `${initialLeft - 12}px`,
      width: `${initialWidth - 12}px`,
    });

    first.rerender(
      <HostPulse
        sessionName="agent-two"
        workspaceId="workspace-one"
        workspaceName="Launch room"
      />,
    );
    expect(screen.getByRole("dialog", { name: "Host Pulse" }))
      .toHaveAttribute("data-pinned", "true");
    first.unmount();

    renderPulse();
    panel = screen.getByRole("dialog", { name: "Host Pulse" });
    expect(panel).toHaveStyle({
      left: `${initialLeft - 12}px`,
      width: `${initialWidth - 12}px`,
    });
    expect(storedPulse().panel).toMatchObject({
      open: true,
      pinned: true,
      position: { x: initialLeft - 12 },
      size: { width: initialWidth - 12 },
    });
  });

  it("closes an unpinned panel on session switch and isolates workspaces", async () => {
    const view = renderPulse();
    await waitFor(() => expect(getHostMetrics).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Show host metrics" }));
    expect(screen.getByRole("dialog", { name: "Host Pulse" })).toBeInTheDocument();

    view.rerender(
      <HostPulse
        sessionName="agent-two"
        workspaceId="workspace-one"
        workspaceName="Launch room"
      />,
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Host Pulse" }))
      .not.toBeInTheDocument());

    view.rerender(
      <HostPulse
        sessionName="agent-two"
        workspaceId="workspace-two"
        workspaceName="Other room"
      />,
    );
    expect(screen.queryByRole("dialog", { name: "Host Pulse" })).not.toBeInTheDocument();
    await waitFor(() => expect(storedPulse("workspace-two").panel.open).toBe(false));
  });

  it("does not render or request metrics in compact mobile view", () => {
    vi.stubGlobal("matchMedia", desktopMediaQuery(false));
    renderPulse();

    expect(screen.queryByRole("button", { name: "Show host metrics" }))
      .not.toBeInTheDocument();
    expect(getHostMetrics).not.toHaveBeenCalled();
  });
});
