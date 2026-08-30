import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import {
  cloneShortcutBindings,
  DEFAULT_SHORTCUT_BINDINGS,
  SHORTCUT_DEFINITIONS,
  canonicalShortcutCode,
  shortcutCodeLabel,
  shortcutConflictMessages,
  useShortcutSettings,
  type ShortcutActionId,
  type ShortcutBindings,
} from "../shortcutSettings";
import { CloseIcon, KeyboardIcon, RefreshIcon, SaveIcon } from "../icons";

interface ShortcutSettingsDialogProps {
  onClose: () => void;
}

type ShortcutLayer = "direct" | "launcher";

interface RecordingTarget {
  action: ShortcutActionId;
  layer: ShortcutLayer;
}

function bindingsEqual(left: ShortcutBindings, right: ShortcutBindings): boolean {
  return SHORTCUT_DEFINITIONS.every((definition) => {
    const action = definition.id as ShortcutActionId;
    return left[action].direct === right[action].direct
      && left[action].launcher === right[action].launcher;
  });
}

export function ShortcutSettingsDialog({ onClose }: ShortcutSettingsDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const {
    bindings,
    revision,
    status,
    error,
    save,
    reload,
  } = useShortcutSettings();
  const [draft, setDraft] = useState(() => cloneShortcutBindings(bindings));
  const [recording, setRecording] = useState<RecordingTarget | null>(null);
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const conflicts = useMemo(() => shortcutConflictMessages(draft), [draft]);
  const changed = !bindingsEqual(draft, bindings);

  useEffect(() => {
    const releaseBodyScroll = acquireBodyScrollLock();
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (recordingRef.current) setRecording(null);
        else onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleDialogKeyDown, true);
      releaseBodyScroll();
    };
  }, [onClose]);

  useEffect(() => {
    if (status !== "ready" || changed) return;
    setDraft(cloneShortcutBindings(bindings));
  }, [bindings, changed, status]);

  const setBinding = (
    action: ShortcutActionId,
    layer: ShortcutLayer,
    code: string | null,
  ) => {
    setDraft((current) => ({
      ...current,
      [action]: { ...current[action], [layer]: code },
    }));
    setSaved(false);
    setSaveError(null);
  };

  const captureKey = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    action: ShortcutActionId,
    layer: ShortcutLayer,
  ) => {
    if (recording?.action !== action || recording.layer !== layer) return;
    if (event.key === "Tab" || ["Control", "Shift", "Alt", "Meta"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Backspace" || event.key === "Delete") {
      setBinding(action, layer, null);
      setRecording(null);
      return;
    }
    const code = canonicalShortcutCode(event.code);
    if (!code) return;
    setBinding(action, layer, code);
    setRecording(null);
  };

  const saveDraft = async () => {
    if (conflicts.length > 0 || status === "loading" || status === "saving") return;
    setSaveError(null);
    setSaved(false);
    try {
      await save(draft);
      setSaved(true);
    } catch (saveFailure) {
      setSaveError(saveFailure instanceof Error
        ? saveFailure.message
        : "Unable to save shortcut settings.");
    }
  };

  const groups = ["Open", "Session", "Terminal", "View", "Tabs"] as const;

  return createPortal(
    <div
      className="workspace-tab-search-backdrop shortcut-settings-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={dialogRef}
        className="workspace-tab-search-dialog shortcut-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="workspace-tab-search-header shortcut-settings-header">
          <div>
            <p className="eyebrow">GLOBAL KEYMAP</p>
            <h2 id={titleId}>Customize shortcuts</h2>
          </div>
          <div className="shortcut-settings-header-meta">
            <span>Revision {revision}</span>
            <button
              ref={closeRef}
              type="button"
              className="workspace-keymap-close"
              aria-label="Close shortcut settings"
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </div>
        </header>

        <p id={descriptionId} className="shortcut-settings-intro">
          Click a key tile, then press the replacement key. Direct bindings use
          <kbd>Ctrl</kbd><kbd>Shift</kbd>; window bindings run after you open the
          shortcut window. Backspace clears a binding.
        </p>

        {(status === "unavailable" || error || saveError) && (
          <div className="shortcut-settings-alert" role="alert">
            <strong>Shortcut settings are not synced.</strong>
            <span>{saveError || error || "The backend is unavailable."}</span>
            <button type="button" onClick={() => void reload()}>
              <RefreshIcon /> Retry
            </button>
          </div>
        )}

        {conflicts.length > 0 && (
          <div className="shortcut-settings-conflicts" role="alert">
            <strong>Resolve duplicate keys before saving.</strong>
            {conflicts.map((message) => <span key={message}>{message}</span>)}
          </div>
        )}

        <div className="shortcut-settings-scroll">
          {groups.map((group) => (
            <section className="shortcut-settings-group" key={group}>
              <header>
                <span>{group}</span>
                <small>{SHORTCUT_DEFINITIONS.filter((item) => item.group === group).length} actions</small>
              </header>
              <div className="shortcut-settings-grid" role="group" aria-label={`${group} shortcuts`}>
                {SHORTCUT_DEFINITIONS.filter((item) => item.group === group).map((definition) => {
                  const action = definition.id as ShortcutActionId;
                  const binding = draft[action];
                  return (
                    <div className="shortcut-settings-row" key={action}>
                      <span className="shortcut-settings-action">
                        <strong>{definition.label}</strong>
                        <small>{action}</small>
                      </span>
                      {(["direct", "launcher"] as const).map((layer) => {
                        const editable = layer === "direct"
                          ? definition.directEditable !== false
                          : definition.launcherEditable !== false;
                        const active = recording?.action === action
                          && recording.layer === layer;
                        return (
                          <span className="shortcut-settings-binding" key={layer}>
                            <small>{layer === "direct" ? "DIRECT" : "WINDOW"}</small>
                            <button
                              type="button"
                              className={active ? "recording" : ""}
                              disabled={!editable}
                              aria-label={`${definition.label} ${layer} key${active ? ", recording" : ""}`}
                              aria-pressed={active}
                              onClick={() => setRecording(active ? null : { action, layer })}
                              onKeyDown={(event) => captureKey(event, action, layer)}
                            >
                              {layer === "direct" && <span>Ctrl Shift</span>}
                              <kbd>{active ? "PRESS KEY" : shortcutCodeLabel(binding[layer])}</kbd>
                            </button>
                            {editable && binding[layer] && (
                              <button
                                type="button"
                                className="shortcut-settings-clear"
                                aria-label={`Clear ${definition.label} ${layer} key`}
                                onClick={() => setBinding(action, layer, null)}
                              >
                                <CloseIcon />
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <p className="shortcut-settings-browser-note">
          <KeyboardIcon /> Browsers and operating systems can reserve some direct chords.
          The one-key shortcut window remains the reliable fallback.
        </p>

        <footer className="shortcut-settings-footer">
          <span role="status" aria-live="polite">
            {saved ? "Saved for every browser." : changed ? "Unsaved changes" : "Keymap is up to date"}
          </span>
          <div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setDraft(cloneShortcutBindings(DEFAULT_SHORTCUT_BINDINGS));
                setSaved(false);
              }}
            >
              <RefreshIcon /> Defaults
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!changed || conflicts.length > 0 || status !== "ready"}
              onClick={() => void saveDraft()}
            >
              <SaveIcon /> {status === "saving" ? "Saving..." : "Save keymap"}
            </button>
          </div>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
