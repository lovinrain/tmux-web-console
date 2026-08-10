import { SnippetIcon, TerminalIcon } from "../icons";

interface AppTabsProps {
  active: "sessions" | "snippets";
  onSessions: () => void;
  onSnippets: () => void;
}

export function AppTabs({ active, onSessions, onSnippets }: AppTabsProps) {
  return (
    <nav className="app-tabs" aria-label="Muxdeck sections">
      <button
        type="button"
        className={active === "sessions" ? "active" : ""}
        aria-current={active === "sessions" ? "page" : undefined}
        onClick={onSessions}
      >
        <TerminalIcon />
        <span>Sessions</span>
      </button>
      <button
        type="button"
        className={active === "snippets" ? "active" : ""}
        aria-current={active === "snippets" ? "page" : undefined}
        onClick={onSnippets}
      >
        <SnippetIcon />
        <span>Snippets</span>
      </button>
    </nav>
  );
}
