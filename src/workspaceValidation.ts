export const MAX_WORKSPACE_NAME_LENGTH = 80;
export const MAX_WORKSPACE_TABS = 256;

export function uniqueWorkspaceTabs(tabs: readonly string[]): string[] {
  return [...new Set(tabs.filter(Boolean))];
}

export function workspaceNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a workspace name.";
  if (trimmed.length > MAX_WORKSPACE_NAME_LENGTH) {
    return `Use ${MAX_WORKSPACE_NAME_LENGTH} characters or fewer.`;
  }
  if (/\p{Cc}/u.test(trimmed)) {
    return "Workspace names cannot contain control characters.";
  }
  return null;
}
