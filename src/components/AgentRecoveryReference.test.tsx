import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRecoveryReference } from "./AgentRecoveryReference";

const ID = "df0316ae-6484-4533-8bed-54a677121a2e";

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
});

describe("AgentRecoveryReference", () => {
  it("names the agent, shows its id, and offers the resume command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(<AgentRecoveryReference
      sessionName="rose-ee-3-BS2_12_2"
      agentType="claude"
      agentSessionId={ID}
    />);

    expect(screen.getByText("Claude")).toBeVisible();
    expect(screen.getByText(ID)).toBeVisible();
    expect(screen.getByText(`claude -r ${ID}`)).toBeVisible();
    expect(screen.getByText(/Uncommitted work, running commands/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", {
      name: "Copy resume command for rose-ee-3-BS2_12_2",
    }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`claude -r ${ID}`));
    expect(await screen.findByRole("button", { name: /Copy resume command/ }))
      .toHaveTextContent("Copied");
  });

  it("falls back to manual selection when the clipboard is unavailable", async () => {
    // A console reached over plain HTTP has no secure context.
    setClipboard(undefined);
    render(<AgentRecoveryReference
      sessionName="jo_main"
      agentType="codex"
      agentSessionId={ID}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Copy resume command for jo_main" }));
    const manual = await screen.findByRole("textbox", {
      name: "Resume command for jo_main, select and copy manually",
    });
    expect(manual).toHaveValue(`codex resume ${ID}`);
  });

  it("still names the agent when no session id was recorded", () => {
    render(<AgentRecoveryReference
      sessionName="cali1_2"
      agentType="claude"
      agentSessionId={null}
    />);

    expect(screen.getByText("Claude")).toBeVisible();
    expect(screen.getByText("no recorded session id")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Copy resume command/ }))
      .not.toBeInTheDocument();
  });

  it("explains when an agent has no known resume command", () => {
    render(<AgentRecoveryReference
      sessionName="pilot"
      agentType="copilot"
      agentSessionId={ID}
    />);

    expect(screen.getByText(ID)).toBeVisible();
    expect(screen.getByText(/No resume command is known/)).toBeVisible();
  });

  it("renders nothing for a plain shell with no reference at all", () => {
    const { container } = render(<AgentRecoveryReference
      sessionName="plain"
      agentType={null}
      agentSessionId={null}
    />);
    expect(container).toBeEmptyDOMElement();
  });
});
