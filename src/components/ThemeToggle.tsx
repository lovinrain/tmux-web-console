import { useState } from "react";
import { useTheme } from "../theme";
import { ThemePicker } from "./ThemePicker";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const [pickerOpen, setPickerOpen] = useState(false);
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <div className="theme-controls">
      <button
        type="button"
        className="theme-toggle"
        aria-pressed={theme === "light"}
        title={`Switch to ${nextTheme} theme`}
        onClick={toggleTheme}
      >
        {theme === "dark" ? (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
            <path
              d="M20 15.4A8.5 8.5 0 0 1 8.6 4a8.5 8.5 0 1 0 11.4 11.4Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        )}
        <span>Light theme</span>
      </button>
      <button
        type="button"
        className="theme-chooser-button"
        aria-label="Choose themes"
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        title="Choose light and dark themes"
        onClick={() => setPickerOpen(true)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 0 18h1.2a2.3 2.3 0 0 0 1.5-4c-.5-.4-.7-1-.5-1.5.2-.6.7-1 1.3-1H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3Z" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="7" cy="10" r="1" fill="currentColor" />
          <circle cx="10" cy="7" r="1" fill="currentColor" />
          <circle cx="14" cy="7" r="1" fill="currentColor" />
          <circle cx="17" cy="10" r="1" fill="currentColor" />
        </svg>
        <span>Themes</span>
      </button>
      {pickerOpen && <ThemePicker onClose={() => setPickerOpen(false)} />}
    </div>
  );
}
