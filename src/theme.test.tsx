import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./components/ThemeToggle";
import {
  DEFAULT_THEME,
  THEME_PALETTES_STORAGE_KEY,
  THEME_STORAGE_KEY,
  ThemeProvider,
  requestThemeToggle,
  useTheme,
} from "./theme";
import { THEME_PALETTES } from "./themePresets";

function ThemeProbe() {
  const { theme, setTheme } = useTheme();

  return (
    <div>
      <output aria-label="Active theme">{theme}</output>
      <button type="button" onClick={() => setTheme("light")}>Set light</button>
    </div>
  );
}

function renderTheme() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
      <ThemeProbe />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.palette;
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.open = true; },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.open = false; },
  });
  document.documentElement.style.colorScheme = "";
  let themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!themeColor) {
    themeColor = document.createElement("meta");
    themeColor.name = "theme-color";
    document.head.append(themeColor);
  }
  themeColor.content = "#151914";
});

describe("ThemeProvider", () => {
  it("defaults to dark and synchronizes the root document", () => {
    renderTheme();

    expect(screen.getByRole("status", { name: "Active theme" })).toHaveTextContent(DEFAULT_THEME);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-palette", "muxdeck");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(screen.getByRole("button", { name: "Light theme" })).not.toBePressed();
    expect(screen.getByRole("button", { name: "Light theme" })).toHaveAttribute(
      "title",
      "Switch to light theme",
    );
    expect(screen.getByRole("button", { name: "Light theme" }))
      .not.toHaveAttribute("aria-keyshortcuts");
  });

  it("restores a valid persisted theme", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderTheme();

    expect(screen.getByRole("status", { name: "Active theme" })).toHaveTextContent("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("button", { name: "Light theme" })).toBePressed();
    expect(screen.getByRole("button", { name: "Light theme" })).toHaveAttribute(
      "title",
      "Switch to dark theme",
    );
  });

  it("toggles when an app command requests a theme change", () => {
    renderTheme();

    act(() => requestThemeToggle());
    expect(screen.getByRole("status", { name: "Active theme" })).toHaveTextContent("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#f4f0e7",
    );
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    act(() => requestThemeToggle());
    expect(screen.getByRole("status", { name: "Active theme" })).toHaveTextContent("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("toggles the theme and persists the new selection", () => {
    renderTheme();

    fireEvent.click(screen.getByRole("button", { name: "Light theme" }));

    expect(screen.getByRole("status", { name: "Active theme" })).toHaveTextContent("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#f4f0e7",
    );
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(screen.getByRole("button", { name: "Light theme" })).toBePressed();
  });

  it("keeps working when browser storage reads and writes throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage is blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is blocked", "SecurityError");
    });

    expect(() => renderTheme()).not.toThrow();
    expect(screen.getByRole("status", { name: "Active theme" })).toHaveTextContent("dark");

    fireEvent.click(screen.getByRole("button", { name: "Set light" }));

    expect(screen.getByRole("status", { name: "Active theme" })).toHaveTextContent("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    fireEvent.click(screen.getByRole("button", { name: "Choose themes" }));
    fireEvent.click(screen.getByRole("radio", { name: "Nord" }));
    expect(document.documentElement).toHaveAttribute("data-palette", "nord");
  });

  it.each(THEME_PALETTES)("restores $name with the correct mode and browser color", (palette) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, palette.mode);
    window.localStorage.setItem(THEME_PALETTES_STORAGE_KEY, JSON.stringify({ [palette.mode]: palette.id }));
    renderTheme();

    expect(document.documentElement).toHaveAttribute("data-theme", palette.mode);
    expect(document.documentElement).toHaveAttribute("data-palette", palette.id);
    expect(document.documentElement.style.colorScheme).toBe(palette.mode);
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", palette.background);
  });

  it.each(["not json", "null", "[]", "true", '{"dark":"paper","light":"nord"}', '{"dark":"unknown","light":"__proto__"}'])(
    "uses defaults for invalid palette storage: %s", (stored) => {
      window.localStorage.setItem(THEME_PALETTES_STORAGE_KEY, stored);
      renderTheme();
      expect(document.documentElement).toHaveAttribute("data-palette", "muxdeck");
      fireEvent.click(screen.getByRole("button", { name: "Light theme" }));
      expect(document.documentElement).toHaveAttribute("data-palette", "paper");
    },
  );

  it("remembers each mode's choice when toggling and remounting", () => {
    const firstRender = renderTheme();
    fireEvent.click(screen.getByRole("button", { name: "Choose themes" }));
    expect(screen.getByRole("dialog", { name: "Themes" })).toBeVisible();
    fireEvent.click(screen.getByRole("radio", { name: "Nord" }));
    expect(document.documentElement).toHaveAttribute("data-palette", "nord");
    fireEvent.click(screen.getByRole("radio", { name: "Solarized Light" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement).toHaveAttribute("data-palette", "solarized-light");
    expect(JSON.parse(window.localStorage.getItem(THEME_PALETTES_STORAGE_KEY)!)).toEqual({
      dark: "nord", light: "solarized-light",
    });
    fireEvent.click(screen.getByRole("button", { name: "Close themes" }));
    expect(screen.queryByRole("dialog", { name: "Themes" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Light theme" }));
    expect(document.documentElement).toHaveAttribute("data-palette", "nord");
    act(() => requestThemeToggle());
    expect(document.documentElement).toHaveAttribute("data-palette", "solarized-light");

    firstRender.unmount();
    renderTheme();
    expect(document.documentElement).toHaveAttribute("data-palette", "solarized-light");
    fireEvent.click(screen.getByRole("button", { name: "Light theme" }));
    expect(document.documentElement).toHaveAttribute("data-palette", "nord");
  });

  it("previews an already selected theme from the other mode", () => {
    renderTheme();
    fireEvent.click(screen.getByRole("button", { name: "Choose themes" }));
    const paper = screen.getByRole("radio", { name: "Paper" });
    expect(paper).toBeChecked();
    fireEvent.click(paper);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement).toHaveAttribute("data-palette", "paper");
  });
});
