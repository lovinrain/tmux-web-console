import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CallbackListEntry } from "../callbackListView";
import { CallbackGroupEditor } from "./CallbackGroupEditor";

function entry(name: string): CallbackListEntry {
  return { name, messages: [], workspaceNames: [], inCurrentWorkspace: true, globalOnly: false };
}

function props() {
  return {
    groupId: "release", workspaceId: null,
    groups: [
      { id: "release", name: "Release", workspaceId: null, sessions: ["a", "no-longer-queued"] },
      { id: "other", name: "Other", workspaceId: null, sessions: ["b"] },
    ],
    revision: 3, entries: [entry("a"), entry("b"), entry("c")],
    onSave: vi.fn(async () => undefined), onDelete: vi.fn(async () => undefined), onClose: vi.fn(),
  };
}

describe("CallbackGroupEditor", () => {
  it("preserves hidden and dormant members while choosing callbacks from another group", async () => {
    const options = props();
    render(<CallbackGroupEditor {...options} />);
    expect(screen.getByRole("textbox", { name: "Custom callback group name" })).toHaveFocus();
    expect(screen.getByRole("checkbox", { name: "Include no-longer-queued in group" })).toBeChecked();
    fireEvent.change(screen.getByRole("searchbox", { name: "Find callbacks to group" }), { target: { value: "b" } });
    expect(screen.queryByRole("checkbox", { name: "Include a in group" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select shown" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Custom callback group name" }), { target: { value: "Shipping" } });
    fireEvent.click(screen.getByRole("button", { name: "Save group" }));
    await waitFor(() => expect(options.onSave).toHaveBeenCalledExactlyOnceWith({
      id: "release", workspaceId: null, name: "Shipping", sessions: ["a", "no-longer-queued", "b"], expectedRevision: 3,
    }));
    expect(options.onClose).toHaveBeenCalledOnce();
  });

  it("keeps a draft after a remote edit and requires reloading current membership before saving", () => {
    const options = props();
    const view = render(<CallbackGroupEditor {...options} />);
    const input = screen.getByRole("textbox", { name: "Custom callback group name" });
    fireEvent.change(input, { target: { value: "Unsaved draft" } });
    view.rerender(<CallbackGroupEditor {...options} revision={4} groups={[
      { ...options.groups[0], name: "Remote edit", sessions: ["c"] }, options.groups[1],
    ]} />);
    expect(input).toHaveValue("Unsaved draft");
    expect(screen.getByRole("button", { name: "Save group" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete group" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reload groups" }));
    expect(input).toHaveValue("Remote edit");
    expect(screen.getByRole("checkbox", { name: "Include c in group" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Include a in group" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save group" })).toBeEnabled();
  });

  it("deletes only the group and uses the revision the user edited", async () => {
    const options = props();
    render(<CallbackGroupEditor {...options} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
    await waitFor(() => expect(options.onDelete).toHaveBeenCalledExactlyOnceWith(options.groups[0], 3));
    expect(options.onSave).not.toHaveBeenCalled();
    expect(options.onClose).toHaveBeenCalledOnce();
  });

  it("handles server errors, duplicate names, remote deletion, and Escape without saving", async () => {
    const options = props();
    options.onSave.mockRejectedValueOnce(new Error("Server could not save the group."));
    const view = render(<CallbackGroupEditor {...options} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Custom callback group name" }), { target: { value: "Other" } });
    expect(screen.getByRole("button", { name: "Save group" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Custom callback group name" }), { target: { value: "Valid" } });
    fireEvent.click(screen.getByRole("button", { name: "Save group" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Server could not save"));
    expect(options.onClose).not.toHaveBeenCalled();
    view.rerender(<CallbackGroupEditor {...options} groups={[]} revision={4} />);
    expect(screen.getByText("This group was deleted in another window.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save group" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Custom callback group name" }), { key: "Escape" });
    expect(options.onClose).toHaveBeenCalledOnce();
  });
});
