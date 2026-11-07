export type TranscriptSearchMode = "phrase" | "words" | "fuzzy";

export interface TranscriptSearchOptions {
  mode: TranscriptSearchMode;
  caseSensitive: boolean;
  wholeWords: boolean;
}

export interface TextRange { start: number; end: number }
export interface TranscriptMatcher {
  matches: (text: string) => boolean;
  highlights: (text: string) => TextRange[];
}

const wordCharacter = /[\p{L}\p{N}_]/u;
const words = /[\p{L}\p{N}_]+/gu;
const MAX_HIGHLIGHTS = 200;

function mergeRanges(ranges: TextRange[]): TextRange[] {
  const merged: TextRange[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged.slice(0, MAX_HIGHLIGHTS);
}

function normalizeWord(value: string, caseSensitive: boolean): string {
  const normalized = value.normalize("NFKD").replace(/\p{M}/gu, "");
  return caseSensitive ? normalized : normalized.toLowerCase();
}

// Bounded Damerau-Levenshtein: fuzzy text accepts short misspellings and
// transposed letters, without matching a query across an entire long message.
function nearbyWord(query: string, word: string): boolean {
  const limit = query.length >= 7 ? 2 : query.length >= 4 ? 1 : 0;
  if (!limit || Math.abs(query.length - word.length) > limit || word.length > 64 || query.length > 64) return false;
  let previous = Array.from({ length: word.length + 1 }, (_, index) => index);
  let beforePrevious = previous;
  for (let row = 1; row <= query.length; row++) {
    const current = [row];
    for (let column = 1; column <= word.length; column++) {
      const same = query[row - 1] === word[column - 1];
      const caseDifference = !same && query[row - 1].toLowerCase() === word[column - 1].toLowerCase();
      let distance = Math.min(current[column - 1] + 1, previous[column] + 1,
        previous[column - 1] + (same ? 0 : caseDifference ? limit + 1 : 1));
      if (row > 1 && column > 1 && query[row - 1] === word[column - 2] && query[row - 2] === word[column - 1]) {
        distance = Math.min(distance, beforePrevious[column - 2] + 1);
      }
      current.push(distance);
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[word.length] <= limit;
}

function fuzzyWord(query: string, word: string, wholeWords: boolean): boolean {
  if (query === word) return true;
  if (query.toLowerCase() === word.toLowerCase()) return false;
  if (nearbyWord(query, word)) return true;
  if (wholeWords) return false;
  if (word.includes(query)) return true;
  if (query.length < 2 || (query.length > 2 && query.length / word.length < 0.35)) return false;
  if (query.length === 2 && query[0] !== word[0]) return false;
  let index = 0;
  for (const character of word) {
    if (character === query[index]) index++;
    if (index === query.length) return true;
  }
  return false;
}

export function createTranscriptMatcher(query: string, options: TranscriptSearchOptions): TranscriptMatcher | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  if (options.mode === "fuzzy") {
    const tokens = [...trimmed.matchAll(words)].map((match) => normalizeWord(match[0], options.caseSensitive));
    // Punctuation-only queries should not match every message in fuzzy mode.
    if (!tokens.length) return { matches: () => false, highlights: () => [] };
    const find = (text: string, requireAll: boolean): TextRange[] => {
      const candidates = [...text.matchAll(words)].map((match) => ({
        text: normalizeWord(match[0], options.caseSensitive), start: match.index, end: match.index + match[0].length,
      }));
      const ranges: TextRange[] = [];
      for (const token of tokens) {
        let found = false;
        for (const candidate of candidates) {
          if (!fuzzyWord(token, candidate.text, options.wholeWords)) continue;
          found = true;
          if (ranges.length < MAX_HIGHLIGHTS) ranges.push({ start: candidate.start, end: candidate.end });
        }
        if (requireAll && !found) return [];
      }
      return mergeRanges(ranges);
    };
    return { matches: (text) => find(text, true).length > 0, highlights: (text) => find(text, false) };
  }
  const tokens = options.mode === "words" ? [...new Set(trimmed.split(/\s+/u))] : [trimmed];
  const patterns = tokens.map((token) => new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), options.caseSensitive ? "gu" : "giu"));
  const find = (text: string, requireAll: boolean): TextRange[] => {
    const ranges: TextRange[] = [];
    for (const pattern of patterns) {
      let found = false;
      for (const match of text.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        if (options.wholeWords && (wordCharacter.test(text.slice(Math.max(0, start - 2), start).match(/.$/u)?.[0] ?? "")
          || wordCharacter.test(text.slice(end, end + 2).match(/^./u)?.[0] ?? ""))) continue;
        found = true;
        if (ranges.length < MAX_HIGHLIGHTS) ranges.push({ start, end });
      }
      if (requireAll && !found) return [];
    }
    return mergeRanges(ranges);
  };
  return { matches: (text) => find(text, true).length > 0, highlights: (text) => find(text, false) };
}

// Operate on Markdown's parsed text nodes; marks never reinterpret transcript
// text as HTML or alter the original text used for copy and export.
interface HighlightNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HighlightNode[];
}

export function rehypeTranscriptHighlights(matcher: TranscriptMatcher | null) {
  return (tree: HighlightNode): void => {
    if (!matcher) return;
    const visit = (node: HighlightNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        const ranges = matcher.highlights(child.value);
        if (!ranges.length) return [child];
        const parts: HighlightNode[] = [];
        let offset = 0;
        for (const { start, end } of ranges) {
          if (start > offset) parts.push({ type: "text", value: child.value.slice(offset, start) });
          parts.push({ type: "element", tagName: "mark", properties: {}, children: [{ type: "text", value: child.value.slice(start, end) }] });
          offset = end;
        }
        if (offset < child.value.length) parts.push({ type: "text", value: child.value.slice(offset) });
        return parts;
      });
    };
    visit(tree);
  };
}
