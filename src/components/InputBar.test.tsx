import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InputBar,
  MAX_DRAFT_LENGTH,
  stageSessionDraft,
  type InputBarHandle,
} from "./InputBar";

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

afterEach(() => {
  vi.restoreAllMocks();
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

  it("inserts a snippet at the current selection and persists the exact draft", () => {
    const ref = createRef<InputBarHandle>();
    render(<InputBar {...props} ref={ref} />);
    const textarea = screen.getByRole("textbox", { name: "Staged input" }) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "alpha omega" } });
    textarea.setSelectionRange(6, 11);

    let inserted = false;
    act(() => {
      inserted = ref.current?.insertText("beta\nnext") ?? false;
    });

    expect(inserted).toBe(true);
    expect(textarea).toHaveValue("alpha beta\nnext");
    expect(window.localStorage.getItem("muxdeck-terminal-draft:test-session"))
      .toBe("alpha beta\nnext");
  });

  it("rejects an over-limit snippet without truncating or changing the draft", () => {
    const ref = createRef<InputBarHandle>();
    render(<InputBar {...props} ref={ref} />);
    const textarea = screen.getByRole("textbox", { name: "Staged input" }) as HTMLTextAreaElement;
    const existing = "x".repeat(MAX_DRAFT_LENGTH - 1);
    fireEvent.input(textarea, { target: { value: existing } });
    textarea.setSelectionRange(existing.length, existing.length);

    let inserted = true;
    act(() => {
      inserted = ref.current?.insertText("too long") ?? true;
    });

    expect(inserted).toBe(false);
    expect(textarea).toHaveValue(existing);
  });

  it("reports failure when card staging cannot persist to browser storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is unavailable", "QuotaExceededError");
    });

    expect(stageSessionDraft("test-session", "do not lose this")).toBe("storage-error");
    expect(window.localStorage.getItem("muxdeck-terminal-draft:test-session")).toBeNull();

    render(<InputBar {...props} />);
    const textarea = screen.getByRole("textbox", { name: "Staged input" });
    fireEvent.input(textarea, { target: { value: "still visible" } });
    expect(textarea).toHaveValue("still visible");
    expect(screen.getByText(/could not be saved on this device/i)).toBeVisible();
  });

  it("opens metadata controls independently of terminal connectivity", () => {
    const onEditSessionTitle = vi.fn();
    const onOpenMessages = vi.fn();
    const onOpenSnippets = vi.fn();
    render(
      <InputBar
        {...props}
        enabled={false}
        onEditSessionTitle={onEditSessionTitle}
        onOpenMessages={onOpenMessages}
        onOpenSnippets={onOpenSnippets}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Update session name" }));
    fireEvent.click(screen.getByRole("button", { name: "Open memoranda" }));
    fireEvent.click(screen.getByRole("button", { name: "Open snippets" }));

    expect(onEditSessionTitle).toHaveBeenCalledOnce();
    expect(onOpenMessages).toHaveBeenCalledOnce();
    expect(onOpenSnippets).toHaveBeenCalledOnce();
  });
});
