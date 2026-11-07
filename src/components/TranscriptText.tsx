import { Fragment } from "react";
import type { TranscriptMatcher } from "../transcriptSearch";

export function TranscriptText({ text, matcher }: { text: string; matcher: TranscriptMatcher | null }) {
  const ranges = matcher?.highlights(text) ?? [];
  if (!ranges.length) return <>{text}</>;
  let offset = 0;
  return <>{ranges.map(({ start, end }) => {
    const before = text.slice(offset, start);
    offset = end;
    return <Fragment key={start}>{before}<mark>{text.slice(start, end)}</mark></Fragment>;
  })}{text.slice(offset)}</>;
}
