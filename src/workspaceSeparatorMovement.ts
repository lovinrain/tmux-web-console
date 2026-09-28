export interface SeparatorAnchor { name: string; side: "before" | "after" }
export interface SeparatorCrossing { from: SeparatorAnchor; to: SeparatorAnchor }

// A divider has two possible anchors at an interior gap. Treat both as one
// destination when dragging so another divider is never overwritten or merged.
export function separatorMoveTo(
  tabs: readonly string[], before: readonly string[], after: readonly string[],
  from: SeparatorAnchor, to: SeparatorAnchor,
): SeparatorCrossing | null {
  const gap = (anchor: SeparatorAnchor) => (
    tabs.indexOf(anchor.name) + (anchor.side === "after" ? 1 : 0)
  );
  if (!tabs.includes(from.name) || !tabs.includes(to.name)
    || !(from.side === "before" ? before : after).includes(from.name)) return null;
  const destination = gap(to);
  if (gap(from) === destination
    || before.some((name) => tabs.includes(name) && gap({ name, side: "before" }) === destination)
    || after.some((name) => tabs.includes(name) && gap({ name, side: "after" }) === destination)) return null;
  return { from, to };
}

// Crossing an adjacent divider changes its anchor, not the relative order of tabs.
export function adjacentSeparatorCrossing(
  tabs: string[], selected: string[], before: string[], after: string[], direction: "previous" | "next",
): SeparatorCrossing | null {
  const selection = new Set(selected);
  const ordered = tabs.filter((name) => selection.has(name));
  if (!ordered.length) return null;
  const start = tabs.indexOf(ordered[0]);
  const end = tabs.indexOf(ordered[ordered.length - 1]);
  if (end - start + 1 !== ordered.length) return null;
  const first = tabs[start];
  const last = tabs[end];
  const from: SeparatorAnchor | null = direction === "previous"
    ? before.includes(first) ? { name: first, side: "before" }
      : after.includes(tabs[start - 1]) ? { name: tabs[start - 1], side: "after" } : null
    : after.includes(last) ? { name: last, side: "after" }
      : before.includes(tabs[end + 1]) ? { name: tabs[end + 1], side: "before" } : null;
  if (!from) return null;
  const to: SeparatorAnchor = direction === "previous"
    ? { name: last, side: "after" } : { name: first, side: "before" };
  // An occupied anchor can use the equivalent anchor on the other side of the gap.
  if ((to.side === "after" ? after : before).includes(to.name)) {
    const neighbor = direction === "previous" ? tabs[end + 1] : tabs[start - 1];
    const side = direction === "previous" ? "before" : "after";
    if (!neighbor || (side === "before" ? before : after).includes(neighbor)) return null;
    return { from, to: { name: neighbor, side } };
  }
  return { from, to };
}
