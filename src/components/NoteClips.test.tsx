import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTE_CAPTURES_CHANGED, cleanEndedNoteImages, extractCaptureText, listNoteCaptures,
  updateNoteCapture, type NoteCapture, type NoteCaptureStorage,
} from "../noteCaptures";
import { NoteClips, NoteStorageButton } from "./NoteClips";

vi.mock("../noteCaptures", async (importOriginal) => ({
  ...await importOriginal<typeof import("../noteCaptures")>(),
  cleanEndedNoteImages: vi.fn(), extractCaptureText: vi.fn(), listNoteCaptures: vi.fn(), updateNoteCapture: vi.fn(),
}));
const capture: NoteCapture = {
  id: "a".repeat(32), scope: "common", target: "common", pageId: "main", text: "original text", caption: "",
  sourceSession: "alpha", sourceIdentity: "$1:100:90:42", createdAt: 100, updatedAt: 100,
  sourceEndedAt: 200, kept: false, imageBytes: 1000, imageExpiredAt: null, expiresAt: 200 + 7 * 86400, revision: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listNoteCaptures).mockResolvedValue([capture]);
  vi.mocked(extractCaptureText).mockResolvedValue("OCR suggestion");
  vi.mocked(updateNoteCapture).mockResolvedValue({ ...capture, revision: 1 });
  vi.mocked(cleanEndedNoteImages).mockResolvedValue(1000);
});

describe("Note capture cards and storage", () => {
  it("reviews ended-image cleanup and excludes live and kept images", async () => {
    const kept = { ...capture, id: "b".repeat(32), sourceSession: "kept-source", kept: true };
    const live = { ...capture, id: "c".repeat(32), sourceSession: "live-source", sourceEndedAt: null };
    const storage: NoteCaptureStorage = {
      summary: { usedBytes: 3000, limitBytes: 3100, unreferencedBytes: 0, imageCount: 3, endedImageCount: 2,
        endedBytes: 2000, warning: "critical", retentionDays: 7, targets: {} },
      captures: [capture, kept, live], ocrAvailable: true,
    };
    const view = render(<NoteStorageButton storage={storage} error="" />);
    const trigger = screen.getByRole("button", { name: "Manage note image storage" });
    expect(trigger).toHaveClass("critical");
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Note image storage" });
    expect(within(dialog).getByText(/Text remains/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Review cleanup of 1 ended images" }));
    expect(cleanEndedNoteImages).not.toHaveBeenCalled();
    view.rerender(<NoteStorageButton storage={{ ...storage,
      captures: [...storage.captures, { ...capture, id: "d".repeat(32) }] }} error="" />);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete ended images" }));
    await waitFor(() => expect(cleanEndedNoteImages).toHaveBeenCalledWith([capture.id]));
    const keptRow = within(dialog).getByText("kept-source").closest("article")!;
    fireEvent.click(within(keptRow).getByRole("button", { name: "Stop keeping" }));
    await waitFor(() => expect(updateNoteCapture).toHaveBeenCalledWith(kept, { kept: false }));
  });

  it("preserves editable OCR and its revision through refresh and a conflicting save", async () => {
    render(<NoteClips destination={{ scope: "common", target: "common", pageId: "main" }} sourceSessionName="alpha" workspaceId="workspace-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Extract text" }));
    const text = await screen.findByRole("textbox", { name: "Capture text" });
    expect(text).toHaveValue("OCR suggestion");
    fireEvent.change(text, { target: { value: "Reviewed OCR draft" } });
    vi.mocked(listNoteCaptures).mockResolvedValue([{ ...capture, text: "other browser's edit", revision: 1 }]);
    await act(async () => { window.dispatchEvent(new Event(NOTE_CAPTURES_CHANGED)); });
    await waitFor(() => expect(listNoteCaptures).toHaveBeenCalledTimes(2));
    expect(text).toHaveValue("Reviewed OCR draft");
    vi.mocked(updateNoteCapture).mockRejectedValueOnce(new Error("capture changed in another browser"));
    fireEvent.click(screen.getByRole("button", { name: "Save text" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("capture changed in another browser");
    expect(text).toHaveValue("Reviewed OCR draft");
    expect(updateNoteCapture).toHaveBeenCalledWith(expect.objectContaining({ revision: 0 }), { text: "Reviewed OCR draft" });
  });
});
