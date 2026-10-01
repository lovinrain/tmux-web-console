import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../api";
import type { Session } from "../types";
import { addWorkLink, getWorkLinkContext, updateWorkLink, updateWorkLinkConfig, type WorkLink, type WorkLinkConfig } from "../workLinks";
import { SessionWorkLinks } from "./SessionWorkLinks";

vi.mock("../workLinks", async (original) => ({
  ...await original<typeof import("../workLinks")>(), getWorkLinkContext: vi.fn(),
  addWorkLink: vi.fn(), updateWorkLink: vi.fn(), removeWorkLink: vi.fn(), updateWorkLinkConfig: vi.fn(),
}));

const provider = { enabled: true, refreshEnabled: false, refreshIntervalSeconds: 300, instructions: "" };
const config: WorkLinkConfig = {
  enabled: true, revision: 0, providers: { github: { ...provider }, jira: { ...provider }, google_docs: { ...provider } },
};
const record: WorkLink = { id: "link-1", historyId: "history-1", provider: "github", label: "PR #17", title: "Fix sessions",
  url: "https://git.company.example/o/r/pull/17", notes: "Existing note", instructions: "", revision: 1, statusRevision: 0,
  status: null, statusUpdatedAt: null, createdAt: 100, updatedAt: 100 };
const session: Session = { name: "agent-one", id: "$1", created: 10, serverStarted: 1, serverPid: 100, windows: 1,
  attached: 0, activity: 100, activePaneId: null, agentState: "other", agentStateReason: "", agentStateChangedAt: 100,
  customTitle: null, tags: [], starred: false, ignored: false, queuedMessageCount: 0, panes: [],
  workLinksEnabled: true, workLinksRevision: 0, workLinks: [record] };
const context = (links = [record], settings = config) => ({ session: { name: session.name, historyId: "history-1" }, config: settings, links });

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(getWorkLinkContext).mockResolvedValue(context());
});

async function open() {
  fireEvent.click(screen.getByRole("button", { name: /^Work links/ }));
  return await screen.findByRole("textbox", { name: "Notes for PR #17" });
}

describe("session work links", () => {
  it("shows Google Docs title chips with the complete URL only in the destination", async () => {
    const doc = { ...record, provider: "google_docs" as const, label: "Google Doc", title: "Release planning",
      url: "https://docs.google.com/document/d/a-very-long-document-id/edit?tab=t.1234" };
    vi.mocked(getWorkLinkContext).mockResolvedValue(context([doc]));
    render(<SessionWorkLinks session={{ ...session, workLinks: [doc] }} />);
    const chip = screen.getByRole("link", { name: "Doc Release planning" });
    expect(chip).toHaveAttribute("href", doc.url);
    expect(chip).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByText(doc.url)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Work links/ }));
    expect(await screen.findByRole("textbox", { name: "Notes for Release planning" })).toHaveValue("Existing note");
  });

  it("updates reported status while preserving an in-progress note and its independent revision", async () => {
    const view = render(<SessionWorkLinks session={session} />);
    const notes = await open();
    fireEvent.change(notes, { target: { value: "Human decision in progress" } });
    const reported = { ...record, statusRevision: 1, statusUpdatedAt: 123,
      status: { state: "Approved", tone: "success" as const, summary: "Checks passed", reportedBy: "agent" } };
    vi.mocked(getWorkLinkContext).mockResolvedValue(context([reported]));
    view.rerender(<SessionWorkLinks session={{ ...session, workLinksRevision: 1, workLinks: [reported] }} />);
    await screen.findByText("Checks passed");
    expect(notes).toHaveValue("Human decision in progress");
    const saved = { ...reported, revision: 2, notes: "Human decision in progress" };
    vi.mocked(updateWorkLink).mockResolvedValue({ link: saved });
    vi.mocked(getWorkLinkContext).mockResolvedValue(context([saved]));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateWorkLink).toHaveBeenCalledWith(record, { notes: "Human decision in progress" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled());
    expect(notes).toHaveValue("Human decision in progress");
  });

  it("preserves a conflicting notes draft until the user chooses the saved version", async () => {
    render(<SessionWorkLinks session={session} />);
    const notes = await open();
    fireEvent.change(notes, { target: { value: "My unsaved draft" } });
    vi.mocked(updateWorkLink).mockRejectedValue(new ApiRequestError("link or notes changed", 409));
    vi.mocked(getWorkLinkContext).mockResolvedValue(context([{ ...record, revision: 2, notes: "Other writer's note" }]));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your draft is preserved");
    expect(notes).toHaveValue("My unsaved draft");
    await waitFor(() => expect(screen.getByRole("button", { name: "Load saved version" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Load saved version" }));
    expect(notes).toHaveValue("Other writer's note");
  });

  it("keeps typing that arrives while an earlier note save is in flight", async () => {
    let finish!: (value: { link: WorkLink }) => void;
    vi.mocked(updateWorkLink).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<SessionWorkLinks session={session} />);
    const notes = await open();
    fireEvent.change(notes, { target: { value: "First revision" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    fireEvent.change(notes, { target: { value: "First revision plus more typing" } });
    const saved = { ...record, revision: 2, notes: "First revision" };
    vi.mocked(getWorkLinkContext).mockResolvedValue(context([saved]));
    await act(async () => { finish({ link: saved }); });
    expect(notes).toHaveValue("First revision plus more typing");
    expect(screen.getByRole("button", { name: "Save changes" })).not.toBeDisabled();
  });

  it("hides disabled features and never fetches context for an unopened panel", () => {
    const view = render(<SessionWorkLinks session={{ ...session, workLinksEnabled: false }} />);
    expect(screen.queryByRole("button", { name: /^Work links/ })).not.toBeInTheDocument();
    view.rerender(<SessionWorkLinks session={session} />);
    expect(screen.getByRole("button", { name: /^Work links/ })).toBeVisible();
    expect(getWorkLinkContext).not.toHaveBeenCalled();
  });

  it("adds a titled document through the session identity and omits disabled provider choices", async () => {
    vi.mocked(getWorkLinkContext).mockResolvedValue(context([], { ...config, providers: { ...config.providers, jira: { ...provider, enabled: false } } }));
    vi.mocked(addWorkLink).mockResolvedValue({ link: record, created: true });
    render(<SessionWorkLinks session={{ ...session, workLinks: [] }} />);
    fireEvent.click(screen.getByRole("button", { name: /^Work links/ }));
    const type = await screen.findByRole("combobox", { name: "Type" });
    expect(within(type).queryByRole("option", { name: "Jira ticket" })).not.toBeInTheDocument();
    fireEvent.change(type, { target: { value: "google_docs" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Link URL" }), { target: { value: "https://docs.google.com/document/d/id/edit" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Document title" }), { target: { value: "Design notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    await waitFor(() => expect(addWorkLink).toHaveBeenCalledWith("agent-one", "history-1",
      { provider: "google_docs", url: "https://docs.google.com/document/d/id/edit", title: "Design notes" }));
  });

  it("saves provider refresh switches and multiline access instructions using config revisions", async () => {
    render(<SessionWorkLinks session={session} />);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    const github = screen.getByRole("group", { name: "GitHub PR" });
    fireEvent.click(within(github).getByRole("checkbox", { name: "Allow agent status refresh" }));
    fireEvent.change(within(github).getByRole("textbox", { name: "Agent access instructions" }),
      { target: { value: "Use the work account.\nHost: git.company.example" } });
    const updated = { ...config, providers: { ...config.providers, github: { ...provider,
      refreshEnabled: true, instructions: "Use the work account.\nHost: git.company.example" } } };
    vi.mocked(updateWorkLinkConfig).mockResolvedValue({ config: { ...updated, revision: 1 } });
    vi.mocked(getWorkLinkContext).mockResolvedValue(context([record], { ...updated, revision: 1 }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save configuration" })); });
    expect(updateWorkLinkConfig).toHaveBeenCalledWith(updated);
  });
});
