import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadAgentTranscript, type AgentTranscriptMessage, type AgentTranscriptPage, type SavedScrollbackTarget } from "./api";
import type { TranscriptExport, TranscriptView } from "./transcriptExport";

export const TRANSCRIPT_WINDOW_SIZE = 60;

interface State {
  page: AgentTranscriptPage | null;
  messages: AgentTranscriptMessage[];
  loading: boolean;
  loadingMore: boolean;
  full: TranscriptExport | null;
  fullPurpose: "search" | "end" | null;
  fullCount: number;
  fullError: string | null;
  fullCancelled: boolean;
  start: number;
  end: number;
  error: string | null;
}
const initialState: State = { page: null, messages: [], loading: true, loadingMore: false, full: null,
  fullPurpose: null, fullCount: 0, fullError: null, fullCancelled: false, start: 0, end: 0, error: null };

// Bound scans through metadata so empty native files retain an explicit retry.
async function readVisiblePage(target: SavedScrollbackTarget, source: string | null, cursor: string | null,
  signal: AbortSignal, view: TranscriptView): Promise<AgentTranscriptPage> {
  let result = await loadAgentTranscript(target, source, cursor, signal, view);
  const cursors = new Set<string>();
  for (let scans = 1; scans < 8 && result.status === "available" && !result.messages.length && result.nextCursor; scans++) {
    if (signal.aborted || cursors.has(result.nextCursor)) break;
    cursors.add(result.nextCursor);
    const next = await loadAgentTranscript(target, result.selectedSource, result.nextCursor, signal, view);
    result = { ...next, partial: result.partial || next.partial, notice: next.notice ?? result.notice };
  }
  return result;
}

export function useTranscriptPages(target: SavedScrollbackTarget, source: string | null, view: TranscriptView, revision: number) {
  const paneId = "paneId" in target ? target.paneId : undefined;
  const identity = "identity" in target ? target.identity : undefined;
  const historyId = "historyId" in target ? target.historyId : undefined;
  const selectedTarget = useMemo<SavedScrollbackTarget>(() => paneId !== undefined ? { paneId, identity } : { historyId: historyId! },
    [paneId, identity, historyId]);
  const [state, setState] = useState<State>(initialState);
  const requests = useRef<{ page: AbortController | null; full: AbortController | null; cursors: Set<string> }>({ page: null, full: null, cursors: new Set() });

  useEffect(() => {
    const controller = new AbortController();
    const epoch = { page: controller as AbortController | null, full: null as AbortController | null, cursors: new Set<string>() };
    requests.current = epoch;
    setState(initialState);
    void readVisiblePage(selectedTarget, source, null, controller.signal, view).then((page) => {
      if (controller.signal.aborted) return;
      setState({ ...initialState, page, messages: page.messages, loading: false, end: page.messages.length });
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setState((current) => ({ ...current, loading: false,
        error: failure instanceof Error ? failure.message : "Unable to load transcript" }));
    }).finally(() => { if (epoch.page === controller) epoch.page = null; });
    return () => { epoch.page?.abort(); epoch.full?.abort(); };
  }, [selectedTarget, source, view, revision]);

  const loadMore = useCallback(async () => {
    const epoch = requests.current;
    if (state.loading || epoch.page || epoch.full) return;
    if (state.full) {
      setState((current) => {
        if (!current.full) return current;
        const end = Math.min(current.end + TRANSCRIPT_WINDOW_SIZE, current.full.messages.length);
        return { ...current, messages: current.full.messages.slice(current.start, end), end };
      });
      return;
    }
    if (!state.page?.nextCursor) return;
    const previous = state.page;
    const controller = new AbortController();
    epoch.page = controller;
    epoch.cursors.add(previous.nextCursor!);
    setState((current) => ({ ...current, loadingMore: true, error: null }));
    try {
      const page = await readVisiblePage(selectedTarget, previous.selectedSource, previous.nextCursor, controller.signal, view);
      if (controller.signal.aborted) return;
      if (page.status !== "available" || page.selectedSource !== previous.selectedSource) {
        throw new Error(page.notice || "The conversation changed. Refresh and try again.");
      }
      if (page.nextCursor && epoch.cursors.has(page.nextCursor)) throw new Error("Transcript paging stopped advancing. Refresh and try again.");
      setState((current) => {
        const ids = new Set(current.messages.map((message) => message.id));
        const messages = [...current.messages, ...page.messages.filter((message) => !ids.has(message.id))];
        return { ...current, messages, end: messages.length, page: { ...page, partial: previous.partial || page.partial,
          notice: page.notice ?? previous.notice } };
      });
    } catch (failure) {
      if (!controller.signal.aborted) setState((current) => ({ ...current,
        error: failure instanceof Error ? failure.message : "Unable to load later messages" }));
    } finally {
      if (epoch.page === controller) epoch.page = null;
      if (!controller.signal.aborted) setState((current) => ({ ...current, loadingMore: false }));
    }
  }, [state.loading, state.full, state.page, selectedTarget, view]);

  const cancelFull = useCallback(() => {
    requests.current.full?.abort();
    requests.current.full = null;
    setState((current) => ({ ...current, fullPurpose: null, fullCancelled: true }));
  }, []);

  const readFull = useCallback(async (purpose: "search" | "end"): Promise<TranscriptExport | null> => {
    if (state.full) return state.full;
    const epoch = requests.current;
    if (state.loading || epoch.full || !state.page?.selectedSource || state.page.status !== "available") return null;
    epoch.page?.abort();
    epoch.page = null;
    const controller = new AbortController();
    epoch.full = controller;
    setState((current) => ({ ...current, loadingMore: false, fullPurpose: purpose, fullCount: 0, fullError: null, fullCancelled: false, error: null }));
    try {
      const { collectTranscript } = await import("./transcriptExport");
      controller.signal.throwIfAborted();
      const full = await collectTranscript(selectedTarget, state.page.selectedSource, view, controller.signal,
        (fullCount) => { if (!controller.signal.aborted) setState((current) => ({ ...current, fullCount })); }, "browse");
      controller.signal.throwIfAborted();
      setState((current) => {
        const start = Math.max(0, full.messages.findIndex((message) => message.id === current.messages[0]?.id));
        const last = full.messages.findIndex((message) => message.id === current.messages.at(-1)?.id);
        const end = last >= start ? last + 1 : Math.min(start + TRANSCRIPT_WINDOW_SIZE, full.messages.length);
        return { ...current, full, start, end, messages: full.messages.slice(start, end), fullPurpose: null };
      });
      return full;
    } catch (failure) {
      if (!controller.signal.aborted) setState((current) => ({ ...current, fullPurpose: null,
        fullError: failure instanceof Error ? failure.message : "Unable to read the full transcript" }));
      return null;
    } finally { if (epoch.full === controller) epoch.full = null; }
  }, [state.full, state.loading, state.page, selectedTarget, view]);

  const showWindow = useCallback((index: number, align: "start" | "end" | "center" = "center") => {
    setState((current) => {
      if (!current.full) return current;
      const offset = align === "start" ? 0 : align === "end" ? TRANSCRIPT_WINDOW_SIZE - 1 : Math.floor(TRANSCRIPT_WINDOW_SIZE / 2);
      const start = Math.max(0, index - offset);
      const end = Math.min(current.full.messages.length, start + TRANSCRIPT_WINDOW_SIZE);
      return { ...current, start, end, messages: current.full.messages.slice(start, end) };
    });
  }, []);
  const loadEarlier = useCallback(() => {
    setState((current) => {
      if (!current.full) return current;
      const start = Math.max(0, current.start - TRANSCRIPT_WINDOW_SIZE);
      return { ...current, start, messages: current.full.messages.slice(start, current.end) };
    });
  }, []);

  return { ...state, loadMore, loadEarlier, readFull, cancelFull, showWindow,
    hasLater: state.full ? state.end < state.full.messages.length : Boolean(state.page?.nextCursor),
    hasEarlier: state.start > 0, sources: state.page?.sources ?? [] };
}
