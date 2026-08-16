import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionRenameDialog } from "./SessionRenameDialog";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("SessionRenameDialog", () => {
  it("contains focus, locks page scroll, and restores the opening trigger", () => {
    const outsideKeyDown = vi.fn();
    const previousOverflow = "clip";
    document.body.style.overflow = previousOverflow;

    function RenameHarness() {
      const [open, setOpen] = useState(false);
      return (
        <div onKeyDown={outsideKeyDown}>
          <button type="button" onClick={() => setOpen(true)}>Open rename</button>
          {open && (
            <SessionRenameDialog
              sessionName="before"
              onClose={() => setOpen(false)}
              onRename={vi.fn(async () => {})}
            />
          )}
        </div>
      );
    }

    render(<RenameHarness />);
    const openingTrigger = screen.getByRole("button", { name: "Open rename" });
    openingTrigger.focus();
    fireEvent.click(openingTrigger);

    const dialog = screen.getByRole("dialog", { name: "Rename tmux session" });
    const input = screen.getByRole("textbox", { name: "Native tmux name" });
    expect(document.body.style.overflow).toBe("hidden");
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "a" });
    expect(outsideKeyDown).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "after" } });
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ));
    focusable[0].focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(focusable.at(-1)).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(focusable[0]).toHaveFocus();

    openingTrigger.focus();
    expect(input).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog", { name: "Rename tmux session" }))
      .not.toBeInTheDocument();
    expect(openingTrigger).toHaveFocus();
    expect(document.body.style.overflow).toBe(previousOverflow);
  });

  it("distinguishes the native tmux name and validates before submitting", async () => {
    const onRename = vi.fn(async () => {});
    render(
      <SessionRenameDialog
        sessionName="current-session"
        onClose={vi.fn()}
        onRename={onRename}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Rename tmux session" });
    const input = screen.getByRole("textbox", { name: "Native tmux name" });
    const submit = screen.getByRole("button", { name: "Rename session" });
    expect(input).toHaveValue("current-session");
    expect(input).toHaveFocus();
    expect(submit).toBeDisabled();
    expect(dialog).toHaveTextContent("real tmux rename");
    expect(dialog).toHaveTextContent("separate Muxdeck display title is preserved");
    expect(dialog).toHaveTextContent(
      "Leading and trailing spaces are part of the name and will be preserved",
    );

    fireEvent.change(input, { target: { value: "   " } });
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: "invalid.name" } });
    expect(screen.getByRole("alert")).toHaveTextContent("colon or period");
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: "trailing-semicolon;" } });
    expect(screen.getByRole("alert")).toHaveTextContent("cannot end with a semicolon");
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: "  renamed/session  " } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(onRename).toHaveBeenCalledWith("  renamed/session  "));
  });

  it("locks dismissal while a rename is saving", async () => {
    const pending = deferred();
    const onClose = vi.fn();
    const onRename = vi.fn(() => pending.promise);
    render(
      <SessionRenameDialog
        sessionName="before"
        onClose={onClose}
        onRename={onRename}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Native tmux name" }), {
      target: { value: "after" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Renaming..." }))
      .toBeDisabled());
    expect(screen.getByRole("textbox", { name: "Native tmux name" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close tmux rename" })).toBeDisabled();

    fireEvent.keyDown(window, { key: "Escape" });
    const dialog = screen.getByRole("dialog", { name: "Rename tmux session" });
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(dialog).toHaveFocus();
    fireEvent.mouseDown(dialog.parentElement as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => pending.resolve());
    expect(onRename).toHaveBeenCalledOnce();
  });

  it("keeps the entered name and restores actions after an API error", async () => {
    const onClose = vi.fn();
    const onRename = vi.fn(async () => {
      throw new Error("duplicate session: already exists");
    });
    render(
      <SessionRenameDialog
        sessionName="before"
        onClose={onClose}
        onRename={onRename}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Native tmux name" });
    fireEvent.change(input, { target: { value: "already-exists" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "duplicate session: already exists",
    );
    expect(input).toHaveValue("already-exists");
    expect(screen.getByRole("button", { name: "Rename session" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close tmux rename" })).toBeEnabled();
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.change(input, { target: { value: "try-another-name" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
