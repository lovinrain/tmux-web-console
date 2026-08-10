import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createQueuedMessage,
  deleteQueuedMessage,
  listQueuedMessages,
  updateQueuedMessage,
} from "../api";
import type { QueuedMessage } from "../types";
import { MessageQueueDialog } from "./MessageQueueDialog";

vi.mock("../api", () => ({
  createQueuedMessage: vi.fn(),
  deleteQueuedMessage: vi.fn(),
  listQueuedMessages: vi.fn(),
  updateQueuedMessage: vi.fn(),
}));

const firstMessage: QueuedMessage = {
  id: "first",
  text: "Run the focused tests",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  position: 0,
};

const secondMessage: QueuedMessage = {
  id: "second",
  text: "Summarize the changes",
  createdAt: 1_700_000_001_000,
  updatedAt: 1_700_000_001_000,
  position: 1,
};

beforeEach(() => {
  vi.mocked(listQueuedMessages).mockReset().mockResolvedValue({
    session: "work",
    messages: [firstMessage],
  });
  vi.mocked(createQueuedMessage).mockReset();
  vi.mocked(updateQueuedMessage).mockReset();
  vi.mocked(deleteQueuedMessage).mockReset();
});

describe("MessageQueueDialog", () => {
  it("loads messages and exposes choose and send callbacks", async () => {
    const onChoose = vi.fn();
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <MessageQueueDialog
        sessionName="work"
        sessionTitle="Important work"
        onClose={onClose}
        onChoose={onChoose}
        onSend={onSend}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading queued messages");
    expect(await screen.findByText(firstMessage.text)).toBeVisible();
    expect(screen.getByText("Important work")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(firstMessage));
    expect(await screen.findByText(/remains in the queue for reuse/i)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    await waitFor(() => {
      expect(onChoose).toHaveBeenCalledWith(firstMessage);
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  it("adds, edits, and confirms before deleting a queued message", async () => {
    vi.mocked(createQueuedMessage).mockResolvedValue(secondMessage);
    vi.mocked(updateQueuedMessage).mockImplementation(async (_session, id, update) => ({
      ...firstMessage,
      id,
      text: update.text ?? firstMessage.text,
      updatedAt: 1_700_000_005_000,
    }));
    vi.mocked(deleteQueuedMessage).mockResolvedValue(undefined);
    render(<MessageQueueDialog sessionName="work" onClose={vi.fn()} />);

    await screen.findByText(firstMessage.text);
    const addTextarea = screen.getByLabelText("Add a message");
    fireEvent.input(addTextarea, { target: { value: secondMessage.text } });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));

    await waitFor(() => expect(createQueuedMessage).toHaveBeenCalledWith(
      "work",
      secondMessage.text,
    ));
    expect(await screen.findByText(secondMessage.text)).toBeVisible();
    expect(addTextarea).toHaveValue("");

    const firstItem = screen.getAllByRole("listitem")[0];
    fireEvent.click(within(firstItem).getByRole("button", { name: "Edit" }));
    const editTextarea = screen.getByLabelText("Edit queued message 1");
    fireEvent.input(editTextarea, { target: { value: "Run all tests" } });
    fireEvent.click(within(firstItem).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateQueuedMessage).toHaveBeenCalledWith(
      "work",
      firstMessage.id,
      { text: "Run all tests" },
    ));
    expect(await screen.findByText("Run all tests")).toBeVisible();

    fireEvent.click(within(firstItem).getByRole("button", { name: "Delete" }));
    expect(within(firstItem).getByText("Delete this message?")).toBeVisible();
    expect(deleteQueuedMessage).not.toHaveBeenCalled();
    fireEvent.click(within(firstItem).getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => expect(deleteQueuedMessage).toHaveBeenCalledWith(
      "work",
      firstMessage.id,
    ));
    expect(screen.queryByText("Run all tests")).not.toBeInTheDocument();
    expect(screen.getByText(secondMessage.text)).toBeVisible();
  });

  it("does not overwrite provisional dictation text during unrelated renders", async () => {
    render(<MessageQueueDialog sessionName="work" onClose={vi.fn()} />);
    await screen.findByText(firstMessage.text);
    const textarea = screen.getByLabelText("Add a message") as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: "Hello" } });
    textarea.value = "Hello from provisional voice input";
    fireEvent.click(screen.getByRole("button", { name: "Refresh queued messages" }));

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

    expect(await screen.findByText("The queue is empty.")).toBeVisible();
  });
});
