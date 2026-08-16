import { createRef, StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InputBar,
  handoffRenamedSessionDraft,
  MAX_DRAFT_LENGTH,
  renameSessionDraft,
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
  it("keeps both regions mounted and preserves the draft while visibility changes", () => {
    const view = render(<InputBar {...props} />);
    const dock = screen.getByRole("region", { name: "Terminal input" });
    const composer = document.getElementById("muxdeck-staged-input");
    const shortcuts = screen.getByRole("group", { name: "Terminal input shortcuts" });
    const textarea = screen.getByRole("textbox", { name: "Staged input" });

    expect(composer).not.toHaveAttribute("hidden");
    expect(shortcuts).not.toHaveAttribute("hidden");
    fireEvent.input(textarea, { target: { value: "keep this draft in place" } });

    view.rerender(
      <InputBar {...props} composerVisible={false} shortcutsVisible />,
    );

    expect(composer).toHaveAttribute("hidden");
    expect(shortcuts).not.toHaveAttribute("hidden");
    expect(dock).not.toHaveAttribute("hidden");
    expect(screen.queryByRole("textbox", { name: "Staged input" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Terminal input shortcuts" })).toBeVisible();
    expect(document.getElementById("terminal-staged-input")).toBe(textarea);

    view.rerender(
      <InputBar {...props} composerVisible={false} shortcutsVisible={false} />,
    );

    expect(dock).toHaveAttribute("hidden");
    expect(document.getElementById("muxdeck-staged-input")).toBe(composer);
    expect(document.getElementById("muxdeck-terminal-shortcuts")).toBe(shortcuts);
    expect(document.getElementById("terminal-staged-input")).toBe(textarea);

    view.rerender(
      <InputBar {...props} composerVisible shortcutsVisible={false} />,
    );

    expect(dock).not.toHaveAttribute("hidden");
    expect(composer).not.toHaveAttribute("hidden");
    expect(shortcuts).toHaveAttribute("hidden");
    expect(screen.getByRole("textbox", { name: "Staged input" }))
      .toHaveValue("keep this draft in place");
    expect(screen.queryByRole("group", { name: "Terminal input shortcuts" }))
      .not.toBeInTheDocument();
  });

  it("closes the additional key panel when terminal shortcuts are hidden", async () => {
    const view = render(<InputBar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Show other keys" }));
    expect(screen.getByRole("group", { name: "Other keys" })).toBeVisible();

    view.rerender(<InputBar {...props} shortcutsVisible={false} />);

    await waitFor(() => expect(screen.queryByRole("group", { name: "Other keys" }))
      .not.toBeInTheDocument());
    view.rerender(<InputBar {...props} shortcutsVisible />);
    expect(screen.getByRole("button", { name: "Show other keys" }))
      .toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Other keys" })).not.toBeInTheDocument();
  });

  it("sends exact terminal control sequences", () => {
    const onSend = vi.fn(() => true);
    render(<InputBar {...props} onSend={onSend} />);

    const startButton = screen.getByRole("button", { name: "Ctrl+A - move to start of input" });
    const endButton = screen.getByRole("button", { name: "Ctrl+E - move to end of input" });
    expect(startButton).toHaveTextContent(/^\^A$/);
    expect(endButton).toHaveTextContent(/^\^E$/);
    expect(screen.getByRole("button", { name: "Raw terminal keyboard" })).toHaveAttribute(
      "title",
      expect.stringContaining("directly to tmux"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Tmux Page Up" }));
    fireEvent.click(screen.getByRole("button", { name: "Tmux Page Down" }));
    fireEvent.click(startButton);
    fireEvent.click(endButton);
    fireEvent.click(screen.getByRole("button", { name: "PgUp" }));
    fireEvent.click(screen.getByRole("button", { name: "PgDn" }));
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    fireEvent.click(screen.getByRole("button", { name: "^C" }));
    fireEvent.click(screen.getByRole("button", { name: "Show other keys" }));
    const otherKeys = screen.getByRole("group", { name: "Other keys" });
    fireEvent.click(within(otherKeys).getByRole("button", { name: "Up" }));
    fireEvent.click(within(otherKeys).getByRole("button", { name: "Down" }));
    fireEvent.click(within(otherKeys).getByRole("button", { name: "Left" }));
    fireEvent.click(within(otherKeys).getByRole("button", { name: "Right" }));

    expect(onSend.mock.calls).toEqual([
      ["\x02\x1b[5~"],
      ["\x1b[6~"],
      ["\x01"],
      ["\x05"],
      ["\x1b[5~"],
      ["\x1b[6~"],
      ["\x1b"],
      ["\x03"],
      ["\x1b[A"],
      ["\x1b[B"],
      ["\x1b[D"],
      ["\x1b[C"],
    ]);
  });

  it("keeps additional keys in a collapsed secondary panel", () => {
    render(<InputBar {...props} />);
    const showOtherKeys = screen.getByRole("button", { name: "Show other keys" });
    const textarea = screen.getByRole("textbox", { name: "Staged input" });

    expect(showOtherKeys).toHaveTextContent("Other Keys");
    expect(showOtherKeys).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Other keys" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Up" })).not.toBeInTheDocument();

    textarea.focus();
    expect(fireEvent.mouseDown(showOtherKeys)).toBe(false);
    fireEvent.click(showOtherKeys);

    const otherKeys = screen.getByRole("group", { name: "Other keys" });
    expect(showOtherKeys).toHaveAttribute("aria-expanded", "true");
    expect(showOtherKeys).toHaveAttribute("aria-controls", otherKeys.id);
    expect(within(otherKeys).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Up", "Down", "Left", "Right"]);
    expect(textarea).toHaveFocus();

    const upButton = within(otherKeys).getByRole("button", { name: "Up" });
    const inputDock = screen.getByRole("region", { name: "Terminal input" });
    const buttonsInDomOrder = within(inputDock).getAllByRole("button");
    expect(buttonsInDomOrder[buttonsInDomOrder.indexOf(showOtherKeys) + 1]).toBe(upButton);
    expect(fireEvent.mouseDown(upButton)).toBe(false);
    expect(textarea).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Hide other keys" }));

    expect(showOtherKeys).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Other keys" })).not.toBeInTheDocument();
  });

  it("keeps the draft editable but disables sending while disconnected", () => {
    render(<InputBar {...props} enabled={false} />);
    const textarea = screen.getByRole("textbox", { name: "Staged input" });

    fireEvent.input(textarea, { target: { value: "prepare this offline" } });

    expect(textarea).toBeEnabled();
    expect(textarea).toHaveValue("prepare this offline");
    expect(screen.getByRole("button", { name: "Send + Enter" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Esc" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tmux Page Up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ctrl+A - move to start of input" }))
      .toBeDisabled();
    const showOtherKeys = screen.getByRole("button", { name: "Show other keys" });
    expect(showOtherKeys).toBeEnabled();
    fireEvent.click(showOtherKeys);
    const otherKeys = screen.getByRole("group", { name: "Other keys" });
    for (const arrow of ["Up", "Down", "Left", "Right"]) {
      expect(within(otherKeys).getByRole("button", { name: arrow })).toBeDisabled();
    }
    expect(window.localStorage.getItem("muxdeck-terminal-draft:test-session")).toBe("prepare this offline");
  });

  it("preserves staged-input focus when a terminal shortcut is pressed", () => {
    const onSend = vi.fn(() => true);
    render(<InputBar {...props} onSend={onSend} />);
    const textarea = screen.getByRole("textbox", { name: "Staged input" });
    const startButton = screen.getByRole("button", {
      name: "Ctrl+A - move to start of input",
    });
    textarea.focus();

    expect(fireEvent.mouseDown(startButton)).toBe(false);
    expect(textarea).toHaveFocus();
    fireEvent.click(startButton);

    expect(onSend).toHaveBeenCalledWith("\x01");
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

  it("uses Shift+Enter for Send + Enter while leaving plain Enter multiline", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<InputBar {...props} onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox", { name: "Staged input" });
    const sendWithEnter = screen.getByRole("button", { name: "Send + Enter" });
    fireEvent.input(textarea, { target: { value: "run the checks" } });

    expect(sendWithEnter).toHaveAttribute("aria-keyshortcuts", "Shift+Enter");
    expect(fireEvent.keyDown(textarea, { key: "Enter" })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.input(textarea, { target: { value: "run the checks\nthen summarize" } });
    expect(window.localStorage.getItem("muxdeck-terminal-draft:test-session"))
      .toBe("run the checks\nthen summarize");

    expect(fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })).toBe(false);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      "run the checks\nthen summarize",
      true,
    ));
    await waitFor(() => expect(textarea).toHaveValue(""));
  });

  it("does not submit shortcut variants that may be editing or composing", () => {
    const onSubmit = vi.fn(async () => true);
    const view = render(<InputBar {...props} onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox", { name: "Staged input" });

    expect(fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })).toBe(true);
    fireEvent.input(textarea, { target: { value: "keep editing" } });
    expect(fireEvent.keyDown(textarea, {
      key: "Enter",
      shiftKey: true,
      ctrlKey: true,
    })).toBe(true);

    fireEvent.compositionStart(textarea);
    expect(fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })).toBe(true);
    fireEvent.compositionEnd(textarea, { data: "keep editing" });
    expect(fireEvent.keyDown(textarea, {
      key: "Enter",
      keyCode: 229,
      shiftKey: true,
    })).toBe(true);

    view.rerender(<InputBar {...props} enabled={false} onSubmit={onSubmit} />);
    expect(fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("ignores repeated and concurrent Shift+Enter submissions", async () => {
    let resolveSubmission: ((accepted: boolean) => void) | undefined;
    const onSubmit = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveSubmission = resolve;
    }));
    render(<InputBar {...props} onSubmit={onSubmit} />);
    const textarea = screen.getByRole("textbox", { name: "Staged input" });
    fireEvent.input(textarea, { target: { value: "send once" } });

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true, repeat: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSubmit).toHaveBeenCalledOnce();

    await act(async () => resolveSubmission?.(true));
    await waitFor(() => expect(textarea).toHaveValue(""));
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

  it("moves a staged draft to the renamed tmux session key", () => {
    window.localStorage.setItem("muxdeck-terminal-draft:before", "keep this input");

    expect(renameSessionDraft("before", "after")).toBe("migrated");
    expect(window.localStorage.getItem("muxdeck-terminal-draft:before")).toBeNull();
    expect(window.localStorage.getItem("muxdeck-terminal-draft:after"))
      .toBe("keep this input");
  });

  it("swaps a stale destination draft instead of discarding either value", () => {
    window.localStorage.setItem("muxdeck-terminal-draft:before", "active draft");
    window.localStorage.setItem("muxdeck-terminal-draft:after", "stale draft");

    expect(renameSessionDraft("before", "after")).toBe("swapped");
    expect(window.localStorage.getItem("muxdeck-terminal-draft:before"))
      .toBe("stale draft");
    expect(window.localStorage.getItem("muxdeck-terminal-draft:after"))
      .toBe("active draft");
  });

  it("leaves the source draft intact when rename storage is unavailable", () => {
    window.localStorage.setItem("muxdeck-terminal-draft:before", "do not lose this");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is unavailable", "QuotaExceededError");
    });

    expect(renameSessionDraft("before", "after")).toBe("storage-error");
    expect(window.localStorage.getItem("muxdeck-terminal-draft:before"))
      .toBe("do not lose this");
    expect(window.localStorage.getItem("muxdeck-terminal-draft:after")).toBeNull();
  });

  it("hands the exact visible draft across one rename mount when storage fails", () => {
    const beforeRef = createRef<InputBarHandle>();
    const before = render(
      <InputBar {...props} sessionName="handoff-before" ref={beforeRef} />,
    );
    const input = screen.getByRole("textbox", { name: "Staged input" });
    const storageSet = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is unavailable", "QuotaExceededError");
    });
    fireEvent.input(input, { target: { value: "  exact visible draft\n" } });

    expect(beforeRef.current?.getDraft()).toBe("  exact visible draft\n");
    expect(handoffRenamedSessionDraft(
      "handoff-before",
      "handoff-after",
      "$handoff",
      beforeRef.current?.getDraft() ?? "",
    )).toBe("storage-error");
    before.unmount();

    const afterRef = createRef<InputBarHandle>();
    const after = render(
      <StrictMode>
        <InputBar
          {...props}
          sessionName="handoff-after"
          sessionId="$handoff"
          ref={afterRef}
        />
      </StrictMode>,
    );
    expect(screen.getByRole("textbox", { name: "Staged input" }))
      .toHaveValue("  exact visible draft\n");
    expect(afterRef.current?.getDraft()).toBe("  exact visible draft\n");
    expect(screen.getByText(/could not be saved on this device/i)).toBeVisible();
    after.unmount();
    storageSet.mockRestore();

    render(<InputBar {...props} sessionName="handoff-after" />);
    expect(screen.getByRole("textbox", { name: "Staged input" })).toHaveValue("");
  });

  it("does not let an older rename handoff replace a subsequently staged draft", () => {
    window.localStorage.setItem("muxdeck-terminal-draft:handoff-source", "old handoff");
    expect(handoffRenamedSessionDraft(
      "handoff-source",
      "handoff-destination",
      "$same-session",
      "old handoff",
    )).toBe("migrated");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(stageSessionDraft("handoff-destination", "newer staged draft")).toBe("staged");

    render(
      <InputBar
        {...props}
        sessionName="handoff-destination"
        sessionId="$same-session"
      />,
    );

    expect(screen.getByRole("textbox", { name: "Staged input" }))
      .toHaveValue("newer staged draft");
  });

  it("does not hand a draft to a different tmux ID that reuses the name", () => {
    const storageSet = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is unavailable", "QuotaExceededError");
    });
    expect(handoffRenamedSessionDraft(
      "reuse-source",
      "reuse-destination",
      "$original-session",
      "belongs to the original session",
    )).toBe("storage-error");
    storageSet.mockRestore();

    render(
      <InputBar
        {...props}
        sessionName="reuse-destination"
        sessionId="$reused-session"
      />,
    );

    expect(screen.getByRole("textbox", { name: "Staged input" })).toHaveValue("");
  });

  it("opens metadata controls independently of terminal connectivity", () => {
    const onEditSessionTitle = vi.fn();
    const onRenameSession = vi.fn();
    const onOpenMessages = vi.fn();
    const onOpenSnippets = vi.fn();
    render(
      <InputBar
        {...props}
        enabled={false}
        onEditSessionTitle={onEditSessionTitle}
        onRenameSession={onRenameSession}
        onOpenMessages={onOpenMessages}
        onOpenSnippets={onOpenSnippets}
      />,
    );

    const aliasButton = screen.getByRole("button", { name: "Edit display title" });
    const renameButton = screen.getByRole("button", { name: "Rename tmux session" });
    expect(aliasButton).toHaveTextContent("Alias");
    expect(renameButton).toHaveTextContent("Tmux");
    expect(renameButton).toHaveAttribute(
      "title",
      expect.stringContaining("Ctrl+B, then $"),
    );
    expect(aliasButton).toBeEnabled();
    expect(renameButton).toBeEnabled();

    fireEvent.click(aliasButton);
    expect(onEditSessionTitle).toHaveBeenCalledOnce();
    expect(onRenameSession).not.toHaveBeenCalled();

    fireEvent.click(renameButton);
    fireEvent.click(screen.getByRole("button", { name: "Open memoranda" }));
    fireEvent.click(screen.getByRole("button", { name: "Open snippets" }));

    expect(onRenameSession).toHaveBeenCalledOnce();
    expect(onOpenMessages).toHaveBeenCalledOnce();
    expect(onOpenSnippets).toHaveBeenCalledOnce();
  });

  it("disables alias and native rename independently when callbacks are unavailable", () => {
    const onRenameSession = vi.fn();
    const view = render(<InputBar {...props} onRenameSession={onRenameSession} />);

    expect(screen.getByRole("button", { name: "Edit display title" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rename tmux session" })).toBeEnabled();

    view.rerender(<InputBar {...props} onEditSessionTitle={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Edit display title" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Rename tmux session" })).toBeDisabled();
  });
});
