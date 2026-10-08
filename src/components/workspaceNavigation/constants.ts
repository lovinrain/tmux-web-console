

export const DESKTOP_COMMAND_PALETTE_SHORTCUT = "Ctrl+Shift+H";
export const DESKTOP_SHORTCUT_LAUNCHER_SHORTCUT = "Ctrl+Shift+Z";

export const WORKSPACE_TAB_SHORTCUTS = {
  previous: "Ctrl+Shift+,",
  next: "Ctrl+Shift+.",
  search: "Ctrl+Shift+;",
  direct: "Ctrl+Shift+1-9",
} as const;

export const DESKTOP_CONSOLE_SHORTCUTS = {
  commandPalette: DESKTOP_COMMAND_PALETTE_SHORTCUT,
  shortcutLauncher: DESKTOP_SHORTCUT_LAUNCHER_SHORTCUT,
  newSession: "Ctrl+Shift+B",
  insertSnippet: "Ctrl+Shift+I",
  endSession: "Ctrl+Shift+E",
  renameSession: "Ctrl+Shift+R",
  returnLive: "Ctrl+Shift+L",
  copyMode: "Ctrl+Shift+C",
  tabActions: "Ctrl+Shift+A",
  pageUp: "Ctrl+Shift+U",
  pageDown: "Ctrl+Shift+D",
  sessionTabs: "Ctrl+Shift+S",
  focus: "Ctrl+Shift+F",
  floatingInput: "Ctrl+Shift+Y",
  theme: "Ctrl+Shift+Z, then T",
  copyNew: "Ctrl+Shift+M",
} as const;

export const MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID = "muxdeck-mobile-workspace-overview";
