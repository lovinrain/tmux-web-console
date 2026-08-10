import { useEffect, useState } from "react";
import { BASE_PATH } from "./api";
import { ConsoleScreen } from "./components/ConsoleScreen";
import { SessionDashboard } from "./components/SessionDashboard";
import { SnippetLibrary } from "./components/SnippetLibrary";

interface MuxLocation {
  path: string;
  search: string;
}

const FROM_DASHBOARD_KEY = "muxdeckFromDashboard";
const SNIPPETS_FROM_DASHBOARD_KEY = "muxdeckSnippetsFromDashboard";

function currentLocation(): MuxLocation {
  const path = window.location.pathname;
  const relative = BASE_PATH && path.startsWith(BASE_PATH)
    ? path.slice(BASE_PATH.length) || "/"
    : path;
  return { path: relative, search: window.location.search };
}

function targetUrl(path: string, search = window.location.search): string {
  return `${BASE_PATH}${path === "/" ? "/" : path}${search}`;
}

export function App() {
  const [location, setLocation] = useState(currentLocation);

  useEffect(() => {
    const update = () => setLocation(currentLocation());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  const openSession = (sessionName: string) => {
    window.history.pushState(
      { [FROM_DASHBOARD_KEY]: true },
      "",
      targetUrl(`/session/${encodeURIComponent(sessionName)}`),
    );
    setLocation(currentLocation());
  };

  const returnToDashboard = () => {
    const state = window.history.state as Record<string, unknown> | null;
    if (state?.[FROM_DASHBOARD_KEY] === true) {
      window.history.back();
      return;
    }

    // A directly opened console has no dashboard entry to return to.
    window.history.replaceState({}, "", targetUrl("/"));
    setLocation(currentLocation());
  };

  const openSnippets = () => {
    window.history.pushState(
      { [SNIPPETS_FROM_DASHBOARD_KEY]: true },
      "",
      targetUrl("/snippets", ""),
    );
    setLocation(currentLocation());
  };

  const returnFromSnippets = () => {
    const state = window.history.state as Record<string, unknown> | null;
    if (state?.[SNIPPETS_FROM_DASHBOARD_KEY] === true) {
      window.history.back();
      return;
    }
    window.history.replaceState({}, "", targetUrl("/", ""));
    setLocation(currentLocation());
  };

  const sessionMatch = location.path.match(/^\/session\/(.+)$/);
  if (sessionMatch) {
    let sessionName: string;
    try {
      sessionName = decodeURIComponent(sessionMatch[1]);
    } catch {
      sessionName = sessionMatch[1];
    }
    return <ConsoleScreen sessionName={sessionName} onBack={returnToDashboard} />;
  }

  if (location.path === "/snippets" || location.path === "/snippets/") {
    return <SnippetLibrary onOpenSessions={returnFromSnippets} />;
  }

  return (
    <SessionDashboard
      key={location.search}
      onOpen={openSession}
      onOpenSnippets={openSnippets}
    />
  );
}
