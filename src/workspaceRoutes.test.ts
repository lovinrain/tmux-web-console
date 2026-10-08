import { describe, expect, it } from "vitest";
import {
  isWorkspaceRoute,
  newSessionPath,
  paneLayoutPath,
  parseNewSessionRoute,
  parsePaneLayoutRoute,
  parseSessionRoute,
  sessionPath,
} from "./workspaceRoutes";

describe("workspace routes", () => {
  it.each(["alpha", "a/b", "space name", "unicode-你好", "name/recents", "%malformed"])(
    "round-trips session names and their overview route: %s", (name) => {
      expect(parseSessionRoute(sessionPath(name))).toEqual({ sessionName: name, recentsOpen: false });
      expect(parseSessionRoute(sessionPath(name, true))).toEqual({ sessionName: name, recentsOpen: true });
    },
  );

  it("accepts existing trailing-slash links and malformed percent escapes", () => {
    expect(parseSessionRoute("/session/alpha/recents/")).toEqual({ sessionName: "alpha", recentsOpen: true });
    expect(parseSessionRoute("/session/%invalid")).toEqual({ sessionName: "%invalid", recentsOpen: false });
    expect(parseNewSessionRoute("/sessions/new/recents/")).toEqual({ recentsOpen: true });
    expect(parsePaneLayoutRoute("/panes/layout%invalid/")).toEqual({ layoutId: "layout%invalid" });
  });

  it("keeps New session and pane-layout paths independent", () => {
    expect(parseNewSessionRoute(newSessionPath())).toEqual({ recentsOpen: false });
    expect(parseNewSessionRoute(newSessionPath(true))).toEqual({ recentsOpen: true });
    expect(parsePaneLayoutRoute(paneLayoutPath("layout/a b"))).toEqual({ layoutId: "layout/a b" });
    expect(parseSessionRoute(newSessionPath())).toBeNull();
    expect(parseSessionRoute(paneLayoutPath("layout"))).toBeNull();
  });

  it.each([
    ["/session/alpha", true],
    ["/session/alpha/recents", true],
    ["/sessions/new", true],
    ["/sessions/new/recents", true],
    ["/panes/layout", true],
    ["/", false],
    ["/settings", false],
    ["/session/", false],
    ["/panes/", false],
    ["/sessions/newer", false],
  ])("recognizes workspace route %s: %s", (path, expected) => {
    expect(isWorkspaceRoute(path as string)).toBe(expected);
  });
});
