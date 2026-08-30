import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./components/ThemeToggle";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  ThemeProvider,
  requestThemeToggle,
  useTheme,
} from "./theme";

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
  });
});
