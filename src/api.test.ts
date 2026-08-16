import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASE_PATH,
  ApiRequestError,
  createQueuedMessage,
  createSession,
  deleteQueuedMessage,
  getSnippetTree,
  listQueuedMessages,
  renameSession,
  saveSnippetTree,
  subscribeToSessions,
  updateSessionIgnored,
  updateSessionStar,
  updateQueuedMessage,
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
    activity: 2,
    activePaneId: null,
    agentState: "working",
    agentStateReason: "Agent is running",
    agentStateChangedAt: 3,
    customTitle: null,
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
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSession()).resolves.toBe("muxdeck-abc123def456");
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
});

describe("native session rename API", () => {
  it("renames the tmux session separately from its display title", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: " new work ",
      previousSession: "old/work",
      warnings: ["unable to migrate queued messages"],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(renameSession("old/work", " new work ")).resolves.toEqual({
      previousSession: "old/work",
      session: " new work ",
      warnings: ["unable to migrate queued messages"],
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

  it("creates and edits messages with JSON request bodies", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session: "work",
        message,
      }), { status: 201, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session: "work",
        message: { ...message, text: "Updated", position: 2 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createQueuedMessage("work", message.text)).resolves.toEqual(message);
    await expect(updateQueuedMessage("work", "message/1", {
      text: "Updated",
      position: 2,
    })).resolves.toMatchObject({ text: "Updated", position: 2 });

    expect(fetchMock.mock.calls[0]).toEqual([
      `${BASE_PATH}/api/sessions/work/messages`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ text: message.text }) }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      `${BASE_PATH}/api/sessions/work/messages/message%2F1`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ text: "Updated", position: 2 }),
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
