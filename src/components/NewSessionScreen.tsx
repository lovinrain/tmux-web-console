import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createSession, type CreatedSession } from "../api";
import { TerminalIcon } from "../icons";
import { useTheme } from "../theme";
import type { WorkspaceTabOrientation } from "./SessionWorkspaceNavigation";
import { ThemeToggle } from "./ThemeToggle";

export const NEW_SESSION_PANEL_ID = "muxdeck-new-session";
const MAX_SESSION_NAME_LENGTH = 256;

function sessionNameError(name: string): string | null {
  if (!name) return null;
  if (!name.trim()) {
    return "A custom session name cannot be blank. Clear the field to use an assigned name.";
  }
  if (name.length > MAX_SESSION_NAME_LENGTH) {
    return `A tmux session name must be ${MAX_SESSION_NAME_LENGTH} characters or fewer.`;
  }
  if (name.includes(":") || name.includes(".")) {
    return "A tmux session name cannot contain a colon or period.";
  }
  if (name.includes("\\")) {
    return "A tmux session name cannot contain a backslash.";
  }
  if (name.endsWith(";")) {
    return "A tmux session name cannot end with a semicolon.";
  }
  return null;
}

export interface NewSessionScreenProps {
  onCreated: (name: string, sessionId: string) => void;
  onCancel: () => void;
  sessionNavigation?: ReactNode;
  workspaceLoading?: boolean;
  desktopTabOrientation?: WorkspaceTabOrientation;
}

export function NewSessionScreen({
  onCreated,
  onCancel,
  sessionNavigation,
  workspaceLoading = false,
  desktopTabOrientation = "horizontal",
}: NewSessionScreenProps) {
  const { theme } = useTheme();
  const [draftName, setDraftName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const mountedRef = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameError = sessionNameError(draftName);

  useEffect(() => {
    mountedRef.current = true;
    document.title = "New session - Muxdeck";
    headingRef.current?.focus();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!creating) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [creating]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creatingRef.current || workspaceLoading || nameError) return;

    creatingRef.current = true;
    setCreating(true);
    setError(null);

    let createdSession: CreatedSession;
    try {
      createdSession = draftName === ""
        ? await createSession(undefined, theme)
        : await createSession(draftName, theme);
    } catch (creationError) {
      if (!mountedRef.current) return;
      creatingRef.current = false;
      setCreating(false);
      setError(
        creationError instanceof Error
          ? creationError.message
          : "Unable to create a tmux session",
      );
      return;
    }

    if (mountedRef.current) {
      creatingRef.current = false;
      setCreating(false);
    }
    onCreated(createdSession.name, createdSession.id);
  };

  return (
    <main className={sessionNavigation
      ? "new-session-screen has-session-navigation"
      : "new-session-screen"}
      data-desktop-tabs={desktopTabOrientation}
    >
      {sessionNavigation && (
        <div className="console-session-navigation">{sessionNavigation}</div>
      )}
      <section
        id={NEW_SESSION_PANEL_ID}
        className="new-session-panel"
        role={sessionNavigation ? "tabpanel" : undefined}
        aria-labelledby="new-session-heading"
      >
        <div className="new-session-theme"><ThemeToggle /></div>
        <div className="new-session-card">
          <header className="new-session-card-header">
            <span className="new-session-mark"><TerminalIcon /></span>
            <div>
              <p className="eyebrow">NEW TMUX WORKSPACE</p>
              <h1 id="new-session-heading" ref={headingRef} tabIndex={-1}>
                Start a new session.
              </h1>
              <p>
                Muxdeck will start a detached shell on this tmux server, then open it
                as the active tab in this browser workspace.
              </p>
            </div>
          </header>

          <form
            className="new-session-form"
            aria-busy={creating || workspaceLoading}
            onSubmit={(event) => void submit(event)}
          >
            <div className="new-session-default">
              <span>DEFAULT SESSION</span>
              <strong>Fresh shell</strong>
              <p>
                Name it below or let the server assign one. On tmux 3.2+, Grok
                Build launched here follows the current {theme} appearance.
              </p>
            </div>

            <div className="new-session-name-field">
              <label htmlFor="new-session-name-input">
                TMUX SESSION NAME
                <em>OPTIONAL</em>
              </label>
              <input
                id="new-session-name-input"
                name="session-name"
                value={draftName}
                maxLength={MAX_SESSION_NAME_LENGTH}
                disabled={creating}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="muxdeck-generated-name"
                aria-describedby={nameError
                  ? "new-session-name-hint new-session-name-error"
                  : "new-session-name-hint"}
                aria-invalid={nameError ? "true" : undefined}
                onChange={(event) => {
                  setDraftName(event.target.value);
                  setError(null);
                }}
              />
              <small id="new-session-name-hint">
                Leave blank for an assigned name. Colons, periods, backslashes, and a
                final semicolon are not allowed; leading and trailing spaces are preserved.
              </small>
            </div>

            {nameError && (
              <p id="new-session-name-error" className="new-session-error" role="alert">
                {nameError}
              </p>
            )}
            {error && <p className="new-session-error" role="alert">{error}</p>}
            {workspaceLoading && (
              <p className="new-session-waiting" role="status">
                Opening the saved workspace. Create becomes available when its tabs are ready.
              </p>
            )}

            <div className="new-session-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={onCancel}
                disabled={creating}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={creating || workspaceLoading || Boolean(nameError)}
              >
                <TerminalIcon />
                {creating ? "Creating..." : "Create session"}
              </button>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
