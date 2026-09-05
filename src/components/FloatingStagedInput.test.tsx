import { createRef, type ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLOATING_STAGED_INPUT_STORAGE_PREFIX,
  FloatingStagedInput,
  type FloatingStagedInputHandle,
} from "./FloatingStagedInput";

function desktopMediaQuery(matches = true) {
  return vi.fn(() => ({
    matches,
    media: "",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function storedPanel(workspaceId = "workspace-one") {
  return JSON.parse(window.localStorage.getItem(
    `${FLOATING_STAGED_INPUT_STORAGE_PREFIX}workspace:${workspaceId}`,
  ) || "null");
}

function panelProps(overrides: Partial<ComponentProps<typeof FloatingStagedInput>> = {}) {
  return {
    sessionName: "agent-one",
    workspaceId: "workspace-one",
    workspaceName: "Launch room",
    value: "review the current output",
    onChange: vi.fn(() => true),
    onOpenFullInput: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("matchMedia", desktopMediaQuery());
  window.localStorage.clear();
  document.documentElement.classList.remove("floating-staged-input-moving");
});

describe("FloatingStagedInput", () => {
  it("opens focused, edits the shared draft, and exposes the full composer", async () => {
    const ref = createRef<FloatingStagedInputHandle>();
    const onChange = vi.fn(() => true);
    const onOpenFullInput = vi.fn();
    render(
      <FloatingStagedInput
        {...panelProps({ onChange, onOpenFullInput })}
        ref={ref}
      />,
    );

    act(() => ref.current?.open());
    const dialog = screen.getByRole("dialog", { name: "Floating staged input" });
    const textarea = within(dialog).getByRole("textbox", {
      name: "Floating staged input",
    });
    await waitFor(() => expect(textarea).toHaveFocus());
    expect(textarea).toHaveValue("review the current output");
    expect(dialog).toHaveTextContent("Launch room / agent-one");

    fireEvent.change(textarea, { target: { value: "continue after reviewing" } });
    expect(onChange).toHaveBeenCalledWith("continue after reviewing");
    fireEvent.click(within(dialog).getByRole("button", { name: "Open full input" }));
    expect(onOpenFullInput).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Floating staged input" }))
      .not.toBeInTheDocument();
  });

  it("keeps a pinned panel across sessions and closes an unpinned panel", () => {
    const ref = createRef<FloatingStagedInputHandle>();
    const props = panelProps();
    const view = render(<FloatingStagedInput {...props} ref={ref} />);
    act(() => ref.current?.open());
    let dialog = screen.getByRole("dialog", { name: "Floating staged input" });
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Pin floating staged input",
    }));

    view.rerender(
      <FloatingStagedInput
        {...props}
        ref={ref}
        sessionName="agent-two"
        value="the second session draft"
      />,
    );
    dialog = screen.getByRole("dialog", { name: "Floating staged input" });
    expect(dialog).toHaveAttribute("data-pinned", "true");
    expect(within(dialog).getByRole("textbox", { name: "Floating staged input" }))
      .toHaveValue("the second session draft");

    fireEvent.click(within(dialog).getByRole("button", {
      name: "Unpin floating staged input",
    }));
    view.rerender(
      <FloatingStagedInput
        {...props}
        ref={ref}
        sessionName="agent-three"
        value="the third session draft"
      />,
    );
    expect(screen.queryByRole("dialog", { name: "Floating staged input" }))
      .not.toBeInTheDocument();
  });

  it("persists pin and position per workspace and moves from the title strip", () => {
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    const ref = createRef<FloatingStagedInputHandle>();
    const first = render(<FloatingStagedInput {...panelProps()} ref={ref} />);
    act(() => ref.current?.open());
    const dialog = screen.getByRole("dialog", { name: "Floating staged input" });
    const titleStrip = within(dialog).getByLabelText("Move floating staged input window");
    const left = Number.parseInt(dialog.style.left, 10);
    const top = Number.parseInt(dialog.style.top, 10);
    const rect = {
      x: left,
      y: top,
      left,
      top,
      width: 440,
      height: 250,
      right: left + 440,
      bottom: top + 250,
      toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(rect);

    fireEvent.pointerDown(titleStrip, {
      pointerId: 7,
      button: 0,
      clientX: left + 20,
      clientY: top + 18,
    });
    expect(document.documentElement).toHaveClass("floating-staged-input-moving");
    fireEvent.pointerMove(window, {
      pointerId: 7,
      clientX: left - 40,
      clientY: top + 78,
    });
    fireEvent.pointerUp(window, { pointerId: 7 });
    expect(document.documentElement).not.toHaveClass("floating-staged-input-moving");
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Pin floating staged input",
    }));

    expect(storedPanel()).toMatchObject({
      version: 1,
      panel: {
        open: true,
        pinned: true,
        position: { x: left - 60, y: top + 60 },
      },
    });
    first.unmount();

    render(<FloatingStagedInput {...panelProps()} ref={ref} />);
    expect(screen.getByRole("dialog", { name: "Floating staged input" }))
      .toHaveStyle({ left: `${left - 60}px`, top: `${top + 60}px` });
  });

  it("does not render the panel in the compact mobile layout", () => {
    vi.stubGlobal("matchMedia", desktopMediaQuery(false));
    const ref = createRef<FloatingStagedInputHandle>();
    render(<FloatingStagedInput {...panelProps()} ref={ref} />);

    act(() => ref.current?.open());
    expect(screen.queryByRole("dialog", { name: "Floating staged input" }))
      .not.toBeInTheDocument();
  });
});
