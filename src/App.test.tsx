import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_PATH } from "./api";
import { App } from "./App";

vi.mock("./components/SessionDashboard", () => ({
  SessionDashboard: ({ onOpen }: { onOpen: (session: string) => void }) => (
    <main aria-label="Dashboard" data-search={window.location.search}>
      <button type="button" onClick={() => onOpen("work/name #1")}>Open test session</button>
    </main>
  ),
}));

vi.mock("./components/ConsoleScreen", () => ({
  ConsoleScreen: ({
    sessionName,
    onBack,
  }: {
    sessionName: string;
    onBack: () => void;
  }) => (
    <main aria-label="Console">
      <span>{sessionName}</span>
      <button type="button" onClick={onBack}>Back to sessions</button>
    </main>
  ),
}));

function dashboardUrl(search = ""): string {
  return `${BASE_PATH}/${search}`;
}

function sessionUrl(encodedName: string, search = ""): string {
  return `${BASE_PATH}/session/${encodedName}${search}`;
}

function replaceUrl(url: string): void {
  window.history.replaceState({}, "", url);
}

describe("App routing", () => {
  beforeEach(() => {
    replaceUrl(dashboardUrl());
  });

  it("preserves dashboard query state when opening a session and using application Back", async () => {
    const search = "?kind=claude&state=working&sort=state&sort=title";
    replaceUrl(dashboardUrl(search));
    render(<App />);

    expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute("data-search", search);

    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));

    expect(screen.getByRole("main", { name: "Console" })).toBeVisible();
    expect(screen.getByText("work/name #1")).toBeVisible();
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/work%2Fname%20%231`);
    expect(window.location.search).toBe(search);

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));

    await waitFor(() => {
      expect(window.location.pathname).toBe(`${BASE_PATH}/`);
      expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute("data-search", search);
    });
    expect(window.location.search).toBe(search);
  });

  it("replaces a directly opened session deep link with the dashboard fallback", () => {
    const search = "?kind=codex&sort=title";
    replaceUrl(sessionUrl("direct%20work", search));
    render(<App />);

    expect(screen.getByRole("main", { name: "Console" })).toBeVisible();
    expect(screen.getByText("direct work")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));

    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
    expect(window.location.search).toBe(search);
    expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute("data-search", search);
  });

  it("responds to query-only navigation and browser Back and Forward", async () => {
    const claudeSearch = "?kind=claude&sort=state&sort=title";
    const codexSearch = "?kind=codex&sort=title&sort=state";
    replaceUrl(dashboardUrl(claudeSearch));
    render(<App />);

    expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute(
      "data-search",
      claudeSearch,
    );

    act(() => {
      window.history.pushState({}, "", dashboardUrl(codexSearch));
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute(
      "data-search",
      codexSearch,
    );

    act(() => window.history.back());
    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute(
        "data-search",
        claudeSearch,
      );
    });

    act(() => window.history.forward());
    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute(
        "data-search",
        codexSearch,
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));
    expect(screen.getByRole("main", { name: "Console" })).toBeVisible();

    act(() => window.history.back());
    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute(
        "data-search",
        codexSearch,
      );
    });

    act(() => window.history.forward());
    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Console" })).toBeVisible();
    });
    expect(window.location.search).toBe(codexSearch);
  });
});
