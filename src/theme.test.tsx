import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./components/ThemeToggle";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  ThemeProvider,
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
      "Switch to light theme (Ctrl+Shift+H)",
    );
    expect(screen.getByRole("button", { name: "Light theme" })).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+Shift+H",
    );
  });

  it("restores a valid persisted theme", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderTheme();

    expect(screen.getByRole("status", { name: "Active theme" })).toHaveTextContent("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("button", { name: "Light theme" })).toBePressed();
    expect(screen.getByRole("button", { name: "Light theme" })).toHaveAttribute(
      "title",
      "Switch to dark theme (Ctrl+Shift+H)",
    );
  });

  it("toggles globally with the exact Ctrl+Shift+H chord", () => {
    renderTheme();
    const shortcut = {
      key: "T",
      code: "KeyH",
      ctrlKey: true,
      shiftKey: true,
    };

    expect(fireEvent.keyDown(window, shortcut)).toBe(false);
    expect(screen.getByRole("status", { name: "Active theme" })).toHaveTextContent("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#f4f0e7",
    );
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    expect(fireEvent.keyDown(window, { ...shortcut, repeat: true })).toBe(false);
    expect(screen.getByRole("status", { name: "Active theme" })).toHaveTextContent("light");

    expect(fireEvent.keyDown(window, shortcut)).toBe(false);
    expect(screen.getByRole("status", { name: "Active theme" })).toHaveTextContent("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    for (const modifiers of [
      { ctrlKey: false },
      { shiftKey: false },
      { altKey: true },
      { metaKey: true },
      { isComposing: true },
    ]) {
      expect(fireEvent.keyDown(window, { ...shortcut, ...modifiers })).toBe(true);
      expect(screen.getByRole("status", { name: "Active theme" })).toHaveTextContent("dark");
    }
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
