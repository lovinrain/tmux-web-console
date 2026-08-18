import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createQueuedMessage,
  deleteQueuedMessage,
  getSnippetTree,
  listQueuedMessages,
  updateQueuedMessage,
} from "../api";
import type { MessageQueue, QueuedMessage } from "../types";
import { MessageQueueDialog } from "./MessageQueueDialog";

vi.mock("../api", () => ({
  createQueuedMessage: vi.fn(),
  deleteQueuedMessage: vi.fn(),
  getSnippetTree: vi.fn(),
  listQueuedMessages: vi.fn(),
  updateQueuedMessage: vi.fn(),
}));

const firstMessage: QueuedMessage = {
  id: "first",
  text: "Run the focused tests",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  position: 0,
  state: "queued",
};

const secondMessage: QueuedMessage = {
  id: "second",
  text: "Summarize the changes",
  createdAt: 1_700_000_001_000,
  updatedAt: 1_700_000_001_000,
  position: 1,
  state: "note",
};

beforeEach(() => {
  vi.mocked(listQueuedMessages).mockReset().mockResolvedValue({
    session: "work",
    messages: [firstMessage],
  });
  vi.mocked(createQueuedMessage).mockReset();
  vi.mocked(updateQueuedMessage).mockReset().mockImplementation(async (_session, id, update) => ({
    ...(id === firstMessage.id ? firstMessage : secondMessage),
    ...update,
    id,
    updatedAt: 1_700_000_005_000,
  }));
  vi.mocked(deleteQueuedMessage).mockReset();
  vi.mocked(getSnippetTree).mockReset().mockResolvedValue({ revision: 0, tree: [] });
});

describe("MessageQueueDialog", () => {
  it("presents Memo as a writing shelf and reports loaded note and queue counts", async () => {
    const onCountsChange = vi.fn();
    vi.mocked(listQueuedMessages).mockResolvedValue({
      session: "work",
      // A queued item is intentionally promoted ahead of an earlier-positioned note.
      messages: [{ ...secondMessage, position: 0 }, { ...firstMessage, position: 1 }],
    });
    render(
      <MessageQueueDialog
        sessionName="work"
        sessionTitle="Important work"
        onClose={vi.fn()}
        onCountsChange={onCountsChange}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading memo");
    expect(await screen.findByRole("heading", { name: "Memo" })).toBeVisible();
    expect(screen.getByText(/Draft freely/)).toBeVisible();
    expect(screen.getByText("Important work")).toBeVisible();
    expect(screen.getByText(/2 SAVED · 1 QUEUED/)).toBeVisible();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining(firstMessage.text),
      expect.stringContaining(secondMessage.text),
    ]);
    expect(screen.getByText("Queued · 01")).toBeVisible();
    expect(screen.getByText("Note")).toBeVisible();
    expect(onCountsChange).toHaveBeenLastCalledWith({ total: 2, queued: 1 });
  });

  it("inserts a selected snippet into a new memo without sending or saving", async () => {
    vi.mocked(getSnippetTree).mockResolvedValue({
      revision: 1,
      tree: [{ id: "status", type: "snippet", name: "Status check", text: "git status\n" }],
    });
    render(<MessageQueueDialog sessionName="work" onClose={vi.fn()} />);
    await screen.findByText(firstMessage.text);
    const textarea = screen.getByLabelText("New memo") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "Before: " } });
    textarea.setSelectionRange(8, 8);

    fireEvent.click(screen.getByRole("button", { name: "Insert snippet" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview snippet Status check" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    await waitFor(() => expect(textarea).toHaveValue("Before: git status\n"));
    expect(textarea).toHaveFocus();
    expect(createQueuedMessage).not.toHaveBeenCalled();
  });

  it("restores page scrolling when Memo and its nested snippet picker unmount together", async () => {
    document.body.style.overflow = "clip";
    const { unmount } = render(<MessageQueueDialog sessionName="work" onClose={vi.fn()} />);
    await screen.findByText(firstMessage.text);

    fireEvent.click(screen.getByRole("button", { name: "Insert snippet" }));
    expect(await screen.findByRole("dialog", { name: "Insert into new memo" })).toBeVisible();
    expect(document.body.style.overflow).toBe("hidden");

    unmount();
    expect(document.body.style.overflow).toBe("clip");
    document.body.style.overflow = "";
  });

  it("saves notes by default and only queues a new memo after the explicit toggle", async () => {
    const onCountsChange = vi.fn();
    const thirdMessage: QueuedMessage = {
      ...secondMessage,
      id: "third",
      text: "Continue after CI",
      position: 2,
      state: "queued",
    };
    vi.mocked(createQueuedMessage)
      .mockResolvedValueOnce(secondMessage)
      .mockResolvedValueOnce(thirdMessage);
    render(
      <MessageQueueDialog
        sessionName="work"
        onClose={vi.fn()}
        onCountsChange={onCountsChange}
      />,
    );

    await screen.findByText(firstMessage.text);
    const addTextarea = screen.getByLabelText("New memo");
    const addForm = addTextarea.closest("form")!;
    const queueToggle = within(addForm).getByRole("button", { name: "Queue next" });
    expect(queueToggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.input(addTextarea, { target: { value: secondMessage.text } });
    fireEvent.click(within(addForm).getByRole("button", { name: "Save memo" }));

    await waitFor(() => expect(createQueuedMessage).toHaveBeenCalledWith(
      "work",
      secondMessage.text,
      "note",
    ));
    expect(await screen.findByText(secondMessage.text)).toBeVisible();
    expect(addTextarea).toHaveValue("");
    expect(onCountsChange).toHaveBeenLastCalledWith({ total: 2, queued: 1 });

    fireEvent.input(addTextarea, { target: { value: thirdMessage.text } });
    fireEvent.click(queueToggle);
    expect(queueToggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(addForm).getByRole("button", { name: "Save memo" }));

    await waitFor(() => expect(createQueuedMessage).toHaveBeenLastCalledWith(
      "work",
      thirdMessage.text,
      "queued",
    ));
    expect(await screen.findByText(thirdMessage.text)).toBeVisible();
    expect(queueToggle).toHaveAttribute("aria-pressed", "false");
    expect(onCountsChange).toHaveBeenLastCalledWith({ total: 3, queued: 2 });
  });

  it("stages a queued memo, moves it to notes, and then closes", async () => {
    const onChoose = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const onCountsChange = vi.fn();
    vi.mocked(updateQueuedMessage).mockResolvedValue({ ...firstMessage, state: "note" });
    render(
      <MessageQueueDialog
        sessionName="work"
        onClose={onClose}
        onChoose={onChoose}
        onCountsChange={onCountsChange}
      />,
    );
    await screen.findByText(firstMessage.text);

    fireEvent.click(screen.getByRole("button", { name: "Stage" }));

    await waitFor(() => expect(onChoose).toHaveBeenCalledWith(firstMessage));
    expect(updateQueuedMessage).toHaveBeenCalledWith("work", firstMessage.id, { state: "note" });
    expect(onCountsChange).toHaveBeenLastCalledWith({ total: 1, queued: 0 });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("removes a queued memo only after terminal delivery is acknowledged", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onCountsChange = vi.fn();
    vi.mocked(updateQueuedMessage).mockResolvedValue({ ...firstMessage, state: "note" });
    vi.mocked(deleteQueuedMessage).mockResolvedValue(undefined);
    render(
      <MessageQueueDialog
        sessionName="work"
        onClose={vi.fn()}
        onSend={onSend}
        onCountsChange={onCountsChange}
      />,
    );
    await screen.findByText(firstMessage.text);

    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(firstMessage));
    await waitFor(() => expect(deleteQueuedMessage).toHaveBeenCalledWith(
      "work",
      firstMessage.id,
    ));
    expect(updateQueuedMessage).toHaveBeenCalledWith("work", firstMessage.id, { state: "note" });
    expect(vi.mocked(updateQueuedMessage).mock.invocationCallOrder[0])
      .toBeLessThan(onSend.mock.invocationCallOrder[0]);
    expect(onSend.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deleteQueuedMessage).mock.invocationCallOrder[0]);
    expect(await screen.findByText(/memo sent and removed/i)).toBeVisible();
    expect(screen.queryByText(firstMessage.text)).not.toBeInTheDocument();
    expect(screen.getByText("Your memo is empty.")).toBeVisible();
    expect(onCountsChange).toHaveBeenLastCalledWith({ total: 0, queued: 0 });
  });

  it("removes a note after terminal delivery is acknowledged without reclassifying it", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onCountsChange = vi.fn();
    vi.mocked(listQueuedMessages).mockResolvedValue({
      session: "work",
      messages: [secondMessage],
    });
    vi.mocked(deleteQueuedMessage).mockResolvedValue(undefined);
    render(
      <MessageQueueDialog
        sessionName="work"
        onClose={vi.fn()}
        onSend={onSend}
        onCountsChange={onCountsChange}
      />,
    );
    await screen.findByText(secondMessage.text);

    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    await waitFor(() => expect(deleteQueuedMessage).toHaveBeenCalledWith(
      "work",
      secondMessage.id,
    ));
    expect(updateQueuedMessage).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith(secondMessage);
    expect(onSend.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deleteQueuedMessage).mock.invocationCallOrder[0]);
    expect(screen.queryByText(secondMessage.text)).not.toBeInTheDocument();
    expect(onCountsChange).toHaveBeenLastCalledWith({ total: 0, queued: 0 });
  });

  it("does not send a queued memo when it cannot first persist the move to notes", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onCountsChange = vi.fn();
    vi.mocked(updateQueuedMessage).mockRejectedValueOnce(
      new Error("Memo storage is unavailable."),
    );
    render(
      <MessageQueueDialog
        sessionName="work"
        onClose={vi.fn()}
        onSend={onSend}
        onCountsChange={onCountsChange}
      />,
    );
    await screen.findByText(firstMessage.text);

    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("was not sent");
    expect(alert).toHaveTextContent("It remains queued");
    expect(alert).toHaveTextContent("Memo storage is unavailable");
    expect(screen.getByText("Queued · 01")).toBeVisible();
    expect(onSend).not.toHaveBeenCalled();
    expect(deleteQueuedMessage).not.toHaveBeenCalled();
    expect(onCountsChange).toHaveBeenLastCalledWith({ total: 1, queued: 1 });
  });

  it("keeps a queued memo as a note when terminal delivery is unconfirmed", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("Terminal acknowledgement timed out."));
    const onCountsChange = vi.fn();
    vi.mocked(updateQueuedMessage).mockResolvedValue({ ...firstMessage, state: "note" });
    render(
      <MessageQueueDialog
        sessionName="work"
        onClose={vi.fn()}
        onSend={onSend}
        onCountsChange={onCountsChange}
      />,
    );
    await screen.findByText(firstMessage.text);

    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Delivery was not confirmed");
    expect(alert).toHaveTextContent("remains a note and was not re-queued");
    expect(alert).toHaveTextContent("Check the terminal before manually choosing Queue next");
    expect(alert).toHaveTextContent("Terminal acknowledgement timed out");
    expect(updateQueuedMessage).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledOnce();
    expect(deleteQueuedMessage).not.toHaveBeenCalled();
    expect(screen.getByText("Note")).toBeVisible();
    const memoItem = screen.getByText(firstMessage.text).closest("li")!;
    expect(within(memoItem).getByRole("button", { name: "Queue next" }))
      .toHaveAttribute("aria-pressed", "false");
    expect(onCountsChange).toHaveBeenLastCalledWith({ total: 1, queued: 0 });
  });

  it("keeps an acknowledged memo for manual deletion when automatic cleanup fails", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onCountsChange = vi.fn();
    vi.mocked(updateQueuedMessage).mockResolvedValue({ ...firstMessage, state: "note" });
    vi.mocked(deleteQueuedMessage)
      .mockRejectedValueOnce(new Error("Memo storage is unavailable."))
      .mockResolvedValueOnce(undefined);
    render(
      <MessageQueueDialog
        sessionName="work"
        onClose={vi.fn()}
        onSend={onSend}
        onCountsChange={onCountsChange}
      />,
    );
    await screen.findByText(firstMessage.text);

    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("was sent, but it could not be removed automatically");
    expect(alert).toHaveTextContent("Delete it manually; do not send it again");
    expect(alert).toHaveTextContent("Memo storage is unavailable");
    expect(onSend).toHaveBeenCalledOnce();
    expect(deleteQueuedMessage).toHaveBeenCalledOnce();
    expect(screen.getByText("Note")).toBeVisible();
    const memoItem = screen.getByText(firstMessage.text).closest("li")!;
    expect(within(memoItem).getByRole("button", { name: "Sent" })).toBeDisabled();
    expect(within(memoItem).getByRole("button", { name: "Queue next" })).toBeDisabled();
    expect(within(memoItem).getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(within(memoItem).getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(onCountsChange).toHaveBeenLastCalledWith({ total: 1, queued: 0 });

    fireEvent.click(within(memoItem).getByRole("button", { name: "Sent" }));
    expect(onSend).toHaveBeenCalledOnce();
    fireEvent.click(within(memoItem).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(memoItem).getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => expect(deleteQueuedMessage).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(firstMessage.text)).not.toBeInTheDocument();
    expect(onCountsChange).toHaveBeenLastCalledWith({ total: 0, queued: 0 });
  });

  it("edits and deletes a memo while reporting counts after each mutation", async () => {
    const onCountsChange = vi.fn();
    vi.mocked(deleteQueuedMessage).mockResolvedValue(undefined);
    render(
      <MessageQueueDialog
        sessionName="work"
        onClose={vi.fn()}
        onCountsChange={onCountsChange}
      />,
    );

    await screen.findByText(firstMessage.text);
    const firstItem = screen.getByRole("listitem");
    fireEvent.click(within(firstItem).getByRole("button", { name: "Edit" }));
    const editTextarea = screen.getByLabelText("Edit memo 1");
    fireEvent.input(editTextarea, { target: { value: "Run all tests" } });
    fireEvent.click(within(firstItem).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateQueuedMessage).toHaveBeenCalledWith(
      "work",
      firstMessage.id,
      { text: "Run all tests" },
    ));
    expect(await screen.findByText("Run all tests")).toBeVisible();
    expect(onCountsChange).toHaveBeenLastCalledWith({ total: 1, queued: 1 });

    fireEvent.click(within(firstItem).getByRole("button", { name: "Delete" }));
    expect(within(firstItem).getByText("Delete this memo?")).toBeVisible();
    expect(deleteQueuedMessage).not.toHaveBeenCalled();
    fireEvent.click(within(firstItem).getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => expect(deleteQueuedMessage).toHaveBeenCalledWith(
      "work",
      firstMessage.id,
    ));
    expect(screen.queryByText("Run all tests")).not.toBeInTheDocument();
    expect(screen.getByText("Your memo is empty.")).toBeVisible();
    expect(onCountsChange).toHaveBeenLastCalledWith({ total: 0, queued: 0 });
  });

  it("moves notes into and queued items out of the input queue", async () => {
    const onCountsChange = vi.fn();
    vi.mocked(listQueuedMessages).mockResolvedValue({
      session: "work",
      messages: [firstMessage, secondMessage],
    });
    vi.mocked(updateQueuedMessage)
      .mockResolvedValueOnce({ ...secondMessage, state: "queued" })
      .mockResolvedValueOnce({ ...firstMessage, state: "note" });
    render(
      <MessageQueueDialog
        sessionName="work"
        onClose={vi.fn()}
        onCountsChange={onCountsChange}
      />,
    );
    await screen.findByText(secondMessage.text);

    const noteItem = screen.getByText(secondMessage.text).closest("li")!;
    fireEvent.click(within(noteItem).getByRole("button", { name: "Queue next" }));
    await waitFor(() => expect(updateQueuedMessage).toHaveBeenCalledWith(
      "work",
      secondMessage.id,
      { state: "queued" },
    ));
    expect(onCountsChange).toHaveBeenLastCalledWith({ total: 2, queued: 2 });

    const firstItem = screen.getByText(firstMessage.text).closest("li")!;
    fireEvent.click(within(firstItem).getByRole("button", { name: "Move to notes" }));
    await waitFor(() => expect(updateQueuedMessage).toHaveBeenCalledWith(
      "work",
      firstMessage.id,
      { state: "note" },
    ));
    expect(onCountsChange).toHaveBeenLastCalledWith({ total: 2, queued: 1 });
  });

  it("blocks every memo mutation while a refresh is in flight", async () => {
    const onChoose = vi.fn().mockResolvedValue(undefined);
    const onSend = vi.fn().mockResolvedValue(undefined);
    const refreshedQueue: MessageQueue = { session: "work", messages: [firstMessage] };
    let resolveFirstRefresh: (queue: MessageQueue) => void = () => undefined;
    let resolveSecondRefresh: (queue: MessageQueue) => void = () => undefined;
    vi.mocked(listQueuedMessages)
      .mockReset()
      .mockResolvedValueOnce(refreshedQueue)
      .mockImplementationOnce(() => new Promise<MessageQueue>((resolve) => {
        resolveFirstRefresh = resolve;
      }))
      .mockImplementationOnce(() => new Promise<MessageQueue>((resolve) => {
        resolveSecondRefresh = resolve;
      }));
    render(
      <MessageQueueDialog
        sessionName="work"
        onClose={vi.fn()}
        onChoose={onChoose}
        onSend={onSend}
      />,
    );

    await screen.findByText(firstMessage.text);
    const dialog = screen.getByRole("dialog", { name: "Memo" });
    const addTextarea = screen.getByLabelText("New memo");
    const addForm = addTextarea.closest("form")!;
    fireEvent.input(addTextarea, { target: { value: "Do not save during refresh" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh memo" }));

    await waitFor(() => expect(listQueuedMessages).toHaveBeenCalledTimes(2));
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(addTextarea).toBeDisabled();
    expect(within(addForm).getByRole("button", { name: "Queue next" })).toBeDisabled();
    expect(within(addForm).getByRole("button", { name: "Save memo" })).toBeDisabled();
    const memoItem = screen.getByRole("listitem");
    const blockedItemActions = ["Stage", "Send now", "Move to notes", "Edit", "Delete"];
    for (const action of blockedItemActions) {
      const button = within(memoItem).getByRole("button", { name: action });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    fireEvent.submit(addForm);
    expect(createQueuedMessage).not.toHaveBeenCalled();
    expect(updateQueuedMessage).not.toHaveBeenCalled();
    expect(deleteQueuedMessage).not.toHaveBeenCalled();
    expect(onChoose).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();

    resolveFirstRefresh(refreshedQueue);
    await waitFor(() => expect(dialog).toHaveAttribute("aria-busy", "false"));

    fireEvent.click(within(screen.getByRole("listitem")).getByRole("button", { name: "Edit" }));
    const editTextarea = screen.getByLabelText("Edit memo 1");
    const editForm = editTextarea.closest("form")!;
    fireEvent.input(editTextarea, { target: { value: "Do not edit during refresh" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh memo" }));

    await waitFor(() => expect(listQueuedMessages).toHaveBeenCalledTimes(3));
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(editTextarea).toBeDisabled();
    expect(within(editForm).getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.submit(editForm);
    expect(updateQueuedMessage).not.toHaveBeenCalled();

    resolveSecondRefresh(refreshedQueue);
    await waitFor(() => expect(dialog).toHaveAttribute("aria-busy", "false"));
  });

  it("does not overwrite provisional dictation text during unrelated renders", async () => {
    render(<MessageQueueDialog sessionName="work" onClose={vi.fn()} />);
    await screen.findByText(firstMessage.text);
    const textarea = screen.getByLabelText("New memo") as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: "Hello" } });
    textarea.value = "Hello from provisional voice input";
    fireEvent.click(screen.getByRole("button", { name: "Refresh memo" }));

    await waitFor(() => expect(listQueuedMessages).toHaveBeenCalledTimes(2));
    expect(textarea).toHaveValue("Hello from provisional voice input");
  });

  it("shows load errors and retries in place", async () => {
    vi.mocked(listQueuedMessages)
      .mockRejectedValueOnce(new Error("Storage unavailable"))
      .mockResolvedValueOnce({ session: "work", messages: [] });
    render(<MessageQueueDialog sessionName="work" onClose={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Storage unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Your memo is empty.")).toBeVisible();
  });
});
