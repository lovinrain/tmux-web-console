import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSessionNavigationHistory } from "./useSessionNavigationHistory";

function setup() {
  let props = { workspace: "first", active: "alpha" as string | null, tabs: ["alpha", "beta", "gamma", "delta"] };
  const hook = renderHook(({ workspace, active, tabs }) => (
    useSessionNavigationHistory(workspace, active, tabs)
  ), { initialProps: props });
  const update = (next: Partial<typeof props>) => {
    props = { ...props, ...next };
    hook.rerender(props);
  };
  const visit = (active: string | null) => update({ active });
  const travel = (direction: "back" | "forward") => {
    let destination: string | null = null;
    act(() => {
      destination = hook.result.current.navigate(direction);
      if (destination) visit(destination);
    });
    return destination;
  };
  return { ...hook, update, visit, travel };
}

describe("session navigation history", () => {
  it("traverses visits in both directions independently of tab order", () => {
    const { result, visit, travel } = setup();
    expect(result.current.previousSession).toBeNull();
    expect(travel("back")).toBeNull();
    visit("gamma");
    visit("beta");
    expect(result.current.nextSession).toBeNull();
    expect(travel("back")).toBe("gamma");
    expect(travel("back")).toBe("alpha");
    expect(travel("back")).toBeNull();
    expect(travel("forward")).toBe("gamma");
    expect(travel("forward")).toBe("beta");
    expect(travel("forward")).toBeNull();
  });

  it("keeps the forward path on a repeated selection and replaces it on a new visit", () => {
    const { result, visit, travel } = setup();
    visit("beta");
    visit("gamma");
    travel("back");
    visit("beta");
    expect(result.current.nextSession).toBe("gamma");
    visit("delta");
    expect(result.current.nextSession).toBeNull();
    expect(travel("back")).toBe("beta");
    expect(travel("forward")).toBe("delta");
  });

  it("retains separate visits to the same session", () => {
    const { visit, travel } = setup();
    visit("beta");
    visit("alpha");
    expect(travel("back")).toBe("beta");
    expect(travel("back")).toBe("alpha");
    expect(travel("forward")).toBe("beta");
  });

  it("removes closed tabs from both directions without changing the current visit", () => {
    const { result, visit, update, travel } = setup();
    visit("beta");
    visit("gamma");
    visit("delta");
    travel("back");
    update({ tabs: ["alpha", "gamma"] });
    expect(result.current.previousSession).toBe("alpha");
    expect(result.current.nextSession).toBeNull();
    expect(travel("back")).toBe("alpha");
    expect(travel("forward")).toBe("gamma");
  });

  it("collapses adjacent copies created when a tab closes", () => {
    const { result, visit, update, travel } = setup();
    visit("beta");
    visit("alpha");
    update({ tabs: ["alpha"] });
    expect(result.current.previousSession).toBeNull();
    expect(travel("back")).toBeNull();
  });

  it("follows renamed visits and preserves a forward path when the current session is renamed", () => {
    const { result, visit, update, travel } = setup();
    visit("beta");
    visit("gamma");
    travel("back");
    act(() => {
      result.current.rename("beta", "renamed");
      update({ active: "renamed", tabs: ["alpha", "renamed", "gamma", "delta"] });
    });
    expect(result.current.previousSession).toBe("alpha");
    expect(travel("forward")).toBe("gamma");
    expect(travel("back")).toBe("renamed");
  });

  it("ignores non-session views and starts fresh when switching workspaces", () => {
    const { result, visit, update } = setup();
    visit("beta");
    visit(null);
    visit("beta");
    expect(result.current.previousSession).toBe("alpha");
    update({ workspace: "second" });
    expect(result.current.previousSession).toBeNull();
    expect(result.current.nextSession).toBeNull();
  });

  it("bounds the retained history on long-lived pages", () => {
    const { visit, travel } = setup();
    for (let index = 0; index < 105; index += 1) visit(index % 2 ? "alpha" : "beta");
    let count = 0;
    while (travel("back")) count += 1;
    expect(count).toBe(99);
  });
});
