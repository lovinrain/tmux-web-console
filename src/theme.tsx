import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type PropsWithChildren,
} from "react";
import {
  DEFAULT_THEME_PALETTES,
  getThemePalette,
  isThemePaletteForMode,
  type ThemePaletteId,
  type ThemePalettePreferences,
} from "./themePresets";

export type Theme = "dark" | "light";

export const DEFAULT_THEME: Theme = "dark";
export const THEME_STORAGE_KEY = "muxdeck-theme";
export const THEME_PALETTES_STORAGE_KEY = "muxdeck-theme-palettes";
export const THEME_TOGGLE_REQUEST_EVENT = "muxdeck:toggle-theme";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  palette: ThemePaletteId;
  palettes: ThemePalettePreferences;
  setPalette: (mode: Theme, palette: ThemePaletteId) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME;

  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(storedTheme) ? storedTheme : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function readStoredPalettes(): ThemePalettePreferences {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(THEME_PALETTES_STORAGE_KEY) ?? "null");
    if (!stored || typeof stored !== "object") return { ...DEFAULT_THEME_PALETTES };
    const values = stored as Record<string, unknown>;
    return {
      dark: isThemePaletteForMode(values.dark, "dark") ? values.dark : DEFAULT_THEME_PALETTES.dark,
      light: isThemePaletteForMode(values.light, "light") ? values.light : DEFAULT_THEME_PALETTES.light,
    };
  } catch {
    return { ...DEFAULT_THEME_PALETTES };
  }
}

function storeTheme(theme: Theme, palettes: ThemePalettePreferences): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    window.localStorage.setItem(THEME_PALETTES_STORAGE_KEY, JSON.stringify(palettes));
  } catch {
    // Theme selection still works for this page when storage is unavailable.
  }
}

function applyTheme(theme: Theme, palette: ThemePaletteId): void {
  if (typeof document === "undefined") return;

  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.palette = palette;
  document.documentElement.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", getThemePalette(palette).background);
}

export function requestThemeToggle(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(THEME_TOGGLE_REQUEST_EVENT));
}

export function ThemeProvider({ children }: PropsWithChildren) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [palettes, setPalettes] = useState<ThemePalettePreferences>(readStoredPalettes);
  const palette = palettes[theme];

  useLayoutEffect(() => {
    applyTheme(theme, palette);
    storeTheme(theme, palettes);
  }, [theme, palette, palettes]);

  const setTheme = useCallback((nextTheme: Theme) => {
    setThemeState(nextTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((currentTheme) => (currentTheme === "dark" ? "light" : "dark"));
  }, []);

  const setPalette = useCallback((mode: Theme, nextPalette: ThemePaletteId) => {
    if (!isThemePaletteForMode(nextPalette, mode)) return;
    setPalettes((current) => ({ ...current, [mode]: nextPalette }));
    setThemeState(mode);
  }, []);

  useEffect(() => {
    window.addEventListener(THEME_TOGGLE_REQUEST_EVENT, toggleTheme);
    return () => window.removeEventListener(THEME_TOGGLE_REQUEST_EVENT, toggleTheme);
  }, [toggleTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, palette, palettes, setPalette }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within a ThemeProvider");
  return context;
}

export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext);
}
