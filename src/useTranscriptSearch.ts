import { useEffect, useState } from "react";
import type { AgentTranscriptMessage } from "./api";
import type { TranscriptMatcher } from "./transcriptSearch";

interface Result {
  messages: AgentTranscriptMessage[];
  matcher: TranscriptMatcher | null;
  matches: AgentTranscriptMessage[];
  pending: boolean;
}

// Full conversations can be tens of MiB. Yield between small batches so a new
// keystroke, stop action or conversation switch can cancel the previous search.
export function useTranscriptSearch(messages: AgentTranscriptMessage[], matcher: TranscriptMatcher | null) {
  const [result, setResult] = useState<Result>({ messages, matcher, matches: [], pending: false });
  useEffect(() => {
    let active = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let index = 0;
    const matches: AgentTranscriptMessage[] = [];
    const scan = () => {
      const deadline = performance.now() + 8;
      let batch = 0;
      while (matcher && index < messages.length && batch < 100) {
        const message = messages[index++];
        if (matcher.matches(message.text)) matches.push(message);
        batch++;
        if (performance.now() >= deadline) break;
      }
      if (!active) return;
      const pending = matcher !== null && index < messages.length;
      setResult({ messages, matcher, matches: [...matches], pending });
      if (pending) timeout = setTimeout(scan, 0);
    };
    scan();
    return () => { active = false; clearTimeout(timeout); };
  }, [messages, matcher]);
  return result.messages === messages && result.matcher === matcher ? result
    : { messages, matcher, matches: [], pending: matcher !== null };
}
