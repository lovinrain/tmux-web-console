export function sessionRenameError(name: string): string | null {
  if (!name.trim()) return "Enter a tmux session name.";
  if (name.length > 256) return "A tmux session name can contain at most 256 characters.";
  if (name.includes(":") || name.includes(".") || name.includes("\\")) {
    return "A tmux session name cannot contain a colon, period, or backslash.";
  }
  if (name.endsWith(";")) return "A tmux session name cannot end with a semicolon.";
  if ([...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    return "A tmux session name cannot contain control characters.";
  }
  return null;
}
