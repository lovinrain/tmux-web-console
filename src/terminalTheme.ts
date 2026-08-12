import type { ITheme } from "@xterm/xterm";
import type { Theme } from "./theme";

export type TerminalThemeMode = Theme;

export const DARK_TERMINAL_THEME: ITheme = {
  background: "#0b0e0c",
  foreground: "#e3e8df",
  cursor: "#ffb648",
  cursorAccent: "#0b0e0c",
  selectionBackground: "#bbf45144",
  black: "#151915",
  red: "#ff6b5f",
  green: "#bbf451",
  yellow: "#ffca68",
  blue: "#77bdfb",
  magenta: "#d9a0ff",
  cyan: "#68dfd0",
  white: "#e3e8df",
  brightBlack: "#667064",
  brightRed: "#ff8f86",
  brightGreen: "#d1ff7d",
  brightYellow: "#ffdd95",
  brightBlue: "#9ed0ff",
  brightMagenta: "#e7bdff",
  brightCyan: "#91f1e4",
  brightWhite: "#ffffff",
};

export const LIGHT_TERMINAL_THEME: ITheme = {
  background: "#fbfaf5",
  foreground: "#242a24",
  cursor: "#9a4d00",
  cursorAccent: "#fbfaf5",
  selectionBackground: "#6d940052",
  selectionInactiveBackground: "#75806f38",
  black: "#202620",
  red: "#a42820",
  green: "#276b2d",
  yellow: "#795100",
  blue: "#1959a6",
  magenta: "#76428b",
  cyan: "#00666d",
  white: "#59635b",
  brightBlack: "#626d64",
  brightRed: "#bd352b",
  brightGreen: "#33783a",
  brightYellow: "#8b6100",
  brightBlue: "#2869b3",
  brightMagenta: "#8d50a0",
  brightCyan: "#14757c",
  brightWhite: "#111711",
};

export const TERMINAL_THEMES: Record<TerminalThemeMode, ITheme> = {
  dark: DARK_TERMINAL_THEME,
  light: LIGHT_TERMINAL_THEME,
};
