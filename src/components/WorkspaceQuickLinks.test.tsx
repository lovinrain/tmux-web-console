import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCommonWorkspaceQuickLinks,
  getSessionQuickLinks,
  getWorkspaceQuickLinks,
  replaceCommonWorkspaceQuickLinks,
  replaceSessionQuickLinks,
  replaceWorkspaceQuickLinks,
} from "../api";
import {
  WorkspaceQuickLinks,
  normalizeWorkspaceQuickLinkUrl,
} from "./WorkspaceQuickLinks";

vi.mock("../api", () => ({
  getCommonWorkspaceQuickLinks: vi.fn(),
  getSessionQuickLinks: vi.fn(),
  getWorkspaceQuickLinks: vi.fn(),
  replaceCommonWorkspaceQuickLinks: vi.fn(),
  replaceSessionQuickLinks: vi.fn(),
  replaceWorkspaceQuickLinks: vi.fn(),
}));

const commonLinks = [
  { id: "docs", label: "Docs", url: "https://docs.test/" },
];
const workspaceLinks = [
  { id: "ticket", label: "Ticket 42", url: "https://issues.test/42" },
];
const sessionLinks = [
  { id: "trace", label: "Agent trace", url: "https://traces.test/agent-one" },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getCommonWorkspaceQuickLinks).mockResolvedValue(commonLinks);
  vi.mocked(getSessionQuickLinks).mockResolvedValue(sessionLinks);
  vi.mocked(getWorkspaceQuickLinks).mockResolvedValue(workspaceLinks);
  vi.mocked(replaceCommonWorkspaceQuickLinks).mockImplementation(async (links) => links);
  vi.mocked(replaceSessionQuickLinks).mockImplementation(async (_session, links) => links);
  vi.mocked(replaceWorkspaceQuickLinks).mockImplementation(async (_id, links) => links);
});

describe("WorkspaceQuickLinks", () => {
  it("shows common links in unsaved workspaces and adds a normalized URL", async () => {
    render(<WorkspaceQuickLinks sessionName="agent-one" />);

    const common = screen.getByRole("region", { name: "Common quick links" });
    const workspace = screen.getByRole("region", { name: "Workspace quick links" });
    const docs = await within(common).findByRole("link", { name: "Docs" });
    expect(docs).toHaveAttribute("href", "https://docs.test/");
    expect(docs).toHaveAttribute("target", "_blank");
    expect(within(workspace).getByText("Save workspace to add links")).toBeVisible();
    expect(within(workspace).getByRole("button", {
      name: "Manage workspace quick links",
    })).toBeDisabled();
    expect(getWorkspaceQuickLinks).not.toHaveBeenCalled();
    const session = screen.getByRole("region", { name: "Session quick links" });
    expect(await within(session).findByRole("link", { name: "Agent trace" })).toBeVisible();
    expect(within(session).getByRole("button", { name: "Manage session quick links" }))
      .toBeEnabled();

    fireEvent.click(within(common).getByRole("button", {
      name: "Manage common quick links",
    }));
    const dialog = screen.getByRole("dialog", { name: "Manage Common links" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Label" }), {
      target: { value: "Build board" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "URL" }), {
      target: { value: "ci.example.test/builds" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to shelf" }));
    expect(within(dialog).getByText("https://ci.example.test/builds")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save links" }));

    await waitFor(() => expect(replaceCommonWorkspaceQuickLinks).toHaveBeenCalledWith([
      commonLinks[0],
      expect.objectContaining({
        label: "Build board",
        url: "https://ci.example.test/builds",
      }),
    ]));
    expect(screen.queryByRole("dialog", { name: "Manage Common links" }))
      .not.toBeInTheDocument();
    expect(within(common).getByRole("link", { name: "Build board" })).toBeVisible();
  });

  it("loads and removes links belonging only to the saved workspace", async () => {
    render(
      <WorkspaceQuickLinks
        sessionName="agent-one"
        workspaceId="workspace/id"
        workspaceName="Release room"
      />,
    );

    const workspace = screen.getByRole("region", { name: "Workspace quick links" });
    expect(await within(workspace).findByRole("link", { name: "Ticket 42" })).toBeVisible();
    expect(getWorkspaceQuickLinks).toHaveBeenCalledWith(
      "workspace/id",
      expect.any(AbortSignal),
    );
    fireEvent.click(within(workspace).getByRole("button", {
      name: "Manage workspace quick links",
    }));
    const dialog = screen.getByRole("dialog", { name: "Manage Release room links" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Ticket 42" }));
    expect(within(dialog).getByText("No links pinned yet.")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save links" }));

    await waitFor(() => expect(replaceWorkspaceQuickLinks)
      .toHaveBeenCalledWith("workspace/id", []));
    expect(within(workspace).getByText("No links yet")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Common quick links" }))
      .getByRole("link", { name: "Docs" })).toBeVisible();
  });

  it("keeps the editor open for unsafe URLs and failed saves", async () => {
    vi.mocked(replaceCommonWorkspaceQuickLinks)
      .mockRejectedValueOnce(new Error("Workspace storage is read-only"));
    render(<WorkspaceQuickLinks sessionName="agent-one" />);

    const common = screen.getByRole("region", { name: "Common quick links" });
    await within(common).findByRole("link", { name: "Docs" });
    fireEvent.click(within(common).getByRole("button", {
      name: "Manage common quick links",
    }));
    const dialog = screen.getByRole("dialog", { name: "Manage Common links" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Label" }), {
      target: { value: "Unsafe" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "URL" }), {
      target: { value: "javascript:alert(1)" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to shelf" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Only HTTP and HTTPS links are supported.",
    );
    expect(within(dialog).queryByText("Unsafe", { selector: "strong" }))
      .not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Save links" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Workspace storage is read-only",
    );
    expect(dialog).toBeVisible();
  });

  it("does not apply a late save response after the active workspace changes", async () => {
    const secondLinks = [
      { id: "second", label: "Second workspace", url: "https://second.test/" },
    ];
    let resolveSave!: (links: typeof secondLinks) => void;
    const pendingSave = new Promise<typeof secondLinks>((resolve) => {
      resolveSave = resolve;
    });
    vi.mocked(getWorkspaceQuickLinks).mockImplementation(async (workspaceId) => (
      workspaceId === "first" ? workspaceLinks : secondLinks
    ));
    vi.mocked(replaceWorkspaceQuickLinks).mockReturnValueOnce(pendingSave);

    const view = render(
      <WorkspaceQuickLinks
        sessionName="agent-one"
        workspaceId="first"
        workspaceName="First"
      />,
    );
    const workspace = screen.getByRole("region", { name: "Workspace quick links" });
    await within(workspace).findByRole("link", { name: "Ticket 42" });
    fireEvent.click(within(workspace).getByRole("button", {
      name: "Manage workspace quick links",
    }));
    const firstDialog = screen.getByRole("dialog", { name: "Manage First links" });
    fireEvent.click(within(firstDialog).getByRole("button", { name: "Save links" }));

    view.rerender(
      <WorkspaceQuickLinks
        sessionName="agent-one"
        workspaceId="second"
        workspaceName="Second"
      />,
    );
    await within(workspace).findByRole("link", { name: "Second workspace" });
    fireEvent.click(within(workspace).getByRole("button", {
      name: "Manage workspace quick links",
    }));
    expect(screen.getByRole("dialog", { name: "Manage Second links" })).toBeVisible();

    await act(async () => {
      resolveSave([
        { id: "stale", label: "Stale response", url: "https://stale.test/" },
      ]);
      await pendingSave;
    });
    expect(screen.getByRole("dialog", { name: "Manage Second links" })).toBeVisible();
    expect(within(workspace).queryByRole("link", { name: "Stale response" }))
      .not.toBeInTheDocument();
  });

  it("keeps session links isolated when the active session changes", async () => {
    const secondSessionLinks = [
      { id: "logs", label: "Second agent logs", url: "https://logs.test/agent-two" },
    ];
    let resolveSave!: (links: typeof sessionLinks) => void;
    const pendingSave = new Promise<typeof sessionLinks>((resolve) => {
      resolveSave = resolve;
    });
    vi.mocked(getSessionQuickLinks).mockImplementation(async (sessionName) => (
      sessionName === "agent-one" ? sessionLinks : secondSessionLinks
    ));
    vi.mocked(replaceSessionQuickLinks).mockReturnValueOnce(pendingSave);

    const view = render(<WorkspaceQuickLinks sessionName="agent-one" />);
    const session = screen.getByRole("region", { name: "Session quick links" });
    await within(session).findByRole("link", { name: "Agent trace" });
    fireEvent.click(within(session).getByRole("button", {
      name: "Manage session quick links",
    }));
    const firstDialog = screen.getByRole("dialog", {
      name: "Manage agent-one links",
    });
    fireEvent.click(within(firstDialog).getByRole("button", {
      name: "Remove Agent trace",
    }));
    fireEvent.click(within(firstDialog).getByRole("button", { name: "Save links" }));
    expect(replaceSessionQuickLinks).toHaveBeenCalledWith("agent-one", []);

    view.rerender(<WorkspaceQuickLinks sessionName="agent-two" />);
    expect(await within(session).findByRole("link", { name: "Second agent logs" }))
      .toBeVisible();
    expect(getSessionQuickLinks).toHaveBeenLastCalledWith(
      "agent-two",
      expect.any(AbortSignal),
    );
    fireEvent.click(within(session).getByRole("button", {
      name: "Manage session quick links",
    }));
    expect(screen.getByRole("dialog", { name: "Manage agent-two links" })).toBeVisible();

    await act(async () => {
      resolveSave([
        { id: "stale", label: "Stale response", url: "https://stale.test/" },
      ]);
      await pendingSave;
    });
    expect(screen.getByRole("dialog", { name: "Manage agent-two links" })).toBeVisible();
    expect(within(session).queryByRole("link", { name: "Stale response" }))
      .not.toBeInTheDocument();
  });
});

describe("normalizeWorkspaceQuickLinkUrl", () => {
  it("adds HTTPS to host-like input and rejects active-content schemes", () => {
    expect(normalizeWorkspaceQuickLinkUrl("example.test/path"))
      .toBe("https://example.test/path");
    expect(() => normalizeWorkspaceQuickLinkUrl("data:text/html,test"))
      .toThrow("Only HTTP and HTTPS links are supported.");
    expect(() => normalizeWorkspaceQuickLinkUrl("https://example.test/\x7f"))
      .toThrow("URL cannot contain whitespace or control characters.");
  });
});
