export const FLOATING_TERMINAL_STORAGE_PREFIX = "muxdeck.floating-terminal.v1:";

export function newTemporaryTerminalKey(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `temporary:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
