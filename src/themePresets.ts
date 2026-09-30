import type { Theme } from "./theme";

export const THEME_PALETTES = [
  { id: "muxdeck", mode: "dark", name: "Muxdeck dark", background: "#151914", foreground: "#e8ece5", accent: "#bbf451" },
  { id: "nord", mode: "dark", name: "Nord", background: "#2e3440", foreground: "#eceff4", accent: "#88c0d0" },
  { id: "dracula", mode: "dark", name: "Dracula", background: "#282a36", foreground: "#f8f8f2", accent: "#bd93f9" },
  { id: "tokyo-night", mode: "dark", name: "Tokyo Night", background: "#1a1b26", foreground: "#c0caf5", accent: "#7aa2f7" },
  { id: "paper", mode: "light", name: "Paper", background: "#f4f0e7", foreground: "#22261f", accent: "#4f7518" },
  { id: "solarized-light", mode: "light", name: "Solarized Light", background: "#fdf6e3", foreground: "#354d54", accent: "#007d94" },
  { id: "github-light", mode: "light", name: "GitHub Light", background: "#ffffff", foreground: "#1f2328", accent: "#0969da" },
  { id: "rose-pine-dawn", mode: "light", name: "Rosé Pine Dawn", background: "#faf4ed", foreground: "#575279", accent: "#856593" },
] as const;

export type ThemePaletteId = (typeof THEME_PALETTES)[number]["id"];
export type ThemePalettePreferences = Record<Theme, ThemePaletteId>;

export const DEFAULT_THEME_PALETTES: ThemePalettePreferences = {
  dark: "muxdeck",
  light: "paper",
};

export function isThemePaletteForMode(value: unknown, mode: Theme): value is ThemePaletteId {
  return THEME_PALETTES.some((palette) => palette.id === value && palette.mode === mode);
}

export function getThemePalette(id: ThemePaletteId) {
  return THEME_PALETTES.find((palette) => palette.id === id)!;
}
