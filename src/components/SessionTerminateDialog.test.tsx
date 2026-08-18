import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithTheme } from "../test-utils";
import { SessionTerminateDialog } from "./SessionTerminateDialog";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve = (_value: T) => {};
  let reject = (_reason: unknown) => {};
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("SessionTerminateDialog", () => {
  it("states the destructive scope, focuses Cancel, traps focus, and closes with Escape", () => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    const view = renderWithTheme(
      <SessionTerminateDialog
        sessionName="native-work"
        sessionTitle="Deployment review"
        onClose={onClose}
        onTerminate={vi.fn(async () => {})}
      />,
    );

    const dialog = screen.getByRole("alertdialog", { name: "Terminate tmux session?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(dialog).toHaveTextContent("Deployment review");
    expect(dialog).toHaveTextContent("native-work");
    expect(dialog).toHaveTextContent("every pane");
    expect(dialog).toHaveTextContent("Unsaved terminal work can be lost");
    expect(dialog).toHaveTextContent("Memoranda and display metadata remain saved");

    const close = within(dialog).getByRole("button", {
      name: "Close terminate-session confirmation",
    });
    close.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(within(dialog).getByRole("button", { name: "Terminate session" })).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("allows only one in-flight termination and cannot be dismissed while pending", async () => {
    const request = deferred<void>();
    const onTerminate = vi.fn(() => request.promise);
    const onClose = vi.fn();
    renderWithTheme(
      <SessionTerminateDialog
        sessionName="work"
        sessionTitle={null}
        onClose={onClose}
        onTerminate={onTerminate}
      />,
    );

    const terminate = screen.getByRole("button", { name: "Terminate session" });
    fireEvent.click(terminate);
    fireEvent.click(terminate);

    expect(onTerminate).toHaveBeenCalledOnce();
    expect(screen.getByRole("alertdialog")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Terminating..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      request.resolve();
      await request.promise;
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the confirmation open with a retryable error after failure", async () => {
    const onTerminate = vi.fn(async () => {
      throw new Error("tmux permission denied");
    });
    renderWithTheme(
      <SessionTerminateDialog
        sessionName="work"
        sessionTitle={null}
        onClose={vi.fn()}
        onTerminate={onTerminate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Terminate session" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("tmux permission denied");
    await waitFor(() => expect(screen.getByRole("button", { name: "Terminate session" }))
      .toBeEnabled());
    expect(screen.getByRole("alertdialog")).toBeVisible();
  });

  it("uses fallback focus when successful termination removes its trigger", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const onFallbackFocus = vi.fn();
    const view = renderWithTheme(
      <SessionTerminateDialog
        sessionName="work"
        sessionTitle={null}
        onClose={vi.fn()}
        onTerminate={vi.fn(async () => {})}
        onFallbackFocus={onFallbackFocus}
      />,
    );

    trigger.remove();
    view.unmount();

    expect(onFallbackFocus).toHaveBeenCalledOnce();
  });
});
