import { describe, expect, it } from "vitest";
import type { Pane } from "./types";
import { sessionHasOnlyDeadPanes } from "./sessionLifecycle";

describe("sessionHasOnlyDeadPanes", () => {
  it.each([
    { name: "missing session", session: undefined, dead: false },
    { name: "null session", session: null, dead: false },
    { name: "no pane inventory", session: { panes: [] }, dead: false },
    { name: "idle shell", session: { panes: [{ dead: false } as Pane] }, dead: false },
    { name: "retained exited command", session: { panes: [{ dead: true } as Pane] }, dead: true },
    { name: "live pane beside an exited pane", session: { panes: [{ dead: true }, { dead: false }] as Pane[] }, dead: false },
    { name: "live pane in another window", session: { panes: [{ dead: true, window_index: 0 }, { dead: false, window_index: 1 }] as Pane[] }, dead: false },
    { name: "all windows exited", session: { panes: [{ dead: true, window_index: 0 }, { dead: true, window_index: 1 }] as Pane[] }, dead: true },
  ])("classifies $name", ({ session, dead }) => {
    expect(sessionHasOnlyDeadPanes(session)).toBe(dead);
  });
});
