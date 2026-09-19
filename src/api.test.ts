import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASE_PATH,
  ApiRequestError,
  createQueuedMessage,
  copySession,
  createSession,
  createWorkspace,
  deleteQueuedMessage,
  deleteWorkspace,
  forgetRecoverableSession,
  undoForgetRecoverableSession,
  downloadSessionFileEntries,
  getCommonNotebook,
  getCommonNote,
  getCommonWorkspaceQuickLinks,
  getGlobalCallbackSessions,
  getHostMetrics,
  getSessionNotebook,
  getSessionNote,
  getSessionQuickLinks,
  getWorkspace,
  getWorkspaceNotebook,
  getWorkspaceNote,
  getWorkspaceQuickLinks,
  getSnippetTree,
  getShortcutSettings,
  listSessionFiles,
  listSessions,
  listQueuedMessages,
  previewSessionFile,
  resolveSessionFilePath,
  renameSession,
  recreateSession,
  recoverableSessionsFromList,
  replaceCommonNotebook,
  replaceCommonNote,
  replaceCommonWorkspaceQuickLinks,
  replaceGlobalCallbackSessions,
  reviewGlobalCallbackSession,
  replaceSessionNotebook,
  replaceSessionNote,
  replaceSessionQuickLinks,
  replaceWorkspaceNotebook,
  replaceWorkspaceNote,
  replaceWorkspaceQuickLinks,
  saveSnippetTree,
  saveShortcutSettings,
  searchSessionFiles,
  sessionFileDownloadUrl,
  sessionFileHtmlUrl,
  sessionFileImageUrl,
  sessionFilePdfUrl,
  sessionFileSvgUrl,
  subscribeToCallbackSessions,
  subscribeToSessions,
  subscribeToWorkspace,
  terminateSession,
  transferSessionToWorkspace,
  transferSessionsToWorkspace,
  uploadSessionAttachment,
  uploadSessionFile,
  updateSessionIgnored,
  updateSessionStar,
  updateSessionWorkspacePin,
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

describe("host metrics API", () => {
  it("requests the selected history range", async () => {
    const payload = {
      hostname: "mux-host",
      cpuCount: 8,
      sampleSeconds: 5,
      collectionMode: "on-demand",
      range: "1h",
      latest: {
        observedAt: 1_700_000_000,
        cpuPercent: 27,
        cpuCores: [12, 48],
        memoryUsedBytes: 22_400,
        memoryTotalBytes: 31_300,
        memoryAvailableBytes: 8_900,
        memoryPressure: null,
        swapUsedBytes: 26_000,
        swapTotalBytes: 64_000,
        swapInBytesPerSecond: 0,
        swapOutBytesPerSecond: 0,
        loadAverage: [1.71, 2.37, 2.52],
      },
      history: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(getHostMetrics("1h", controller.signal)).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/host-metrics?range=1h`,
      expect.objectContaining({
        signal: controller.signal,
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });
});

describe("session creation API", () => {
  it("preserves recovery records alongside the compatible session array", async () => {
    const live = [session()];
    const recoverable = [{
      id: "registry-id",
      name: "missing-work",
      directory: "/work",
      agentType: "codex" as const,
      agentSessionId: "reference-id",
      firstSeenAt: 1,
      lastSeenAt: 2,
      directoryAvailable: true,
    }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      sessions: live,
      recoverableSessions: recoverable,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const listed = await listSessions();

    expect(listed).toEqual(live);
    expect(recoverableSessionsFromList(listed)).toEqual(recoverable);
  });

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

  it("recreates and forgets only the selected recovery record", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session: "recovered",
        sessionId: "$12",
      }), { status: 201, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(recreateSession("id/one")).resolves.toEqual({
      name: "recovered",
      id: "$12",
    });
    await expect(forgetRecoverableSession("id/one")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${BASE_PATH}/api/recoverable-sessions/id%2Fone/recreate`,
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${BASE_PATH}/api/recoverable-sessions/id%2Fone`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("returns the deadline and token for undoing a forgotten recovery record", async () => {
    const undo = { undoToken: "one-use-token", expiresAt: 1_800_000_030_000 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(undo), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(forgetRecoverableSession("registry-id")).resolves.toEqual(undo);
  });

  it("restores a forgotten record with its token and returns restored workspaces", async () => {
    const restored = {
      recovery: {
        id: "id/one",
        name: "missing-work",
        directory: "/work",
        agentType: "codex",
        agentSessionId: "reference-id",
        firstSeenAt: 1,
        lastSeenAt: 2,
        directoryAvailable: true,
      },
      workspaces: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(restored), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(undoForgetRecoverableSession("id/one", "one-use-token")).resolves.toEqual(restored);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/recoverable-sessions/id%2Fone/undo-forget`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ undoToken: "one-use-token" }),
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("preserves the server's error when a forget undo has expired", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "Undo window expired",
    }), { status: 410, headers: { "Content-Type": "application/json" } })));

    await expect(undoForgetRecoverableSession("registry-id", "expired-token"))
      .rejects.toMatchObject({ status: 410, message: "Undo window expired" });
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

  it("passes an exact server working directory for session creation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: "directory-work",
      sessionId: "$16",
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSession("directory-work", "dark", "/srv/projects/work one"))
      .resolves.toEqual({ name: "directory-work", id: "$16" });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/sessions`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "directory-work",
          theme: "dark",
          directory: "/srv/projects/work one",
        }),
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

    await expect(createSession("mixed-release-work", "dark", "/work/mixed-release"))
      .resolves.toEqual({
      name: "mixed-release-work",
      id: "$15",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${BASE_PATH}/api/sessions`,
      expect.objectContaining({
        body: JSON.stringify({
          name: "mixed-release-work",
          theme: "dark",
          directory: "/work/mixed-release",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${BASE_PATH}/api/sessions`,
      expect.objectContaining({
        body: JSON.stringify({
          name: "mixed-release-work",
          directory: "/work/mixed-release",
        }),
      }),
    );
  });

  it("does not retry without a requested directory when an older backend rejects it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "unknown field: directory",
    }), { status: 400, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await createSession(undefined, "dark", "/work/requires-new-backend")
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ message: "unknown field: directory", status: 400 });
    expect(fetchMock).toHaveBeenCalledOnce();
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

  it("requests a numbered session copy from the source session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: "work/name #1_2",
      sessionId: "$18",
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(copySession("work/name #1", "$7", "light")).resolves.toEqual({
      name: "work/name #1_2",
      id: "$18",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/sessions/work%2Fname%20%231/copy`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sessionId: "$7", theme: "light" }),
      }),
    );
  });
});

describe("session attachment upload API", () => {
  it("uploads any exact browser file against the stable session identity", async () => {
    const payload = {
      name: "build context.log",
      path: "/var/lib/muxdeck/uploads/session/build-context.log",
      terminalText: "/var/lib/muxdeck/uploads/session/build-context.log",
      contentType: "text/plain",
      size: 12,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const attachment = new File(["log contents"], "build context.log", {
      type: "text/plain",
    });
    const controller = new AbortController();

    await expect(uploadSessionAttachment(
      "work/name #1",
      "$7",
      attachment,
      controller.signal,
    )).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/sessions/work%2Fname%20%231/attachments?filename=build+context.log&sessionId=%247`,
      expect.objectContaining({
        method: "POST",
        body: attachment,
        signal: controller.signal,
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "text/plain",
        }),
      }),
    );
  });

  it("preserves an attachment validation error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "attachment file cannot be empty",
    }), { status: 400, headers: { "Content-Type": "application/json" } })));

    const error = await uploadSessionAttachment(
      "work",
      "$1",
      new File([], "empty.txt", { type: "text/plain" }),
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      message: "attachment file cannot be empty",
      status: 400,
    });
  });
});

describe("session file browser API", () => {
  it("encodes session, pane, and relative paths for browse, download, and upload", async () => {
    const listing = {
      root: "/work/project",
      path: "src",
      absolutePath: "/work/project/src",
      terminalText: "/work/project/src",
      entries: [],
      truncated: false,
      limit: 1_000,
    };
    const preview = {
      root: "/work/project",
      name: "main file.ts",
      path: "src/main file.ts",
      absolutePath: "/work/project/src/main file.ts",
      terminalText: "'/work/project/src/main file.ts'",
      kind: "text",
      mediaType: "text/typescript",
      size: 4,
      modified: 1_700_000_000,
      truncated: false,
      previewBytes: 4,
      content: "test",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(listing), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(preview), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "drop me.txt",
        path: "src/drop me.txt",
        absolutePath: "/work/project/src/drop me.txt",
        terminalText: "'/work/project/src/drop me.txt'",
        kind: "file",
        size: 7,
        modified: 1_700_000_001,
        hidden: false,
        symlink: false,
        accessible: true,
      }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const target = { session: "work/name #1", sessionId: "$7", paneId: "%3" };
    await expect(listSessionFiles(
      target,
      "src",
      controller.signal,
    )).resolves.toEqual(listing);
    await expect(previewSessionFile(
      target,
      "src/main file.ts",
      controller.signal,
    )).resolves.toEqual(preview);
    expect(sessionFileDownloadUrl(target, "src/main file.ts")).toBe(
      `${BASE_PATH}/api/sessions/work%2Fname%20%231/files/download?sessionId=%247&paneId=%253&path=src%2Fmain+file.ts`,
    );
    expect(sessionFileImageUrl(target, "src/main file.ts")).toBe(
      `${BASE_PATH}/api/sessions/work%2Fname%20%231/files/image?sessionId=%247&paneId=%253&path=src%2Fmain+file.ts`,
    );
    expect(sessionFileSvgUrl(target, "assets/logo.svg")).toBe(
      `${BASE_PATH}/api/sessions/work%2Fname%20%231/files/svg?sessionId=%247&paneId=%253&path=assets%2Flogo.svg`,
    );
    expect(sessionFilePdfUrl(target, "docs/guide.pdf")).toBe(
      `${BASE_PATH}/api/sessions/work%2Fname%20%231/files/pdf?sessionId=%247&paneId=%253&path=docs%2Fguide.pdf`,
    );
    expect(sessionFileHtmlUrl({ ...target, root: "/srv/data" }, "report.html")).toBe(
      `${BASE_PATH}/api/sessions/work%2Fname%20%231/files/html?sessionId=%247&paneId=%253&path=report.html&root=%2Fsrv%2Fdata`,
    );
    // An explicit root travels with every request once the browser leaves the
    // pane's own directory.
    expect(sessionFileDownloadUrl(
      { ...target, root: "/srv/data" },
      "notes.txt",
    )).toBe(
      `${BASE_PATH}/api/sessions/work%2Fname%20%231/files/download?sessionId=%247&paneId=%253&path=notes.txt&root=%2Fsrv%2Fdata`,
    );
    const upload = new File(["payload"], "drop me.txt", { type: "text/plain" });
    await expect(uploadSessionFile(
      target,
      "src",
      upload,
      controller.signal,
    )).resolves.toMatchObject({
      name: "drop me.txt",
      path: "src/drop me.txt",
      size: 7,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${BASE_PATH}/api/sessions/work%2Fname%20%231/files?sessionId=%247&paneId=%253&path=src`,
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${BASE_PATH}/api/sessions/work%2Fname%20%231/files/preview?sessionId=%247&paneId=%253&path=src%2Fmain+file.ts`,
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `${BASE_PATH}/api/sessions/work%2Fname%20%231/files/upload?sessionId=%247&paneId=%253&path=src&filename=drop+me.txt`,
      expect.objectContaining({
        method: "POST",
        body: upload,
        signal: controller.signal,
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "text/plain",
        }),
      }),
    );
  });

  it("downloads selected file-browser entries as one named ZIP", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      "zip payload",
      {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "X-Muxdeck-Archive-Name": "reports%20selection.zip",
          "X-Muxdeck-Archive-Files": "3",
          "X-Muxdeck-Archive-Directories": "2",
          "X-Muxdeck-Archive-Skipped": "1",
          "X-Muxdeck-Archive-Uncompressed-Bytes": "1234",
        },
      },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const target = {
      session: "work/name #1",
      sessionId: "$7",
      paneId: "%3",
      root: "/srv/data",
    };

    const archive = await downloadSessionFileEntries(
      target,
      "reports/daily",
      ["one.txt", "assets"],
      controller.signal,
    );

    expect(archive).toMatchObject({
      name: "reports selection.zip",
      fileCount: 3,
      directoryCount: 2,
      skippedCount: 1,
      uncompressedBytes: 1234,
    });
    expect(await archive.blob.text()).toBe("zip payload");
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/sessions/work%2Fname%20%231/files/archive?sessionId=%247&paneId=%253&path=reports%2Fdaily&root=%2Fsrv%2Fdata`,
      expect.objectContaining({
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({ names: ["one.txt", "assets"] }),
        headers: {
          Accept: "application/zip",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("preserves a bulk archive limit error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "selection exceeds the 256 MiB uncompressed archive limit",
    }), { status: 413, headers: { "Content-Type": "application/json" } })));

    const error = await downloadSessionFileEntries(
      { session: "work", sessionId: "$7", paneId: "%3" },
      "",
      ["large"],
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      message: "selection exceeds the 256 MiB uncompressed archive limit",
      status: 413,
    });
  });

  it("resolves an absolute file path without carrying the currently browsed root", async () => {
    const resolved = {
      kind: "file",
      root: "/srv/data",
      path: "notes with space.md",
      absolutePath: "/srv/data/notes with space.md",
      entry: {
        name: "notes with space.md",
        path: "notes with space.md",
        absolutePath: "/srv/data/notes with space.md",
        terminalText: "'/srv/data/notes with space.md'",
        kind: "file",
        size: 12,
        modified: 1_700_000_000,
        hidden: false,
        symlink: false,
        accessible: true,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(resolved), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(resolveSessionFilePath(
      {
        session: "work/name #1",
        sessionId: "$7",
        paneId: "%3",
        root: "/an/old/root",
      },
      "/srv/data/notes with space.md",
      controller.signal,
    )).resolves.toEqual(resolved);

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/sessions/work%2Fname%20%231/files/resolve?sessionId=%247&paneId=%253&path=%2Fsrv%2Fdata%2Fnotes+with+space.md`,
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("encodes a bounded fuzzy file search with the active browser root", async () => {
    const results = {
      root: "/srv/data",
      query: "sfp",
      results: [],
      scannedEntries: 42,
      scanLimit: 50_000,
      resultLimit: 80,
      truncated: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(results), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(searchSessionFiles(
      {
        session: "work/name #1",
        sessionId: "$7",
        paneId: "%3",
        root: "/srv/data",
      },
      "sfp",
      true,
      controller.signal,
    )).resolves.toEqual(results);

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/sessions/work%2Fname%20%231/files/search?sessionId=%247&paneId=%253&q=sfp&root=%2Fsrv%2Fdata&hidden=1`,
      expect.objectContaining({ signal: controller.signal }),
    );
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

describe("session workspace pin API", () => {
  it("updates the global pin and returns the workspace revision fence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: "work/name",
      workspacePinned: true,
      sessionRevision: 9,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateSessionWorkspacePin("work/name", true)).resolves.toEqual({
      session: "work/name",
      workspacePinned: true,
      sessionRevision: 9,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/session-workspace-pin`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ session: "work/name", pinned: true }),
      }),
    );
  });
});

describe("session workspace transfer API", () => {
  it("posts the source, destination, operation, and revision fence", async () => {
    const destinationWorkspace = {
      id: "destination",
      name: "Destination",
      tabs: ["work/name"],
      groups: [],
      quickLinks: [],
      activeSession: "work/name",
      sessionRevision: 10,
      createdAt: 1,
      updatedAt: 2,
      lastActiveAt: 1,
    };
    const result = {
      session: "work/name",
      operation: "copy" as const,
      destinationAlreadyContained: false,
      destinationAdded: true,
      sourceRemoved: false,
      sourceWorkspace: null,
      destinationWorkspace,
      sessionRevision: 10,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(transferSessionToWorkspace(
      "work/name",
      "source",
      "destination",
      "copy",
      9,
    )).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/session-workspace-transfer`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          session: "work/name",
          sourceWorkspaceId: "source",
          destinationWorkspaceId: "destination",
          operation: "copy",
          sessionRevision: 9,
        }),
      }),
    );
  });

  it("posts an ordered session batch to the atomic bulk endpoint", async () => {
    const destinationWorkspace = {
      id: "destination",
      name: "Destination",
      tabs: ["existing", "alpha", "gamma"],
      groups: [],
      quickLinks: [],
      activeSession: "existing",
      sessionRevision: 10,
      createdAt: 1,
      updatedAt: 2,
      lastActiveAt: 1,
    };
    const result = {
      sessions: ["alpha", "beta", "gamma"],
      operation: "copy" as const,
      destinationAlreadyContained: ["beta"],
      destinationAdded: ["alpha", "gamma"],
      sourceRemoved: [],
      sourceWorkspace: null,
      destinationWorkspace,
      sessionRevision: 10,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(transferSessionsToWorkspace(
      ["alpha", "beta", "gamma"],
      "source",
      "destination",
      "copy",
      9,
    )).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/session-workspace-transfer/bulk`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sessions: ["alpha", "beta", "gamma"],
          sourceWorkspaceId: "source",
          destinationWorkspaceId: "destination",
          operation: "copy",
          sessionRevision: 9,
        }),
      }),
    );
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

  it("reads and replaces the global callback queue", async () => {
    const snapshot = {
      callbackSessions: ["global", "workspace-session"],
      globalCallbackSessions: ["global"],
      workspaceCallbacks: [{
        workspaceId: "workspace/id",
        workspaceName: "Release train",
        sessions: ["workspace-session"],
      }],
      sessionRevision: 7,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getGlobalCallbackSessions()).resolves.toEqual(snapshot);
    await expect(replaceGlobalCallbackSessions(["global"], 7)).resolves.toEqual(snapshot);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_PATH}/api/callback-sessions`);
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ sessions: ["global"], sessionRevision: 7 }),
    }));
  });

  it("reviews a callback across global and workspace queues", async () => {
    const snapshot = {
      removed: ["workspace-session"],
      callbackSessions: [],
      globalCallbackSessions: [],
      workspaceCallbacks: [],
      sessionRevision: 7,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(reviewGlobalCallbackSession("workspace-session", 7))
      .resolves.toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/callback-sessions/review`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ session: "workspace-session", sessionRevision: 7 }),
      }),
    );
  });

  it("loads and replaces common, workspace, and session-specific quick links", async () => {
    const common = [{ id: "docs", label: "Docs", url: "https://docs.test/" }];
    const workspaceLinks = [
      { id: "ticket", label: "Ticket", url: "https://issues.test/42" },
    ];
    const sessionLinks = [
      { id: "trace", label: "Trace", url: "https://traces.test/run" },
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ links: sessionLinks }), {
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
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ links: sessionLinks }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCommonWorkspaceQuickLinks()).resolves.toEqual(common);
    await expect(getWorkspaceQuickLinks("workspace/id")).resolves.toEqual(workspaceLinks);
    await expect(getSessionQuickLinks("agent/name")).resolves.toEqual(sessionLinks);
    await expect(replaceCommonWorkspaceQuickLinks(common)).resolves.toEqual(common);
    await expect(replaceWorkspaceQuickLinks("workspace/id", workspaceLinks))
      .resolves.toEqual(workspaceLinks);
    await expect(replaceSessionQuickLinks("agent/name", sessionLinks))
      .resolves.toEqual(sessionLinks);

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_PATH}/api/workspace-quick-links`);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${BASE_PATH}/api/workspaces/workspace%2Fid/quick-links`,
    );
    expect(fetchMock.mock.calls[2]).toEqual([
      `${BASE_PATH}/api/sessions/agent%2Fname/quick-links`,
      expect.objectContaining({}),
    ]);
    expect(fetchMock.mock.calls[3]).toEqual([
      `${BASE_PATH}/api/workspace-quick-links`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ links: common }),
      }),
    ]);
    expect(fetchMock.mock.calls[4]).toEqual([
      `${BASE_PATH}/api/workspaces/workspace%2Fid/quick-links`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ links: workspaceLinks }),
      }),
    ]);
    expect(fetchMock.mock.calls[5]).toEqual([
      `${BASE_PATH}/api/sessions/agent%2Fname/quick-links`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ links: sessionLinks }),
      }),
    ]);
  });

  it("loads and replaces common, workspace, and session-scoped notes", async () => {
    const notes = [
      "Shared checklist",
      "Workspace plan",
      "Session handoff",
      "Updated shared checklist",
      "Updated workspace plan",
      "Updated session handoff",
    ];
    const fetchMock = vi.fn();
    for (const note of notes) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ note }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCommonNote()).resolves.toBe(notes[0]);
    await expect(getWorkspaceNote("workspace/id")).resolves.toBe(notes[1]);
    await expect(getSessionNote("agent/name")).resolves.toBe(notes[2]);
    await expect(replaceCommonNote(notes[3])).resolves.toBe(notes[3]);
    await expect(replaceWorkspaceNote("workspace/id", notes[4])).resolves.toBe(notes[4]);
    await expect(replaceSessionNote("agent/name", notes[5])).resolves.toBe(notes[5]);

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_PATH}/api/common-note`);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${BASE_PATH}/api/workspaces/workspace%2Fid/note`,
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      `${BASE_PATH}/api/sessions/agent%2Fname/note`,
    );
    expect(fetchMock.mock.calls[3]).toEqual([
      `${BASE_PATH}/api/common-note`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ note: notes[3] }),
      }),
    ]);
    expect(fetchMock.mock.calls[4]).toEqual([
      `${BASE_PATH}/api/workspaces/workspace%2Fid/note`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ note: notes[4] }),
      }),
    ]);
    expect(fetchMock.mock.calls[5]).toEqual([
      `${BASE_PATH}/api/sessions/agent%2Fname/note`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ note: notes[5] }),
      }),
    ]);
  });

  it("loads and replaces scoped note notebooks with legacy response fallback", async () => {
    const notebook = {
      pages: [
        { id: "main", name: "Plan", content: "First" },
        { id: "next", name: "Next", content: "Second" },
      ],
    };
    const response = (payload: unknown) => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        note: "First",
        notebook,
      }))
      .mockResolvedValueOnce(response({ note: "Legacy" }))
      .mockImplementation(async () => response({
        note: "First",
        notebook,
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCommonNotebook()).resolves.toEqual(notebook);
    await expect(getWorkspaceNotebook("workspace/id")).resolves.toEqual({
      pages: [{ id: "main", name: "Page 1", content: "Legacy" }],
    });
    await expect(getSessionNotebook("agent/name")).resolves.toEqual(notebook);
    await expect(replaceCommonNotebook(notebook)).resolves.toEqual(notebook);
    await expect(replaceWorkspaceNotebook("workspace/id", notebook))
      .resolves.toEqual(notebook);
    await expect(replaceSessionNotebook("agent/name", notebook))
      .resolves.toEqual(notebook);

    expect(fetchMock.mock.calls[3][1]).toEqual(expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ notebook }),
    }));
    expect(fetchMock.mock.calls[4][0]).toBe(
      `${BASE_PATH}/api/workspaces/workspace%2Fid/note`,
    );
    expect(fetchMock.mock.calls[5][0]).toBe(
      `${BASE_PATH}/api/sessions/agent%2Fname/note`,
    );
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

    await expect(updateWorkspaceActivity("workspace/id", ["api"], [], "api", 7, workspace.updatedAt))
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
          expectedUpdatedAt: workspace.updatedAt,
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
          expectedUpdatedAt: workspace.updatedAt,
        }),
      }),
    );
  });

  it("includes the last observed workspace version in conditional metadata updates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ workspace }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const update = { tabs: ["api"], expectedUpdatedAt: workspace.updatedAt };
    await expect(updateWorkspace(workspace.id, update)).resolves.toEqual(workspace);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_PATH}/api/workspaces/workspace%2Fid`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify(update) }),
    );
  });

  it("surfaces workspace version conflicts without retrying an unguarded write", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "workspace has changed",
    }), { status: 409, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateWorkspaceActivity("workspace/id", ["api"], [], "api", 7, 0))
      .rejects.toMatchObject({ status: 409, message: "workspace has changed" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ expectedUpdatedAt: 0 });
  });

  it.each([
    ["groups", "expectedUpdatedAt"],
    ["expectedUpdatedAt", "groups"],
  ])("handles legacy activity fields rejected in order %s then %s", async (first, second) => {
    vi.resetModules();
    const api = await import("./api");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: `unknown field: ${first}` }), {
        status: 400, headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: `unknown field: ${second}` }), {
        status: 400, headers: { "Content-Type": "application/json" },
      }))
      .mockImplementation(async () => new Response(JSON.stringify({ workspace }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    expect(api.supportsWorkspaceVersionChecks()).toBe(true);
    await expect(api.updateWorkspaceActivity(workspace.id, ["api"], [], "api", 7, workspace.updatedAt))
      .resolves.toEqual(workspace);
    const original = {
      tabs: ["api"], groups: [], activeSession: "api", sessionRevision: 7,
      expectedUpdatedAt: workspace.updatedAt,
    };
    const afterFirst = { ...original };
    Reflect.deleteProperty(afterFirst, first);
    const afterSecond = { ...afterFirst };
    Reflect.deleteProperty(afterSecond, second);
    expect(fetchMock.mock.calls.slice(0, 3).map((call) => JSON.parse(call[1].body)))
      .toEqual([original, afterFirst, afterSecond]);
    expect(api.supportsWorkspaceVersionChecks()).toBe(false);
    await api.updateWorkspace(workspace.id, { name: "Renamed", expectedUpdatedAt: workspace.updatedAt });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ name: "Renamed" });
  });

  it("retries a metadata update only when an older server explicitly rejects its version field", async () => {
    vi.resetModules();
    const api = await import("./api");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "unknown field: expectedUpdatedAt" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      }))
      .mockImplementation(async () => new Response(JSON.stringify({ workspace }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const changes = { name: "Renamed", expectedUpdatedAt: workspace.updatedAt };
    await expect(api.updateWorkspace(workspace.id, changes)).resolves.toEqual(workspace);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([
      changes, { name: "Renamed" },
    ]);
    expect(api.supportsWorkspaceVersionChecks()).toBe(false);
    await api.updateWorkspaceActivity(workspace.id, ["api"], [], "api", 7, workspace.updatedAt);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      tabs: ["api"], groups: [], activeSession: "api", sessionRevision: 7,
    });
  });

  it.each([409, 400])("does not remove metadata version protection after an unrelated %s rejection", async (status) => {
    vi.resetModules();
    const api = await import("./api");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "workspace has changed" }), {
      status, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.updateWorkspace(workspace.id, { name: "Renamed", expectedUpdatedAt: 1_000 }))
      .rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(api.supportsWorkspaceVersionChecks()).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: "Renamed", expectedUpdatedAt: 1_000 });
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

describe("subscribeToWorkspace", () => {
  const workspace = {
    id: "workspace/id",
    name: "Release train",
    tabs: ["api", "web client"],
    groups: [{ id: "group-1", name: "Backend", color: "blue", collapsed: false, tabs: ["api"] }],
    separators: ["api"],
    separatorsBefore: ["web client"],
    callbackSessions: ["api"],
    quickLinks: [{ id: "docs", label: "Docs", url: "https://docs.test/" }],
    paneLayouts: [{
      id: "layout-1", name: "Services", root: {
        id: "split-1", kind: "split", direction: "horizontal", ratio: 0.5,
        first: { id: "pane-1", kind: "pane", session: "api" },
        second: { id: "pane-2", kind: "pane", session: null },
      },
    }],
    activeSession: "web client",
    sessionRevision: 7,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_010_000,
    lastActiveAt: 1_700_000_020_000,
  };

  it("shares the workspace stream with validated callback snapshots", () => {
    vi.stubGlobal("EventSource", MockEventSource);
    const onWorkspace = vi.fn();
    const onCallbacks = vi.fn();
    const onError = vi.fn();
    subscribeToWorkspace(workspace.id, { onWorkspace, onCallbacks, onError });
    const source = MockEventSource.instances[0];
    const callbacks = {
      callbackSessions: ["api"], globalCallbackSessions: [], sessionRevision: 7,
      workspaceCallbacks: [{ workspaceId: workspace.id, workspaceName: workspace.name, sessions: ["api"] }],
    };
    source.emit("workspace", new MessageEvent("workspace", { data: JSON.stringify({ workspace, callbacks }) }));
    expect(onWorkspace).toHaveBeenCalledWith(workspace);
    expect(onCallbacks).toHaveBeenCalledWith(callbacks);
    onWorkspace.mockClear();
    onCallbacks.mockClear();
    source.emit("workspace", new MessageEvent("workspace", {
      data: JSON.stringify({ workspace, callbacks: { ...callbacks, sessionRevision: -1 } }),
    }));
    expect(onWorkspace).not.toHaveBeenCalled();
    expect(onCallbacks).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    source.emit("workspace", new MessageEvent("workspace", { data: JSON.stringify({ workspace }) }));
    expect(onWorkspace).toHaveBeenCalledWith(workspace);
    expect(onCallbacks).not.toHaveBeenCalled();
  });

  it("streams canonical workspace snapshots and explicit deletion at an encoded URL", () => {
    vi.stubGlobal("EventSource", MockEventSource);
    const onWorkspace = vi.fn();
    const onStatus = vi.fn();
    const onError = vi.fn();
    const unsubscribe = subscribeToWorkspace(workspace.id, { onWorkspace, onStatus, onError });
    const source = MockEventSource.instances[0];

    expect(source.url).toBe(`${BASE_PATH}/api/workspaces/workspace%2Fid/stream`);
    expect(onStatus).toHaveBeenLastCalledWith("connecting");
    source.onopen?.(new Event("open"));
    expect(onStatus).toHaveBeenLastCalledWith("open");
    source.emit("workspace", new MessageEvent("workspace", { data: JSON.stringify({ workspace }) }));
    expect(onWorkspace).toHaveBeenLastCalledWith(workspace);
    source.emit("workspace", new MessageEvent("workspace", { data: JSON.stringify({ workspace: null }) }));
    expect(onWorkspace).toHaveBeenLastCalledWith(null);
    expect(onError).not.toHaveBeenCalled();

    unsubscribe();
    unsubscribe();
    expect(source.close).toHaveBeenCalledOnce();
    onWorkspace.mockClear();
    onStatus.mockClear();
    source.emit("workspace", new MessageEvent("workspace", { data: JSON.stringify({ workspace }) }));
    source.onopen?.(new Event("open"));
    source.onerror?.(new Event("error"));
    expect(onWorkspace).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "not json"],
    ["null frame", "null"],
    ["missing workspace", "{}"],
    ["wrong workspace", JSON.stringify({ workspace: { ...workspace, id: "other" } })],
    ["invalid tabs", JSON.stringify({ workspace: { ...workspace, tabs: [1] } })],
    ["invalid groups", JSON.stringify({ workspace: { ...workspace, groups: [{}] } })],
    ["invalid group color", JSON.stringify({ workspace: { ...workspace, groups: [{ ...workspace.groups[0], color: "invalid" }] } })],
    ["invalid separators", JSON.stringify({ workspace: { ...workspace, separators: "api" } })],
    ["invalid callbacks", JSON.stringify({ workspace: { ...workspace, callbackSessions: [null] } })],
    ["invalid quick links", JSON.stringify({ workspace: { ...workspace, quickLinks: [null] } })],
    ["invalid pane tree", JSON.stringify({ workspace: { ...workspace, paneLayouts: [{ ...workspace.paneLayouts[0], root: { kind: "split" } }] } })],
    ["negative version", JSON.stringify({ workspace: { ...workspace, updatedAt: -1 } })],
    ["fractional version", JSON.stringify({ workspace: { ...workspace, updatedAt: 1.5 } })],
    ["unsafe version", JSON.stringify({ workspace: { ...workspace, updatedAt: Number.MAX_SAFE_INTEGER + 1 } })],
    ["invalid session revision", JSON.stringify({ workspace: { ...workspace, sessionRevision: -1 } })],
  ])("rejects %s without replacing canonical state and accepts later valid frames", (_label, data) => {
    vi.stubGlobal("EventSource", MockEventSource);
    const onWorkspace = vi.fn();
    const onStatus = vi.fn();
    const onError = vi.fn();
    subscribeToWorkspace(workspace.id, { onWorkspace, onStatus, onError });
    const source = MockEventSource.instances[0];
    source.emit("workspace", new MessageEvent("workspace", { data }));
    expect(onWorkspace).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onStatus).toHaveBeenLastCalledWith("error");
    source.emit("workspace", new MessageEvent("workspace", { data: JSON.stringify({ workspace }) }));
    expect(onWorkspace).toHaveBeenCalledWith(workspace);
  });

  it("allows EventSource to reconnect and reports unsupported browsers", () => {
    vi.stubGlobal("EventSource", MockEventSource);
    const onWorkspace = vi.fn();
    const onStatus = vi.fn();
    const onError = vi.fn();
    subscribeToWorkspace(workspace.id, { onWorkspace, onStatus, onError });
    const source = MockEventSource.instances[0];
    source.onerror?.(new Event("error"));
    expect(onStatus).toHaveBeenLastCalledWith("error");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Workspace stream connection failed" }));
    expect(source.close).not.toHaveBeenCalled();
    source.onopen?.(new Event("open"));
    expect(onStatus).toHaveBeenLastCalledWith("open");
    source.emit("workspace", new MessageEvent("workspace", { data: JSON.stringify({ workspace }) }));
    expect(onWorkspace).toHaveBeenCalledWith(workspace);

    vi.stubGlobal("EventSource", undefined);
    expect(() => subscribeToWorkspace(workspace.id, { onWorkspace })).toThrow(
      "Server-sent events are not supported",
    );
  });
});

describe("subscribeToCallbackSessions", () => {
  it("subscribes at the configured base path and delivers callback snapshots", () => {
    vi.stubGlobal("EventSource", MockEventSource);
    const onSnapshot = vi.fn();
    const onStatus = vi.fn();

    const unsubscribe = subscribeToCallbackSessions({ onSnapshot, onStatus });
    const source = MockEventSource.instances[0];

    expect(source.url).toBe(`${BASE_PATH}/api/callback-sessions/stream`);
    expect(onStatus).toHaveBeenCalledWith("connecting");
    source.onopen?.(new Event("open"));
    expect(onStatus).toHaveBeenLastCalledWith("open");

    const snapshot = {
      callbackSessions: ["agent-one", "agent-two"],
      globalCallbackSessions: ["agent-two"],
      workspaceCallbacks: [{
        workspaceId: "workspace-one",
        workspaceName: "Launch room",
        sessions: ["agent-one"],
      }],
      sessionRevision: 4,
    };
    source.emit("callbacks", new MessageEvent("callbacks", {
      data: JSON.stringify(snapshot),
    }));
    expect(onSnapshot).toHaveBeenCalledWith(snapshot);

    unsubscribe();
    unsubscribe();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("reports malformed callback snapshots and connection errors", () => {
    vi.stubGlobal("EventSource", MockEventSource);
    const onSnapshot = vi.fn();
    const onStatus = vi.fn();
    const onError = vi.fn();

    subscribeToCallbackSessions({ onSnapshot, onStatus, onError });
    const source = MockEventSource.instances[0];
    source.emit("callbacks", new MessageEvent("callbacks", { data: "not json" }));
    expect(onStatus).toHaveBeenLastCalledWith("error");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    source.onerror?.(new Event("error"));
    expect(onError).toHaveBeenLastCalledWith(expect.any(Error));
    expect(onSnapshot).not.toHaveBeenCalled();
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

describe("shortcut settings API", () => {
  const bindings = {
    "command-palette": { direct: "KeyH", launcher: "KeyH" },
    "shortcut-launcher": { direct: "KeyZ", launcher: null },
  };

  it("loads and revision-saves the backend keymap", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: 2, bindings }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: 3, bindings }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getShortcutSettings()).resolves.toEqual({ revision: 2, bindings });
    await expect(saveShortcutSettings(bindings, 2)).resolves.toEqual({
      revision: 3,
      bindings,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_PATH}/api/shortcuts`);
    expect(fetchMock.mock.calls[1]).toEqual([
      `${BASE_PATH}/api/shortcuts`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ bindings, revision: 2 }),
      }),
    ]);
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
