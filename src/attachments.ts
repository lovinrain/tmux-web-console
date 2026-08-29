import type { UploadedSessionAttachment } from "./api";

export const MAX_ATTACHMENT_UPLOAD_BATCH = 6;

export const MOBILE_ATTACHMENT_QUERY = [
  "(max-width: 640px)",
  "(max-width: 1024px) and (pointer: coarse)",
  "(max-width: 1024px) and (max-height: 500px)",
].join(", ");

export type SessionAttachmentUploader = (
  file: File,
  signal: AbortSignal,
) => Promise<UploadedSessionAttachment>;

export function desktopAttachmentsAvailable(): boolean {
  return typeof window.matchMedia !== "function"
    || !window.matchMedia(MOBILE_ATTACHMENT_QUERY).matches;
}

export function transferHasFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.items).some((item) => item.kind === "file")
    || dataTransfer.files.length > 0;
}
