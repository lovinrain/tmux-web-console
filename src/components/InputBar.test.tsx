import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InputBar, type InputBarHandle } from "./InputBar";

const props = {
  sessionName: "test-session",
  enabled: true,
  onSend: vi.fn(() => true),
  onSubmit: vi.fn(async () => true),
  onFocus: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("InputBar", () => {
  it("sends exact terminal control sequences", () => {
    const onSend = vi.fn(() => true);
    render(<InputBar {...props} onSend={onSend} />);

    fireEvent.click(screen.getByRole("button", { name: "PgUp" }));
    fireEvent.click(screen.getByRole("button", { name: "PgDn" }));
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    fireEvent.click(screen.getByRole("button", { name: "^C" }));
    fireEvent.click(screen.getByRole("button", { name: "Up" }));

    expect(onSend.mock.calls).toEqual([
      ["\x1b[5~"],
      ["\x1b[6~"],
      ["\x1b"],
      ["\x03"],
      ["\x1b[A"],
    ]);
  });

  it("keeps the draft editable but disables sending while disconnected", () => {
    render(<InputBar {...props} enabled={false} />);
    const textarea = screen.getByRole("textbox", { name: "Staged input" });

    fireEvent.input(textarea, { target: { value: "prepare this offline" } });

    expect(textarea).toBeEnabled();
    expect(textarea).toHaveValue("prepare this offline");
    expect(screen.getByRole("button", { name: "Send + Enter" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Esc" })).toBeDisabled();
    expect(window.localStorage.getItem("muxdeck-terminal-draft:test-session")).toBe("prepare this offline");
  });

  it("submits the final replacement value once and clears only after success", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<InputBar {...props} onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox", { name: "Staged input" });

    fireEvent.compositionStart(textarea);
    fireEvent.input(textarea, { target: { value: "open the diff" }, inputType: "insertText" });
    fireEvent.input(textarea, { target: { value: "open the diff viewer." }, inputType: "insertReplacementText" });
    fireEvent.compositionEnd(textarea, { data: "open the diff viewer." });
    fireEvent.click(screen.getByRole("button", { name: "Send + Enter" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith("open the diff viewer.", true);
    await waitFor(() => expect(textarea).toHaveValue(""));
    expect(window.localStorage.getItem("muxdeck-terminal-draft:test-session")).toBeNull();
    expect(screen.getByText(/Written once/)).toBeVisible();
  });

  it("retains the draft when the live terminal rejects submission", async () => {
    const onSubmit = vi.fn(async () => false);
    render(<InputBar {...props} onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox", { name: "Staged input" });
    fireEvent.input(textarea, { target: { value: "do not lose me" } });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("do not lose me", false));
    expect(textarea).toHaveValue("do not lose me");
    expect(window.localStorage.getItem("muxdeck-terminal-draft:test-session")).toBe("do not lose me");
    expect(screen.getByText(/Delivery was not confirmed/)).toBeVisible();
  });

  it("restores a per-session local draft without controlling the textarea", () => {
    window.localStorage.setItem("muxdeck-terminal-draft:test-session", "restored prompt");
    render(<InputBar {...props} />);

    expect(screen.getByRole("textbox", { name: "Staged input" })).toHaveValue("restored prompt");
    expect(screen.getByText(/Saved on this device/)).toBeVisible();
  });

  it("loads a memorandum into the staged draft through its imperative handle", () => {
    const ref = createRef<InputBarHandle>();
    render(<InputBar {...props} ref={ref} />);

    let loaded = false;
    act(() => {
      loaded = ref.current?.loadDraft("queued instruction") ?? false;
    });
    expect(loaded).toBe(true);

    expect(screen.getByRole("textbox", { name: "Staged input" })).toHaveValue("queued instruction");
    expect(window.localStorage.getItem("muxdeck-terminal-draft:test-session")).toBe("queued instruction");
    expect(screen.getByText(/Memorandum loaded locally/)).toBeVisible();
  });

  it("opens metadata controls independently of terminal connectivity", () => {
    const onEditSessionTitle = vi.fn();
    const onOpenMessages = vi.fn();
    render(
      <InputBar
        {...props}
        enabled={false}
        onEditSessionTitle={onEditSessionTitle}
        onOpenMessages={onOpenMessages}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Update session name" }));
    fireEvent.click(screen.getByRole("button", { name: "Open memoranda" }));

    expect(onEditSessionTitle).toHaveBeenCalledOnce();
    expect(onOpenMessages).toHaveBeenCalledOnce();
  });
});
