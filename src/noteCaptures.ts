import { BASE_PATH, jsonRequest } from "./api";
import type { Session } from "./types";

export type NoteCaptureScope = "common" | "workspace" | "session";
export interface NoteCaptureDestination { scope: NoteCaptureScope; target: string; pageId: string }
export interface NoteCapture extends NoteCaptureDestination {
  id: string;
  text: string;
  caption: string;
  sourceSession: string;
  sourceIdentity: string;
  createdAt: number;
  updatedAt: number;
  sourceEndedAt: number | null;
  kept: boolean;
  imageBytes: number;
  imageExpiredAt: number | null;
  expiresAt: number | null;
  revision: number;
}
export interface NoteCaptureTargetUsage { bytes: number; images: number; endedImages: number; captures: number }
export interface NoteCaptureStorage {
  summary: {
    usedBytes: number; limitBytes: number; unreferencedBytes: number;
    imageCount: number; endedImageCount: number; endedBytes: number;
    warning: "normal" | "warning" | "critical";
    retentionDays: number;
    targets: Record<string, NoteCaptureTargetUsage>;
  };
  captures: NoteCapture[];
  ocrAvailable: boolean;
}
export const NOTE_CAPTURES_CHANGED = "muxdeck:note-captures-changed";
export const NOTE_CAPTURE_OPEN = "muxdeck:note-capture-open";
export const captureIdentity = (session: Session) => `${session.id}:${session.created}:${session.serverStarted}:${session.serverPid}`;
export const captureImageUrl = (capture: Pick<NoteCapture, "id" | "revision">) =>
  `${BASE_PATH}/api/note-captures/${encodeURIComponent(capture.id)}/image?v=${capture.revision}`;
const body = (method: string, value: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
});
export function capturesChanged() { window.dispatchEvent(new Event(NOTE_CAPTURES_CHANGED)); }
export function openCapturedNote(destination: NoteCaptureDestination) {
  window.dispatchEvent(new CustomEvent(NOTE_CAPTURE_OPEN, { detail: destination }));
}
export function newCaptureId() { return crypto.randomUUID().replaceAll("-", ""); }
export function noteImageBytes(bytes: number): string {
  return bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
export async function listNoteCaptures(destination: NoteCaptureDestination, signal?: AbortSignal) {
  const query = new URLSearchParams({ scope: destination.scope, target: destination.target, pageId: destination.pageId });
  return (await jsonRequest<{ captures: NoteCapture[] }>(`/api/note-captures?${query}`, { signal })).captures;
}
export function getNoteCaptureStorage(signal?: AbortSignal): Promise<NoteCaptureStorage> {
  return jsonRequest("/api/note-captures/storage", { signal });
}
export async function saveNoteCapture(destination: NoteCaptureDestination, source: Session,
  text: string, image?: Blob, id = newCaptureId()): Promise<NoteCapture> {
  const data = new FormData();
  data.append("metadata", JSON.stringify({ ...destination, id, sourceSession: source.name,
    sourceIdentity: captureIdentity(source), text }));
  if (image) data.append("image", image, "capture.png");
  const result = await jsonRequest<{ capture: NoteCapture }>("/api/note-captures", { method: "POST", body: data });
  capturesChanged();
  return result.capture;
}
export async function updateNoteCapture(capture: NoteCapture,
  changes: Partial<Pick<NoteCapture, "text" | "caption" | "kept" | "scope" | "target" | "pageId">>) {
  const result = await jsonRequest<{ capture: NoteCapture }>(`/api/note-captures/${capture.id}`,
    body("PATCH", { expectedRevision: capture.revision, ...changes }));
  capturesChanged();
  return result.capture;
}
export async function deleteNoteCapture(id: string, imageOnly = false) {
  const result = await jsonRequest<{ freedBytes: number }>(`/api/note-captures/${id}?imageOnly=${imageOnly}`, { method: "DELETE" });
  capturesChanged();
  return result.freedBytes;
}
export async function extractCaptureText(id: string) {
  return (await jsonRequest<{ text: string }>(`/api/note-captures/${id}/ocr`, { method: "POST" })).text;
}
export async function cleanEndedNoteImages(ids: string[]) {
  const result = await jsonRequest<{ freedBytes: number }>("/api/note-captures/cleanup", body("POST", { ids }));
  capturesChanged();
  return result.freedBytes;
}
export function rememberCapturePage(destination: NoteCaptureDestination) {
  try { localStorage.setItem(`muxdeck.capture-page:${destination.scope}:${destination.target}`, destination.pageId); } catch { /* optional preference */ }
}
export function rememberedCapturePage(scope: NoteCaptureScope, target: string): string | null {
  try { return localStorage.getItem(`muxdeck.capture-page:${scope}:${target}`); } catch { return null; }
}
