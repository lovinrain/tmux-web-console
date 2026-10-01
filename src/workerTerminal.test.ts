import { describe, expect, it } from "vitest";
import { workerTerminalQuery } from "./workerTerminal";

const identity = new URLSearchParams({ sessionId: "$1", sessionCreated: "100", serverStarted: "90", serverPid: "321", paneId: "%1", panePid: "12345" });

describe("immutable worker terminal links", () => {
  it("keeps the full native identity and run/history metadata without a name", () => {
    const query = new URLSearchParams(identity);
    query.set("runId", "run-uuid");
    query.set("historyId", "history-uuid");
    expect(workerTerminalQuery(query.toString())).toBe(query.toString());
  });

  it("accepts a project workspace as navigation metadata without using it for lookup", () => {
    const query = new URLSearchParams(identity);
    query.set("workspace", "project-workspace-uuid");
    expect(new URLSearchParams(workerTerminalQuery(query.toString())).has("workspace")).toBe(false);
  });

  it.each(["sessionId", "sessionCreated", "serverStarted", "serverPid", "paneId", "panePid"])("requires %s", (field) => {
    const query = new URLSearchParams(identity);
    query.delete(field);
    expect(() => workerTerminalQuery(query.toString())).toThrow("immutable terminal identity");
  });

  it("rejects duplicated fields and name fallback", () => {
    expect(() => workerTerminalQuery(`${identity}&paneId=%252`)).toThrow("duplicate");
    expect(() => workerTerminalQuery(`${identity}&session=worker`)).toThrow("invalid");
  });
});
