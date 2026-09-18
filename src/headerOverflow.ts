// The console header cannot fit every control at every width: the action
// buttons alone are wider than some laptops, and breakpoints hide the rest.
// These helpers decide which controls a reader can no longer reach, so the
// header can offer them in a tray instead of dropping them silently.

export interface OverflowBox {
  left: number;
  right: number;
  width: number;
}

export interface OverflowCandidate {
  key: string;
  /** Layout box of the control itself. */
  box: OverflowBox;
  /** Box the control is clipped by - its scroll container, or the header. */
  clip?: OverflowBox;
  /** True when a media query took the control out of the layout entirely. */
  removed?: boolean;
}

// A control clipped by less than this is still readable and clickable.
const VISIBLE_EDGE_SLACK = 4;

function clipped(box: OverflowBox, clip: OverflowBox): boolean {
  if (clip.width <= 0) return true;
  return box.left < clip.left - VISIBLE_EDGE_SLACK
    || box.right > clip.right + VISIBLE_EDGE_SLACK;
}

/**
 * Keys of the controls that are present but unreachable: dropped by a media
 * query, collapsed to nothing, or cut off by the box that clips them.
 *
 * Returns nothing when the header itself has no width, which is what a
 * jsdom render and the first paint both look like. Guessing there would put a
 * tray on screen with nothing in it.
 */
export function hiddenHeaderControls(
  header: OverflowBox,
  candidates: readonly OverflowCandidate[],
): string[] {
  if (header.width <= 0) return [];
  const hidden: string[] = [];
  for (const candidate of candidates) {
    if (candidate.removed || candidate.box.width <= 0) {
      hidden.push(candidate.key);
      continue;
    }
    if (clipped(candidate.box, candidate.clip ?? header)) hidden.push(candidate.key);
  }
  return hidden;
}
