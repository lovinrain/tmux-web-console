import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createSession } from "../api";
import { TerminalIcon } from "../icons";
import { ThemeToggle } from "./ThemeToggle";

export const NEW_SESSION_PANEL_ID = "muxdeck-new-session";

export interface NewSessionScreenProps {
  onCreated: (name: string) => void;
  onCancel: () => void;
  sessionNavigation?: ReactNode;
}

export function NewSessionScreen({
  onCreated,
  onCancel,
  sessionNavigation,
}: NewSessionScreenProps) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const mountedRef = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null);

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
    if (creatingRef.current) return;

    creatingRef.current = true;
    setCreating(true);
    setError(null);

    let sessionName: string;
    try {
      sessionName = await createSession();
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
    onCreated(sessionName);
  };

  return (
    <main className={sessionNavigation
      ? "new-session-screen has-session-navigation"
      : "new-session-screen"}
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
            aria-busy={creating}
            onSubmit={(event) => void submit(event)}
          >
            <div className="new-session-default">
              <span>DEFAULT SESSION</span>
              <strong>Fresh shell</strong>
              <p>The server assigns a unique tmux name. Nothing starts until you confirm.</p>
            </div>

            {error && <p className="new-session-error" role="alert">{error}</p>}

            <div className="new-session-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={onCancel}
                disabled={creating}
              >
                Cancel
              </button>
              <button type="submit" className="primary-button" disabled={creating}>
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
