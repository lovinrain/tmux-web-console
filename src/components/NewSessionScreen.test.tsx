import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../api";
import { renderWithTheme } from "../test-utils";
import { NEW_SESSION_PANEL_ID, NewSessionScreen } from "./NewSessionScreen";

vi.mock("../api", () => ({
  createSession: vi.fn(),
}));

function deferredSession() {
  let resolve!: (name: string) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<string>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  document.title = "Muxdeck";
});

describe("NewSessionScreen", () => {
  it("waits for explicit confirmation and exposes the workspace tab panel", async () => {
    const onCreated = vi.fn();
    const onCancel = vi.fn();
    renderWithTheme(
      <NewSessionScreen
        onCreated={onCreated}
        onCancel={onCancel}
        sessionNavigation={<nav aria-label="Test workspace tabs">Tabs</nav>}
      />,
    );

    expect(createSession).not.toHaveBeenCalled();
    expect(document.title).toBe("New session - Muxdeck");
    expect(screen.getByRole("heading", { name: "Start a new session." })).toHaveFocus();
    expect(screen.getByRole("navigation", { name: "Test workspace tabs" })).toBeVisible();
    expect(screen.getByRole("tabpanel", { name: "Start a new session." })).toHaveAttribute(
      "id",
      NEW_SESSION_PANEL_ID,
    );
    expect(screen.getByRole("button", { name: "Light theme" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("creates exactly once while busy and reports the assigned session name", async () => {
    const request = deferredSession();
    const onCreated = vi.fn();
    vi.mocked(createSession).mockReturnValue(request.promise);
    const { container } = renderWithTheme(
      <NewSessionScreen onCreated={onCreated} onCancel={vi.fn()} />,
    );

    const form = container.querySelector<HTMLFormElement>(".new-session-form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(createSession).toHaveBeenCalledOnce();
    expect(form).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await act(async () => {
      request.resolve("muxdeck-42");
      await request.promise;
    });

    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith("muxdeck-42");
    expect(form).toHaveAttribute("aria-busy", "false");
  });

  it("announces creation failures and permits a retry", async () => {
    vi.mocked(createSession)
      .mockRejectedValueOnce(new Error("tmux server is unavailable"))
      .mockResolvedValueOnce("muxdeck-retry");
    const onCreated = vi.fn();
    renderWithTheme(<NewSessionScreen onCreated={onCreated} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("tmux server is unavailable");
    expect(screen.getByRole("button", { name: "Create session" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("muxdeck-retry"));
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it("delivers a successful result after SPA navigation unmounts the view", async () => {
    const request = deferredSession();
    const onCreated = vi.fn();
    vi.mocked(createSession).mockReturnValue(request.promise);
    const { unmount } = renderWithTheme(
      <NewSessionScreen onCreated={onCreated} onCancel={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    unmount();
    await act(async () => {
      request.resolve("muxdeck-after-navigation");
      await request.promise;
    });

    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith("muxdeck-after-navigation");
  });
});
