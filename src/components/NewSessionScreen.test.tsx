import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../api";
import { renderWithTheme } from "../test-utils";
import { NEW_SESSION_PANEL_ID, NewSessionScreen } from "./NewSessionScreen";

vi.mock("../api", () => ({
  createSession: vi.fn(),
}));

function deferredSession() {
  let resolve!: (session: { name: string; id: string }) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<{ name: string; id: string }>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
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
    const nameInput = screen.getByRole("textbox", { name: /tmux session name/i });
    expect(nameInput).toHaveValue("");
    expect(nameInput).toHaveAttribute("maxlength", "256");
    expect(nameInput).toHaveAccessibleDescription(/leave blank for an assigned name/i);

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
    expect(createSession).toHaveBeenCalledWith(undefined, "dark");
    expect(form).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: /tmux session name/i })).toBeDisabled();

    await act(async () => {
      request.resolve({ name: "muxdeck-42", id: "$42" });
      await request.promise;
    });

    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith("muxdeck-42", "$42");
    expect(form).toHaveAttribute("aria-busy", "false");
  });

  it("preserves an exact custom name while creating and trusts the returned name", async () => {
    const request = deferredSession();
    const onCreated = vi.fn();
    vi.mocked(createSession).mockReturnValue(request.promise);
    const { container } = renderWithTheme(
      <NewSessionScreen onCreated={onCreated} onCancel={vi.fn()} />,
    );
    const input = screen.getByRole("textbox", { name: /tmux session name/i });
    const form = container.querySelector<HTMLFormElement>(".new-session-form")!;

    fireEvent.change(input, { target: { value: "  work/session #1  " } });
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledWith("  work/session #1  ", "dark");
    expect(input).toBeDisabled();

    await act(async () => {
      request.resolve({ name: "server-returned-name", id: "$43" });
      await request.promise;
    });

    expect(onCreated).toHaveBeenCalledWith("server-returned-name", "$43");
  });

  it("validates a custom name without blocking the assigned-name default", () => {
    renderWithTheme(<NewSessionScreen onCreated={vi.fn()} onCancel={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: /tmux session name/i });
    const submit = screen.getByRole("button", { name: "Create session" });
    expect(submit).toBeEnabled();

    const invalidNames = [
      ["   ", "cannot be blank"],
      ["bad:name", "colon or period"],
      ["bad.name", "colon or period"],
      ["bad\\name", "backslash"],
      ["bad;", "end with a semicolon"],
    ];
    for (const [name, message] of invalidNames) {
      fireEvent.change(input, { target: { value: name } });
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(submit).toBeDisabled();
    }

    fireEvent.change(input, { target: { value: "  embedded;name #1  " } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(submit).toBeEnabled();

    fireEvent.change(input, { target: { value: "" } });
    expect(submit).toBeEnabled();
  });

  it("announces creation failures, retains the name, and permits a retry", async () => {
    vi.mocked(createSession)
      .mockRejectedValueOnce(new Error("duplicate session: existing"))
      .mockResolvedValueOnce({ name: "try-another-name", id: "$44" });
    const onCreated = vi.fn();
    renderWithTheme(<NewSessionScreen onCreated={onCreated} onCancel={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: /tmux session name/i });

    fireEvent.change(input, { target: { value: "existing" } });
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("duplicate session: existing");
    expect(input).toHaveValue("existing");
    expect(screen.getByRole("button", { name: "Create session" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();

    fireEvent.change(input, { target: { value: "try-another-name" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("try-another-name", "$44"));
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenNthCalledWith(1, "existing", "dark");
    expect(createSession).toHaveBeenNthCalledWith(2, "try-another-name", "dark");
  });

  it("uses the selected light appearance for Grok processes launched later", async () => {
    window.localStorage.setItem("muxdeck-theme", "light");
    vi.mocked(createSession).mockResolvedValue({ name: "light-session", id: "$46" });
    renderWithTheme(<NewSessionScreen onCreated={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText(
      /on tmux 3\.2\+, Grok Build launched here follows the current light appearance/i,
    )).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));

    await waitFor(() => expect(createSession).toHaveBeenCalledWith(undefined, "light"));
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
      request.resolve({ name: "muxdeck-after-navigation", id: "$45" });
      await request.promise;
    });

    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith("muxdeck-after-navigation", "$45");
  });
});
