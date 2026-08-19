import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionSortControls } from "./SessionSortControls";

describe("SessionSortControls", () => {
  it("shows the complete comparator order and emits accessible reorder actions", () => {
    const onChange = vi.fn();
    render(
      <SessionSortControls
        criteria={["state", "title"]}
        group="none"
        onChange={onChange}
        onGroupChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/Order: 1 State .* then 2 Title/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Move Title earlier" }));
    expect(onChange).toHaveBeenCalledWith(["title", "state"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove Title sort" }));
    expect(onChange).toHaveBeenCalledWith(["state"]);
  });

  it("appends unique criteria and keeps grouping independent", () => {
    const onChange = vi.fn();
    const onGroupChange = vi.fn();
    render(
      <SessionSortControls
        criteria={["activity", "tmux-name"]}
        group="none"
        onChange={onChange}
        onGroupChange={onGroupChange}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Add sort criterion" }), {
      target: { value: "state" },
    });
    expect(onChange).toHaveBeenCalledWith(["activity", "tmux-name", "state"]);

    fireEvent.click(screen.getByRole("button", { name: /Group State \/ attention/ }));
    expect(onGroupChange).toHaveBeenCalledWith("state");

    fireEvent.click(screen.getByRole("button", { name: /Group Tags \/ labels/ }));
    expect(onGroupChange).toHaveBeenCalledWith("tag");
  });
});
