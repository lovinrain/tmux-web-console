import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSavedScrollback } from "../api";
import type { SavedScrollbackPage } from "../types";
import { SavedScrollback } from "./SavedScrollback";

vi.mock("../api", () => ({ loadSavedScrollback: vi.fn() }));

const opening: SavedScrollbackPage = {
  part: "beginning", lines: ["Opening line", "Next line"],
  panes: [{ id: "pane-a", paneId: "%1", firstCapturedAt: 100 }, { id: "pane-b", paneId: "%1", firstCapturedAt: 200 }],
  selectedPane: "pane-a", capturedAt: 110, firstCapturedAt: 100, sessionCreatedAt: 90,
  limited: false, lineLimit: 2000, byteLimit: 1048576,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadSavedScrollback).mockResolvedValue(opening);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("SavedScrollback", () => {
  it("selects a region and pane, copies the complete region, and scrolls without pagination", async () => {
    render(<SavedScrollback target={{ historyId: "history" }} />);
    const output = await screen.findByLabelText("Beginning output");
    expect(output).toHaveTextContent("Opening line");
    Object.defineProperty(output, "scrollHeight", { configurable: true, value: 800 });
    fireEvent.click(screen.getByRole("button", { name: "Bottom" }));
    expect(output.scrollTop).toBe(800);
    fireEvent.click(screen.getByRole("button", { name: "Top" }));
    expect(output.scrollTop).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Copy saved output" }));
    await screen.findByText("Copied");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Opening line\nNext line");

    vi.mocked(loadSavedScrollback).mockResolvedValue({ ...opening, part: "recent", lines: ["Latest result"], limited: true });
    fireEvent.change(screen.getByLabelText("Output"), { target: { value: "recent" } });
    await screen.findByText("Latest result");
    expect(loadSavedScrollback).toHaveBeenLastCalledWith({ historyId: "history" }, "recent", null, expect.any(AbortSignal));
    expect(screen.getByText(/reached its saved output limit/)).toBeVisible();
    vi.mocked(loadSavedScrollback).mockResolvedValue({ ...opening, part: "recent", selectedPane: "pane-b", lines: ["Replacement pane"] });
    fireEvent.change(screen.getByLabelText("Saved pane"), { target: { value: "pane-b" } });
    await screen.findByText("Replacement pane");
    expect(loadSavedScrollback).toHaveBeenLastCalledWith({ historyId: "history" }, "recent", "pane-b", expect.any(AbortSignal));
  });

  it("aborts stale requests and resets selection on a session identity change", async () => {
    let finish: (page: SavedScrollbackPage) => void = () => undefined;
    vi.mocked(loadSavedScrollback).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(<SavedScrollback target={{ paneId: "%1", identity: "old" }} part="beginning" />);
    const signal = vi.mocked(loadSavedScrollback).mock.calls[0][3];
    rerender(<SavedScrollback target={{ paneId: "%1", identity: "replacement" }} part="beginning" />);
    await screen.findByText(/Opening line/);
    expect(signal?.aborted).toBe(true);
    await act(async () => { finish({ ...opening, lines: ["Stale private output"] }); });
    expect(screen.queryByText("Stale private output")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Output")).not.toBeInTheDocument();
    expect(loadSavedScrollback).toHaveBeenLastCalledWith({ paneId: "%1", identity: "replacement" }, "beginning", null, expect.any(AbortSignal));
  });

  it("retries an unavailable archive and reports that missing output was never saved", async () => {
    vi.mocked(loadSavedScrollback).mockRejectedValueOnce(new Error("Archive unavailable"));
    render(<SavedScrollback target={{ historyId: "history" }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Archive unavailable");
    vi.mocked(loadSavedScrollback).mockResolvedValue({ ...opening, lines: [], panes: [], selectedPane: null, firstCapturedAt: null, capturedAt: null });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("No output was saved for this pane yet.");
    expect(screen.getByRole("button", { name: "Copy saved output" })).toBeDisabled();
    expect(screen.getByText(/Output already lost before recording began is unavailable/)).toBeVisible();
    expect(screen.queryByText(/Recording began/)).not.toBeInTheDocument();
  });

  it("keeps saved text selectable after clipboard access fails", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error("denied"));
    render(<SavedScrollback target={{ historyId: "history" }} />);
    await screen.findByLabelText("Beginning output");
    fireEvent.click(screen.getByRole("button", { name: "Copy saved output" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Select the output text"));
    expect(screen.getByLabelText("Beginning output")).toHaveTextContent("Opening line");
  });
});
