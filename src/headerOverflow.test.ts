import { describe, expect, it } from "vitest";
import { hiddenHeaderControls, type OverflowCandidate } from "./headerOverflow";

const header = { left: 0, right: 1000, width: 1000 };

function candidate(
  key: string,
  left: number,
  right: number,
  extra: Partial<OverflowCandidate> = {},
): OverflowCandidate {
  return { key, box: { left, right, width: right - left }, ...extra };
}

describe("hidden header controls", () => {
  it("reports nothing while every control sits inside the header", () => {
    expect(hiddenHeaderControls(header, [
      candidate("scrollback", 100, 200),
      candidate("agents", 210, 300),
    ])).toEqual([]);
  });

  it("reports controls a media query took out of the layout", () => {
    expect(hiddenHeaderControls(header, [
      candidate("fit", 0, 0, { removed: true }),
      candidate("scrollback", 100, 200),
    ])).toEqual(["fit"]);
  });

  it("reports controls collapsed to no width", () => {
    expect(hiddenHeaderControls(header, [candidate("callback", 640, 640)]))
      .toEqual(["callback"]);
  });

  it("reports controls cut off by the row that clips them", () => {
    const clip = { left: 400, right: 520, width: 120 };
    expect(hiddenHeaderControls(header, [
      candidate("common-note", 400, 460, { clip }),
      candidate("session-note", 530, 590, { clip }),
      candidate("host-pulse", 470, 600, { clip }),
    ])).toEqual(["session-note", "host-pulse"]);
  });

  it("treats a clip box with no width as hiding everything inside it", () => {
    const clip = { left: 300, right: 300, width: 0 };
    expect(hiddenHeaderControls(header, [candidate("timer", 300, 372, { clip })]))
      .toEqual(["timer"]);
  });

  it("keeps a control that is clipped by less than the slack", () => {
    const clip = { left: 0, right: 500, width: 500 };
    expect(hiddenHeaderControls(header, [candidate("pin", 440, 502, { clip })]))
      .toEqual([]);
  });

  it("reports nothing before the header has been laid out", () => {
    expect(hiddenHeaderControls({ left: 0, right: 0, width: 0 }, [
      candidate("fit", 0, 0, { removed: true }),
      candidate("scrollback", 0, 0),
    ])).toEqual([]);
  });
});
