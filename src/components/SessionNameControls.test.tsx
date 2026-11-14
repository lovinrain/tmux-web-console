import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionNameControls } from "./SessionNameControls";
import { session } from "./workspaceNavigation/testFixtures";

describe("SessionNameControls", () => {
  it("edits and copies the title independently and offers a pencil for both fields", async () => {
    const name = "agent 雪";
    const title = "Planning: α. Start;";
    const nextTitle = "Review: β. Done;";
    const target = session({ name, customTitle: title, tags: ["work"] });
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const onUpdateTitle = vi.fn().mockResolvedValue(undefined);
    const onRename = vi.fn();
    const view = render(<SessionNameControls name={name} displayTitle={title} session={target}
      onRename={onRename} onUpdateTitle={onUpdateTitle} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy session display title" }));
    await waitFor(() => expect(copy).toHaveBeenNthCalledWith(1, title));
    fireEvent.click(screen.getByRole("button", { name: "Copy tmux session name" }));
    await waitFor(() => expect(copy).toHaveBeenNthCalledWith(2, name));
    fireEvent.click(screen.getByRole("button", { name: "Edit display title" }));
    const input = screen.getByRole("textbox", { name: "Session display title" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue(title);
    expect(input).toHaveAttribute("maxlength", "80");
    fireEvent.change(input, { target: { value: nextTitle } });
    fireEvent.click(screen.getByRole("button", { name: "Copy session display title" }));
    await waitFor(() => expect(copy).toHaveBeenNthCalledWith(3, title));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Session display title" })).not.toBeInTheDocument());
    expect(onUpdateTitle).toHaveBeenCalledExactlyOnceWith(target, nextTitle);
    expect(onRename).not.toHaveBeenCalled();
    view.rerender(<SessionNameControls name={name} displayTitle={nextTitle} session={{ ...target, customTitle: nextTitle }}
      onRename={onRename} onUpdateTitle={onUpdateTitle} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy session display title" }));
    await waitFor(() => expect(copy).toHaveBeenNthCalledWith(4, nextTitle));
    fireEvent.click(screen.getByRole("button", { name: "Rename tmux session inline" }));
    expect(screen.getByRole("textbox", { name: "Tmux session name" })).toHaveValue(name);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Tmux session name" }), { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
  });

  it("validates display titles separately and permits clearing the optional title", async () => {
    const target = session({ name: "agent", customTitle: "Planning" });
    const onUpdateTitle = vi.fn().mockResolvedValue(undefined);
    const onRename = vi.fn();
    const view = render(<SessionNameControls name="agent" displayTitle="Planning" session={target}
      onRename={onRename} onUpdateTitle={onUpdateTitle} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Edit session display title" }));
    let input = screen.getByRole("textbox", { name: "Session display title" });
    for (const [value, message] of [["x".repeat(81), "80 characters"], ["bad\u0000title", "control characters"]]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(onUpdateTitle).not.toHaveBeenCalled();
    }
    const title = "Lead: ICT. Follow-ups;";
    fireEvent.change(input, { target: { value: title } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Session display title" })).not.toBeInTheDocument());
    expect(onUpdateTitle).toHaveBeenCalledExactlyOnceWith(target, title);
    const updated = { ...target, customTitle: title };
    view.rerender(<SessionNameControls name="agent" displayTitle={title} session={updated}
      onRename={onRename} onUpdateTitle={onUpdateTitle} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit display title" }));
    input = screen.getByRole("textbox", { name: "Session display title" });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onUpdateTitle).toHaveBeenLastCalledWith(updated, ""));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Session display title" })).not.toBeInTheDocument());
    view.rerender(<SessionNameControls name="agent" displayTitle="agent" session={{ ...target, customTitle: null }}
      onRename={onRename} onUpdateTitle={onUpdateTitle} />);
    expect(screen.getByRole("button", { name: "Edit session display title" })).toHaveTextContent("No display title");
    expect(screen.getByRole("button", { name: "Copy session display title" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit display title" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy tmux session name" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit tmux session name" })).toHaveTextContent("agent");
    expect(onRename).not.toHaveBeenCalled();
  });

  it("validates names, ignores composition Enter, and keeps a failed rename editable for retry", async () => {
    const target = session({ name: "agent" });
    const onRename = vi.fn().mockRejectedValueOnce(new Error("That name is already used.")).mockResolvedValue(undefined);
    render(<SessionNameControls name="agent" displayTitle="agent" session={target} onRename={onRename} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Edit tmux session name" }));
    const input = screen.getByRole("textbox", { name: "Tmux session name" });
    fireEvent.change(input, { target: { value: "invalid.name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent("colon, period, or backslash");
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "renamed-雪" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("That name is already used.");
    expect(input).toHaveValue("renamed-雪");
    expect(input).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save tmux session name" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Tmux session name" })).not.toBeInTheDocument());
    expect(onRename).toHaveBeenCalledTimes(2);
    expect(onRename).toHaveBeenLastCalledWith(target, "renamed-雪");
  });

  it("keeps the session identity captured at the start of an edit", async () => {
    const original = session({ name: "agent", id: "$11" });
    const replacement = session({ name: "agent", id: "$12" });
    const onRename = vi.fn().mockResolvedValue(undefined);
    const view = render(<SessionNameControls name="agent" displayTitle="agent" session={original} onRename={onRename} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Edit tmux session name" }));
    view.rerender(<SessionNameControls name="agent" displayTitle="agent" session={replacement} onRename={onRename} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Tmux session name" }), { target: { value: "new-agent" } });
    fireEvent.click(screen.getByRole("button", { name: "Save tmux session name" }));
    await waitFor(() => expect(onRename).toHaveBeenCalledExactlyOnceWith(original, "new-agent"));
  });

  it("offers the exact current name for manual copying when clipboard access fails, without saving a draft", async () => {
    const name = "  agent 雪  ";
    const copy = vi.fn().mockRejectedValue(new Error("Denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const onRename = vi.fn();
    render(<SessionNameControls name={name} displayTitle="Display title" session={session({ name })} onRename={onRename} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Edit tmux session name" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Tmux session name" }), { target: { value: "unsaved-name" } });
    const button = screen.getByRole("button", { name: "Copy tmux session name" });
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    const manual = await screen.findByRole("textbox", { name: "Session name to copy" });
    expect(copy).toHaveBeenCalledExactlyOnceWith(name);
    expect(manual).toHaveValue(name);
    await waitFor(() => {
      expect(manual).toHaveFocus();
      expect((manual as HTMLInputElement).selectionEnd).toBe(name.length);
    });
    expect(onRename).not.toHaveBeenCalled();
  });
});
