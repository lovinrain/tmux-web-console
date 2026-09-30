import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTheme, type Theme } from "../theme";
import { THEME_PALETTES } from "../themePresets";

export function ThemePicker({ onClose }: { onClose: () => void }) {
  const { palettes, setPalette, setTheme } = useTheme();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="theme-picker-dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={onClose}
      onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="theme-picker-header">
        <h2 id={`${id}-title`}>Themes</h2>
        <button className="theme-picker-close" type="button" aria-label="Close themes" autoFocus onClick={onClose}>×</button>
      </div>
      <p id={`${id}-description`} className="theme-picker-intro">
        Choose a look for each mode. Selecting a theme previews it now; the light toggle remembers both choices.
      </p>
      {(["dark", "light"] as Theme[]).map((mode) => (
        <fieldset key={mode}>
          <legend>{mode === "dark" ? "Dark themes" : "Light themes"}</legend>
          <div className="theme-picker-options">
            {THEME_PALETTES.filter((palette) => palette.mode === mode).map((palette) => (
              <label className="theme-picker-option" key={palette.id}>
                <input
                  type="radio"
                  name={`${id}-${mode}`}
                  checked={palettes[mode] === palette.id}
                  onClick={() => setTheme(mode)}
                  onChange={() => setPalette(mode, palette.id)}
                />
                <span className="theme-picker-swatches" aria-hidden="true">
                  {[palette.background, palette.foreground, palette.accent].map((color) => (
                    <span key={color} style={{ background: color }} />
                  ))}
                </span>
                <span className="theme-picker-name">{palette.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </dialog>,
    document.body,
  );
}
