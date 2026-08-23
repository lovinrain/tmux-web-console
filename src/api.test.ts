import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASE_PATH,
  ApiRequestError,
  createQueuedMessage,
  createSession,
  createWorkspace,
  deleteQueuedMessage,
  deleteWorkspace,
  getCommonWorkspaceQuickLinks,
  getWorkspace,
  getWorkspaceQuickLinks,
  getSnippetTree,
  listQueuedMessages,
  renameSession,
  replaceCommonWorkspaceQuickLinks,
  replaceWorkspaceQuickLinks,
  saveSnippetTree,
  subscribeToSessions,
  terminateSession,
  updateSessionIgnored,
  updateSessionStar,
  updateSessionDetails,
  updateSessionTags,
  updateQueuedMessage,
  updateWorkspace,
  updateWorkspaceActivity,
  listWorkspaces,
} from "./api";
import type { Session } from "./types";

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();
  private listeners = new Map<string, Set<EventListener>>();

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function session(): Session {
  return {
    name: "work",
    id: "$1",
    windows: 1,
    attached: 0,
    created: 1,
    serverStarted: 10,
    serverPid: 100,
    activity: 2,
    activePaneId: null,
    agentState: "working",
    agentStateReason: "Agent is running",
    agentStateChangedAt: 3,
    customTitle: null,
    tags: [],
    starred: false,
    ignored: false,
    queuedMessageCount: 0,
    panes: [],
  };
}

afterEach(() => {
  MockEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe("session creation API", () => {
  it("creates a default session with an explicit empty JSON object", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: "muxdeck-abc123def456",
      sessionId: "$12",
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSession()).resolves.toEqual({
      name: "muxdeck-abc123def456",
      id: "$12",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/sessions`,
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("sends an exact requested native session name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: "  work/session #1  ",
      sessionId: "$13",
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSession("  work/session #1  ")).resolves.toEqual({
      name: "  work/session #1  ",
      id: "$13",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/sessions`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "  work/session #1  " }),
      }),
    );
  });

  it("passes the browser theme for deterministic Grok startup", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: "grok-work",
      sessionId: "$14",
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSession("grok-work", "light")).resolves.toEqual({
      name: "grok-work",
      id: "$14",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/sessions`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "grok-work", theme: "light" }),
      }),
    );
  });

  it("retries without a theme when an older backend rejects that field", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "unknown field: theme",
      }), { status: 400, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session: "mixed-release-work",
        sessionId: "$15",
      }), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSession("mixed-release-work", "dark")).resolves.toEqual({
      name: "mixed-release-work",
      id: "$15",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${BASE_PATH}/api/sessions`,
      expect.objectContaining({
        body: JSON.stringify({ name: "mixed-release-work", theme: "dark" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${BASE_PATH}/api/sessions`,
      expect.objectContaining({
        body: JSON.stringify({ name: "mixed-release-work" }),
      }),
    );
  });

  it("preserves the server error and status when creation fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "unable to create tmux session",
    }), { status: 503, headers: { "Content-Type": "application/json" } })));

    const error = await createSession().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      message: "unable to create tmux session",
      status: 503,
    });
  });

  it("preserves a duplicate-name conflict", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "duplicate session: existing",
    }), { status: 409, headers: { "Content-Type": "application/json" } })));

    const error = await createSession("existing").catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      message: "duplicate session: existing",
      status: 409,
    });
  });
});

describe("session termination API", () => {
  it("terminates the encoded native session by stable id and accepts an empty response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(terminateSession(
      "work/name #1",
      "$17",
      1_700_000_000,
      1_699_999_900,
      4321,
    )).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/sessions/work%2Fname%20%231`,
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({
          sessionId: "$17",
          sessionCreated: 1_700_000_000,
          serverStarted: 1_699_999_900,
          serverPid: 4321,
        }),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("preserves the server error and status when termination fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "tmux session identity changed",
    }), { status: 409, headers: { "Content-Type": "application/json" } })));

    const error = await terminateSession("work", "$1", 1, 10, 100)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      message: "tmux session identity changed",
      status: 409,
    });
  });
});

describe("native session rename API", () => {
  it("renames the tmux session separately from its display title", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: " new work ",
      previousSession: "old/work",
      warnings: ["unable to migrate memo entries"],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(renameSession("old/work", " new work ")).resolves.toEqual({
      previousSession: "old/work",
      session: " new work ",
      warnings: ["unable to migrate memo entries"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/session-name`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ session: "old/work", name: " new work " }),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("normalizes an omitted warning list without discarding rename identity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: "after",
      previousSession: "before",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(renameSession("before", "after")).resolves.toEqual({
      previousSession: "before",
      session: "after",
      warnings: [],
    });
  });
});

describe("session attention API", () => {
  it("updates mutually exclusive starred and ignored metadata", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session: "work/name",
        starred: true,
        ignored: false,
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session: "work/name",
        starred: false,
        ignored: true,
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateSessionStar("work/name", true)).resolves.toEqual({
      starred: true,
      ignored: false,
    });
    await expect(updateSessionIgnored("work/name", true)).resolves.toEqual({
      starred: false,
      ignored: true,
    });

    expect(fetchMock.mock.calls[0]).toEqual([
      `${BASE_PATH}/api/session-star`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ session: "work/name", starred: true }),
      }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      `${BASE_PATH}/api/session-ignored`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ session: "work/name", ignored: true }),
      }),
    ]);
  });
});

describe("session tags API", () => {
  it("replaces the predefined tag set and returns canonical server order", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: "work/name",
      tags: ["work", "urgent"],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateSessionTags("work/name", ["urgent", "work"]))
      .resolves.toEqual(["work", "urgent"]);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/session-tags`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ session: "work/name", tags: ["urgent", "work"] }),
      }),
    );
  });

  it("updates title and tags atomically when both details changed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: "work/name",
      customTitle: "Release review",
      tags: ["work", "urgent"],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateSessionDetails(
      "work/name",
      "Release review",
      ["urgent", "work"],
    )).resolves.toEqual({
      customTitle: "Release review",
      tags: ["work", "urgent"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/session-details`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          session: "work/name",
          title: "Release review",
          tags: ["urgent", "work"],
        }),
      }),
    );
  });
});

describe("saved workspace API", () => {
  const workspace = {
    id: "workspace/id",
    name: "Release train",
    tabs: ["api", "web client"],
    groups: [],
    activeSession: "web client",
    sessionRevision: 7,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_010_000,
    lastActiveAt: 1_700_000_020_000,
  };

  it("lists and loads saved workspaces", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaces: [workspace] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspace }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listWorkspaces()).resolves.toEqual([workspace]);
    await expect(getWorkspace("workspace/id")).resolves.toEqual(workspace);

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_PATH}/api/workspaces`);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${BASE_PATH}/api/workspaces/workspace%2Fid`,
    );
  });

  it("loads and replaces common and workspace-specific quick links", async () => {
    const common = [{ id: "docs", label: "Docs", url: "https://docs.test/" }];
    const workspaceLinks = [
      { id: "ticket", label: "Ticket", url: "https://issues.test/42" },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ links: common }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ links: workspaceLinks }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ links: common }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ links: workspaceLinks }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCommonWorkspaceQuickLinks()).resolves.toEqual(common);
    await expect(getWorkspaceQuickLinks("workspace/id")).resolves.toEqual(workspaceLinks);
    await expect(replaceCommonWorkspaceQuickLinks(common)).resolves.toEqual(common);
    await expect(replaceWorkspaceQuickLinks("workspace/id", workspaceLinks))
      .resolves.toEqual(workspaceLinks);

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_PATH}/api/workspace-quick-links`);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${BASE_PATH}/api/workspaces/workspace%2Fid/quick-links`,
    );
    expect(fetchMock.mock.calls[2]).toEqual([
      `${BASE_PATH}/api/workspace-quick-links`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ links: common }),
      }),
    ]);
    expect(fetchMock.mock.calls[3]).toEqual([
      `${BASE_PATH}/api/workspaces/workspace%2Fid/quick-links`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ links: workspaceLinks }),
      }),
    ]);
  });

  it("creates a workspace with its ordered tabs and active session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ workspace }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const input = {
      name: "Release train",
      tabs: ["api", "web client"],
      groups: [],
      activeSession: "web client",
    };
    await expect(createWorkspace(input)).resolves.toEqual(workspace);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/workspaces`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  });

  it("retries workspace creation without groups for a pre-group backend", async () => {
    const legacyWorkspace = {
      id: workspace.id,
      name: workspace.name,
      tabs: workspace.tabs,
      activeSession: workspace.activeSession,
      sessionRevision: workspace.sessionRevision,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      lastActiveAt: workspace.lastActiveAt,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "unknown field: groups",
      }), { status: 400, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspace: legacyWorkspace }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const input = {
      name: "Release train",
      tabs: ["api", "web client"],
      groups: [],
      activeSession: "web client",
    };
    await expect(createWorkspace(input)).resolves.toEqual(legacyWorkspace);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${BASE_PATH}/api/workspaces`,
      expect.objectContaining({ body: JSON.stringify(input) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${BASE_PATH}/api/workspaces`,
      expect.objectContaining({
        body: JSON.stringify({
          name: "Release train",
          tabs: ["api", "web client"],
          activeSession: "web client",
        }),
      }),
    );
  });

  it("does not retry unrelated workspace creation validation errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "groups[0].tabs cannot be empty",
    }), { status: 400, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createWorkspace({
      name: "Release train",
      tabs: ["api"],
      groups: [],
      activeSession: "api",
    })).rejects.toMatchObject({
      status: 400,
      message: "groups[0].tabs cannot be empty",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("separates metadata updates from last-active updates", async () => {
    const renamed = { ...workspace, name: "Launch room" };
    const active = { ...renamed, tabs: ["api"], activeSession: "api" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspace: renamed }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspace: active }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateWorkspace("workspace/id", { name: "Launch room" }))
      .resolves.toEqual(renamed);
    await expect(updateWorkspaceActivity("workspace/id", ["api"], [], "api", 7))
      .resolves.toEqual(active);

    expect(fetchMock.mock.calls[0]).toEqual([
      `${BASE_PATH}/api/workspaces/workspace%2Fid`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "Launch room" }),
      }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      `${BASE_PATH}/api/workspaces/workspace%2Fid/activity`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          tabs: ["api"],
          groups: [],
          activeSession: "api",
          sessionRevision: 7,
        }),
      }),
    ]);
  });

  it("retries workspace activity without groups for a pre-group backend", async () => {
    const legacyWorkspace = {
      id: workspace.id,
      name: workspace.name,
      tabs: ["api"],
      activeSession: "api",
      sessionRevision: workspace.sessionRevision,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      lastActiveAt: workspace.lastActiveAt,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "unknown field: groups",
      }), { status: 400, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspace: legacyWorkspace }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateWorkspaceActivity("workspace/id", ["api"], [], "api", 7))
      .resolves.toEqual(legacyWorkspace);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${BASE_PATH}/api/workspaces/workspace%2Fid/activity`,
      expect.objectContaining({
        body: JSON.stringify({
          tabs: ["api"],
          groups: [],
          activeSession: "api",
          sessionRevision: 7,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${BASE_PATH}/api/workspaces/workspace%2Fid/activity`,
      expect.objectContaining({
        body: JSON.stringify({
          tabs: ["api"],
          activeSession: "api",
          sessionRevision: 7,
        }),
      }),
    );
  });

  it("propagates a failed legacy activity retry without issuing a third request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "unknown field: groups",
      }), { status: 400, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "workspace storage unavailable",
      }), { status: 503, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateWorkspaceActivity("workspace/id", ["api"], [], "api", 7))
      .rejects.toMatchObject({
        status: 503,
        message: "workspace storage unavailable",
      });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("omits unsupported groups without retrying and preserves other activity errors", async () => {
    const active = { ...workspace, tabs: ["api"], activeSession: "api" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspace: active }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "groups[0].tabs cannot be empty",
      }), { status: 400, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateWorkspaceActivity("workspace/id", ["api"], undefined, "api", 7))
      .resolves.toEqual(active);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${BASE_PATH}/api/workspaces/workspace%2Fid/activity`,
      expect.objectContaining({
        body: JSON.stringify({
          tabs: ["api"],
          activeSession: "api",
          sessionRevision: 7,
        }),
      }),
    );

    await expect(updateWorkspaceActivity("workspace/id", ["api"], [], "api", 7))
      .rejects.toMatchObject({
        status: 400,
        message: "groups[0].tabs cannot be empty",
      });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deletes an encoded workspace id and accepts an empty response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteWorkspace("workspace/id")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/workspaces/workspace%2Fid`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("subscribeToSessions", () => {
  it("subscribes at the configured base path and delivers session events", () => {
    vi.stubGlobal("EventSource", MockEventSource);
    const onSessions = vi.fn();
    const onStatus = vi.fn();

    const unsubscribe = subscribeToSessions({ onSessions, onStatus });
    const source = MockEventSource.instances[0];

    expect(source.url).toBe(`${BASE_PATH}/api/sessions/stream`);
    expect(onStatus).toHaveBeenCalledWith("connecting");
    source.onopen?.(new Event("open"));
    expect(onStatus).toHaveBeenLastCalledWith("open");

    const sessions = [session()];
    source.emit("sessions", new MessageEvent("sessions", {
      data: JSON.stringify({ sessions }),
    }));
    expect(onSessions).toHaveBeenCalledWith(sessions);

    unsubscribe();
    unsubscribe();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("reports malformed events and continues handling later updates", () => {
    vi.stubGlobal("EventSource", MockEventSource);
    const onSessions = vi.fn();
    const onStatus = vi.fn();
    const onError = vi.fn();

    subscribeToSessions({ onSessions, onStatus, onError });
    const source = MockEventSource.instances[0];
    source.emit("sessions", new MessageEvent("sessions", { data: "not json" }));

    expect(onStatus).toHaveBeenLastCalledWith("error");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));

    const sessions = [session()];
    source.emit("sessions", new MessageEvent("sessions", {
      data: JSON.stringify({ sessions }),
    }));
    expect(onSessions).toHaveBeenCalledWith(sessions);
  });

  it("reports connection errors and fails fast when EventSource is unavailable", () => {
    vi.stubGlobal("EventSource", MockEventSource);
    const onStatus = vi.fn();
    const onError = vi.fn();
    subscribeToSessions({ onSessions: vi.fn(), onStatus, onError });
    MockEventSource.instances[0].onerror?.(new Event("error"));
    expect(onStatus).toHaveBeenLastCalledWith("error");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));

    vi.stubGlobal("EventSource", undefined);
    expect(() => subscribeToSessions({ onSessions: vi.fn() })).toThrow(
      "Server-sent events are not supported",
    );
  });
});

describe("snippet library API", () => {
  const tree = [{
    id: "root-folder",
    type: "folder" as const,
    name: "Review",
    children: [{ id: "diff", type: "snippet" as const, name: "Diff", text: "git diff\n" }],
  }];

  it("loads and revision-saves the complete ordered tree", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: 3, tree }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: 4, tree }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getSnippetTree()).resolves.toEqual({ revision: 3, tree });
    await expect(saveSnippetTree(tree, 3)).resolves.toEqual({ revision: 4, tree });

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_PATH}/api/snippets`);
    expect(fetchMock.mock.calls[1]).toEqual([
      `${BASE_PATH}/api/snippets`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ tree, revision: 3 }),
      }),
    ]);
  });

  it("exposes stale-write status while preserving the server message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "snippet tree changed",
      revision: 8,
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    })));

    const error = await saveSnippetTree(tree, 3).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ message: "snippet tree changed", status: 409 });
  });
});

describe("queued message API", () => {
  const message = {
    id: "message/1",
    text: "Review the failing test",
    state: "queued" as const,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    position: 0,
  };

  it("encodes session names when listing messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: "work/name",
      messages: [message],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listQueuedMessages("work/name")).resolves.toEqual({
      session: "work/name",
      messages: [message],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/sessions/work%2Fname/messages`,
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
  });

  it("creates queued messages by default and accepts an explicit memorandum state", async () => {
    const note = { ...message, id: "note/1", state: "note" as const };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session: "work",
        message,
      }), { status: 201, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session: "work",
        message: note,
      }), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createQueuedMessage("work", message.text)).resolves.toEqual(message);
    await expect(createQueuedMessage("work", note.text, "note")).resolves.toEqual(note);

    expect(fetchMock.mock.calls[0]).toEqual([
      `${BASE_PATH}/api/sessions/work/messages`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: message.text, state: "queued" }),
      }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      `${BASE_PATH}/api/sessions/work/messages`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: note.text, state: "note" }),
      }),
    ]);
  });

  it("edits memorandum text, position, and state with one JSON request body", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session: "work",
        message: { ...message, text: "Updated", position: 2, state: "note" },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateQueuedMessage("work", "message/1", {
      text: "Updated",
      position: 2,
      state: "note",
    })).resolves.toMatchObject({ text: "Updated", position: 2, state: "note" });

    expect(fetchMock.mock.calls[0]).toEqual([
      `${BASE_PATH}/api/sessions/work/messages/message%2F1`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ text: "Updated", position: 2, state: "note" }),
      }),
    ]);
  });

  it("deletes messages and reports server errors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Message not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteQueuedMessage("work", "m1")).resolves.toBeUndefined();
    await expect(deleteQueuedMessage("work", "missing")).rejects.toThrow("Message not found");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_PATH}/api/sessions/work/messages/m1`);
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: "DELETE" }));
  });
});
