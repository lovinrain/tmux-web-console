import { describe, expect, it } from "vitest";
import { createTranscriptMatcher, type TranscriptSearchOptions } from "./transcriptSearch";

const phrase: TranscriptSearchOptions = { mode: "phrase", caseSensitive: false, wholeWords: false };

describe("transcript search", () => {
  it.each([
    ["deploy service", "Deploy service safely", true],
    ["deploy service", "Deploy the service safely", false],
    ["a+b [done]", "Literal a+b [done] found", true],
    ["a+b [done]", "aaab done", false],
    ["世界", "你好，世界", true],
  ])("matches literal phrases %s in %s", (query, text, found) => {
    expect(createTranscriptMatcher(query, phrase)?.matches(text)).toBe(found);
  });

  it("supports case and Unicode word boundaries with original highlight offsets", () => {
    const matcher = createTranscriptMatcher("fix", { ...phrase, wholeWords: true })!;
    expect(matcher.matches("prefix")).toBe(false);
    expect(matcher.matches("𐐀fix")).toBe(false);
    expect(matcher.highlights("FIX, fix; prefix fix_it")).toEqual([{ start: 0, end: 3 }, { start: 5, end: 8 }]);
    expect(createTranscriptMatcher("fix", { ...phrase, caseSensitive: true })?.matches("FIX")).toBe(false);
    expect(createTranscriptMatcher("é", { ...phrase, wholeWords: true })?.matches("café")).toBe(false);
  });

  it("requires every word in any order and highlights words across separate formatted nodes", () => {
    const matcher = createTranscriptMatcher("migrate SQLite", { ...phrase, mode: "words" })!;
    expect(matcher.matches("SQLite: we can now migrate the database")).toBe(true);
    expect(matcher.matches("SQLite database only")).toBe(false);
    expect(matcher.highlights("We migrate")).toEqual([{ start: 3, end: 10 }]);
    expect(matcher.highlights("SQLite")).toEqual([{ start: 0, end: 6 }]);
  });

  it.each([
    ["transcirpt", "Read the transcript", true],
    ["depoy", "Deploy the service", true],
    ["dply", "Deploy the service", true],
    ["cafe", "Café is ready", true],
    ["世界", "你好世界", true],
    ["dply db", "Deploy the database", true],
    ["xyz", "Deploy the service", false],
    ["dply xyz", "Deploy the service", false],
    ["abc", "a long message with b then eventually c", false],
    ["!!!", "A real message", false],
  ])("fuzzy-matches %s in %s", (query, text, found) => {
    expect(createTranscriptMatcher(query, { ...phrase, mode: "fuzzy" })?.matches(text)).toBe(found);
  });

  it("keeps fuzzy case and word options and highlights original accented text", () => {
    const fuzzy = { ...phrase, mode: "fuzzy" as const };
    expect(createTranscriptMatcher("Deploy", { ...fuzzy, caseSensitive: true })?.matches("deploy")).toBe(false);
    expect(createTranscriptMatcher("Deployer", { ...fuzzy, caseSensitive: true })?.matches("deployer")).toBe(false);
    expect(createTranscriptMatcher("Deploer", { ...fuzzy, caseSensitive: true })?.matches("deployer")).toBe(false);
    expect(createTranscriptMatcher("deploy", { ...fuzzy, wholeWords: true })?.matches("deployment")).toBe(false);
    expect(createTranscriptMatcher("depoy", { ...fuzzy, wholeWords: true })?.matches("deploy")).toBe(true);
    expect(createTranscriptMatcher("cafe", fuzzy)?.highlights("A Café reply")).toEqual([{ start: 2, end: 6 }]);
  });

  it("merges overlapping highlights and bounds dense results without changing the match decision", () => {
    const matcher = createTranscriptMatcher("reply repl", { ...phrase, mode: "words" })!;
    expect(matcher.highlights("reply")).toEqual([{ start: 0, end: 5 }]);
    const dense = createTranscriptMatcher("x", phrase)!;
    expect(dense.highlights("x ".repeat(1000))).toHaveLength(200);
    expect(dense.matches("x ".repeat(1000))).toBe(true);
    expect(createTranscriptMatcher(" \n ", phrase)).toBeNull();
  });
});
