import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { terminalWebSocketUrl } from "../api";
import {
  desktopAttachmentsAvailable,
  MAX_ATTACHMENT_UPLOAD_BATCH,
  transferHasFiles,
  type SessionAttachmentUploader,
} from "../attachments";
import { CloseIcon, AttachmentIcon } from "../icons";
import {
  prepareTerminalSubmission,
  type TerminalSubmissionTerminator,
} from "../terminalInput";
import { TERMINAL_THEMES, type TerminalThemeMode } from "../terminalTheme";
import type { ConnectionState } from "../types";

export interface LiveTerminalHandle {
  send: (data: string) => boolean;
  paste: (data: string) => boolean;
  submit: (data: string, terminator: TerminalSubmissionTerminator) => Promise<boolean>;
  focus: () => void;
  redraw: () => boolean;
  navigateHistory: (action: "page-up" | "page-down" | "exit") => boolean;
  jumpToLive: () => void;
}

interface LiveTerminalProps {
  session: string;
  ignoreSize: boolean;
  browserCopyMode?: boolean;
  layoutSuspended?: boolean;
  layoutRefreshToken?: string;
  theme: TerminalThemeMode;
  onUploadAttachment?: SessionAttachmentUploader;
  onStateChange: (state: ConnectionState) => void;
  onPaneChange: (paneId: string | null) => void;
}

interface TerminalAttachmentFeedback {
  tone: "success" | "error";
  title: string;
  detail: string;
  terminalText?: string;
  retry?: boolean;
}

const encoder = new TextEncoder();
const SUBMISSION_TIMEOUT_MS = 5_000;
let submissionCounter = 0;

function isMacBrowser(): boolean {
  return ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(navigator.platform);
}

function hasTerminalLinkModifier(event: MouseEvent, macBrowser: boolean): boolean {
  return macBrowser ? event.metaKey : event.ctrlKey;
}

function openTerminalWebLink(uri: string): void {
  try {
    const url = new URL(uri);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    window.open(url.href, "_blank", "noopener,noreferrer");
  } catch {
    // Terminal output is untrusted; malformed links stay inert.
  }
}

function copyMouseEvent(event: MouseEvent, forceMacSelection = false): MouseEvent {
  return new MouseEvent(event.type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: event.view,
    detail: event.detail,
    screenX: event.screenX,
    screenY: event.screenY,
    clientX: event.clientX,
    clientY: event.clientY,
    ctrlKey: event.ctrlKey,
    shiftKey: forceMacSelection ? event.shiftKey : true,
    altKey: forceMacSelection ? true : event.altKey,
    metaKey: event.metaKey,
    button: event.button,
    buttons: event.buttons,
    relatedTarget: event.relatedTarget,
  });
}

function nextSubmissionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  submissionCounter += 1;
  return `${Date.now()}-${submissionCounter}`;
}

export const LiveTerminal = forwardRef<LiveTerminalHandle, LiveTerminalProps>(
  function LiveTerminal({
    session,
    ignoreSize,
    browserCopyMode = false,
    layoutSuspended = false,
    layoutRefreshToken = "default",
    theme,
    onUploadAttachment,
    onStateChange,
    onPaneChange,
  }, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const browserCopyModeRef = useRef(browserCopyMode);
    const copySelectionActiveRef = useRef(false);
    const copyWheelRemainderRef = useRef(0);
    const layoutSuspendedRef = useRef(layoutSuspended);
    const scheduleFitAndResizeRef = useRef<(() => void) | null>(null);
    const redrawRef = useRef<(() => boolean) | null>(null);
    const attachmentUploadControllersRef = useRef(new Set<AbortController>());
    const attachmentUploadPendingRef = useRef(false);
    const attachmentDragDepthRef = useRef(0);
    const attachmentUploadGenerationRef = useRef(0);
    const attachmentFeedbackTimerRef = useRef<number | undefined>(undefined);
    const submitRef = useRef<(
      data: string,
      terminator: TerminalSubmissionTerminator,
    ) => Promise<boolean>>(
      async () => false,
    );
    const [awayFromLive, setAwayFromLive] = useState(false);
    const [attachmentDragActive, setAttachmentDragActive] = useState(false);
    const [attachmentUploadPending, setAttachmentUploadPending] = useState(false);
    const [attachmentFeedback, setAttachmentFeedback] = useState<TerminalAttachmentFeedback | null>(null);

    const clearAttachmentFeedback = () => {
      window.clearTimeout(attachmentFeedbackTimerRef.current);
      attachmentFeedbackTimerRef.current = undefined;
      setAttachmentFeedback(null);
    };

    const showAttachmentFeedback = (
      feedback: TerminalAttachmentFeedback,
      dismissAfter = 0,
    ) => {
      window.clearTimeout(attachmentFeedbackTimerRef.current);
      setAttachmentFeedback(feedback);
      attachmentFeedbackTimerRef.current = dismissAfter > 0
        ? window.setTimeout(() => {
          attachmentFeedbackTimerRef.current = undefined;
          setAttachmentFeedback(null);
        }, dismissAfter)
        : undefined;
    };

    const canHandleTerminalAttachmentDrop = () => (
      Boolean(onUploadAttachment)
      && desktopAttachmentsAvailable()
    );

    const uploadAttachmentsIntoTerminal = async (files: File[]) => {
      const uploader = onUploadAttachment;
      if (!uploader || attachmentUploadPendingRef.current || !desktopAttachmentsAvailable()) return;
      if (socketRef.current?.readyState !== WebSocket.OPEN) {
        showAttachmentFeedback({
          tone: "error",
          title: "Terminal is not live",
          detail: "Reconnect before dropping an attachment into terminal input.",
        });
        return;
      }

      if (files.length === 0) {
        showAttachmentFeedback({
          tone: "error",
          title: "No file attached",
          detail: "Drop at least one file into the terminal.",
        });
        return;
      }

      const selected = files.slice(0, MAX_ATTACHMENT_UPLOAD_BATCH);
      const ignoredCount = files.length - selected.length;
      const controller = new AbortController();
      const generation = attachmentUploadGenerationRef.current;
      attachmentUploadControllersRef.current.add(controller);
      attachmentUploadPendingRef.current = true;
      setAttachmentUploadPending(true);
      clearAttachmentFeedback();

      const completed = await Promise.all(selected.map(async (file) => {
        try {
          return { file, uploaded: await uploader(file, controller.signal) };
        } catch (error) {
          return { file, error };
        }
      }));
      attachmentUploadControllersRef.current.delete(controller);
      if (controller.signal.aborted || generation !== attachmentUploadGenerationRef.current) return;

      const successful = completed.filter((result) => "uploaded" in result) as Array<{
        file: File;
        uploaded: Awaited<ReturnType<SessionAttachmentUploader>>;
      }>;
      const failed = completed.filter((result) => "error" in result) as Array<{
        file: File;
        error: unknown;
      }>;
      if (successful.length === 0) {
        attachmentUploadPendingRef.current = false;
        setAttachmentUploadPending(false);
        const firstError = failed[0]?.error;
        showAttachmentFeedback({
          tone: "error",
          title: "File upload failed",
          detail: firstError instanceof Error
            ? firstError.message
            : `Unable to upload ${failed[0]?.file.name || "the file"}.`,
        });
        return;
      }

      const terminalText = successful
        .map(({ uploaded }) => uploaded.terminalText || uploaded.path)
        .join(" ");
      const accepted = await submitRef.current(`${terminalText} `, "none");
      if (controller.signal.aborted || generation !== attachmentUploadGenerationRef.current) return;
      attachmentUploadPendingRef.current = false;
      setAttachmentUploadPending(false);

      if (!accepted) {
        showAttachmentFeedback({
          tone: "error",
          title: successful.length === 1 ? "File uploaded" : "Files uploaded",
          detail: "The terminal disconnected before the path was pasted. Reconnect, then paste again.",
          terminalText,
          retry: true,
        });
        return;
      }

      terminalRef.current?.focus();
      const ignoredDetail = ignoredCount > 0
        ? ` ${ignoredCount} other ${ignoredCount === 1 ? "file was" : "files were"} ignored.`
        : "";
      if (failed.length > 0) {
        const firstError = failed[0].error;
        showAttachmentFeedback({
          tone: "error",
          title: `${successful.length} ${successful.length === 1 ? "path" : "paths"} pasted; ${failed.length} failed`,
          detail: `${firstError instanceof Error ? firstError.message : "A file could not be uploaded."} No Enter was sent.${ignoredDetail}`,
          terminalText,
        });
        return;
      }
      showAttachmentFeedback({
        tone: "success",
        title: successful.length === 1 ? "File path pasted" : "File paths pasted",
        detail: `Inserted at the live terminal cursor without Enter.${ignoredDetail}`,
        terminalText,
      }, 7_000);
    };

    const handleAttachmentDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
      if (!canHandleTerminalAttachmentDrop() || !transferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      attachmentDragDepthRef.current += 1;
      setAttachmentDragActive(true);
    };

    const handleAttachmentDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
      if (!canHandleTerminalAttachmentDrop() || !transferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };

    const handleAttachmentDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
      if (attachmentDragDepthRef.current === 0) return;
      event.preventDefault();
      attachmentDragDepthRef.current = Math.max(0, attachmentDragDepthRef.current - 1);
      if (attachmentDragDepthRef.current === 0) setAttachmentDragActive(false);
    };

    const handleAttachmentDrop = (event: ReactDragEvent<HTMLDivElement>) => {
      if (!canHandleTerminalAttachmentDrop() || !transferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      attachmentDragDepthRef.current = 0;
      setAttachmentDragActive(false);
      void uploadAttachmentsIntoTerminal(Array.from(event.dataTransfer.files));
    };

    const copyUploadedAttachmentPaths = async () => {
      if (!attachmentFeedback?.terminalText) return;
      try {
        await navigator.clipboard.writeText(attachmentFeedback.terminalText);
        showAttachmentFeedback({
          ...attachmentFeedback,
          tone: "success",
          title: "File path copied",
          detail: "Paste it wherever you need it; the server file remains private.",
        }, 5_000);
      } catch {
        showAttachmentFeedback({
          ...attachmentFeedback,
          tone: "error",
          title: "Clipboard unavailable",
          detail: "Select the path shown here and copy it manually.",
        });
      }
    };

    const retryUploadedAttachmentPaths = async () => {
      if (!attachmentFeedback?.terminalText || attachmentUploadPendingRef.current) return;
      const generation = attachmentUploadGenerationRef.current;
      const terminalText = attachmentFeedback.terminalText;
      attachmentUploadPendingRef.current = true;
      setAttachmentUploadPending(true);
      const accepted = await submitRef.current(`${terminalText} `, "none");
      if (generation !== attachmentUploadGenerationRef.current) return;
      attachmentUploadPendingRef.current = false;
      setAttachmentUploadPending(false);
      if (accepted) {
        terminalRef.current?.focus();
        showAttachmentFeedback({
          tone: "success",
          title: "File path pasted",
          detail: "Inserted at the live terminal cursor without Enter.",
          terminalText,
        }, 7_000);
      } else {
        showAttachmentFeedback({
          ...attachmentFeedback,
          tone: "error",
          title: "Terminal still unavailable",
          detail: "The file is safe on the server. Reconnect and try pasting again.",
          retry: true,
        });
      }
    };

    useEffect(() => {
      attachmentUploadGenerationRef.current += 1;
      attachmentDragDepthRef.current = 0;
      attachmentUploadPendingRef.current = false;
      setAttachmentDragActive(false);
      setAttachmentUploadPending(false);
      setAttachmentFeedback(null);
      return () => {
        attachmentUploadGenerationRef.current += 1;
        for (const controller of attachmentUploadControllersRef.current) controller.abort();
        attachmentUploadControllersRef.current.clear();
        window.clearTimeout(attachmentFeedbackTimerRef.current);
        attachmentFeedbackTimerRef.current = undefined;
      };
    }, [session]);

    useLayoutEffect(() => {
      const wasEnabled = browserCopyModeRef.current;
      browserCopyModeRef.current = browserCopyMode;
      if (wasEnabled && !browserCopyMode) {
        copySelectionActiveRef.current = false;
        copyWheelRemainderRef.current = 0;
        terminalRef.current?.clearSelection();
      }
    }, [browserCopyMode]);

    useLayoutEffect(() => {
      const wasSuspended = layoutSuspendedRef.current;
      layoutSuspendedRef.current = layoutSuspended;
      if (wasSuspended && !layoutSuspended) scheduleFitAndResizeRef.current?.();
    }, [layoutSuspended]);

    useLayoutEffect(() => {
      const frame = window.requestAnimationFrame(() => {
        scheduleFitAndResizeRef.current?.();
      });
      return () => window.cancelAnimationFrame(frame);
    }, [layoutRefreshToken]);

    useImperativeHandle(ref, () => ({
      send(data: string) {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          try {
            socketRef.current.send(encoder.encode(data));
            return true;
          } catch {
            return false;
          }
        }
        return false;
      },
      paste(data: string) {
        if (
          socketRef.current?.readyState !== WebSocket.OPEN
          || terminalRef.current === null
        ) return false;
        try {
          terminalRef.current.paste(data);
          return true;
        } catch {
          return false;
        }
      },
      submit(data: string, terminator: TerminalSubmissionTerminator) {
        return submitRef.current(data, terminator);
      },
      focus() {
        terminalRef.current?.focus();
      },
      redraw() {
        return redrawRef.current?.() ?? false;
      },
      navigateHistory(action) {
        if (socketRef.current?.readyState !== WebSocket.OPEN) return false;
        try {
          socketRef.current.send(JSON.stringify({ type: "history", action }));
          return true;
        } catch {
          return false;
        }
      },
      jumpToLive() {
        terminalRef.current?.scrollToBottom();
        setAwayFromLive(false);
      },
    }), []);

    useEffect(() => {
      if (!hostRef.current) return;
      setAwayFromLive(false);
      let cancelled = false;
      let ended = false;
      let reconnectTimer: number | undefined;
      let resizeTimer: number | undefined;
      let attempts = 0;
      let lastResize: { socket: WebSocket; cols: number; rows: number } | null = null;
      let terminalElement: HTMLElement | undefined;
      let hoveredTerminalLink: string | null = null;
      let pressedTerminalLink: string | null = null;
      const pendingSubmissions = new Map<string, {
        resolve: (accepted: boolean) => void;
        timer: number;
      }>();
      const macBrowser = isMacBrowser();
      const linkModifierLabel = macBrowser ? "Cmd" : "Ctrl";
      const activateTerminalLink = (event: MouseEvent, uri: string) => {
        if (
          browserCopyModeRef.current
          || event.button !== 0
          || !hasTerminalLinkModifier(event, macBrowser)
        ) return;
        openTerminalWebLink(uri);
      };
      const hoverTerminalLink = (_event: MouseEvent, uri: string) => {
        hoveredTerminalLink = uri;
        terminalElement?.setAttribute(
          "title",
          `${linkModifierLabel}+click to open ${uri}`,
        );
      };
      const leaveTerminalLink = (_event: MouseEvent, uri: string) => {
        if (hoveredTerminalLink !== uri) return;
        hoveredTerminalLink = null;
        pressedTerminalLink = null;
        terminalElement?.removeAttribute("title");
      };

      const terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        fontFamily: '"JetBrains Mono Variable", monospace',
        fontSize: 13,
        fontWeight: 430,
        lineHeight: 1.08,
        letterSpacing: 0,
        scrollback: 5000,
        allowTransparency: true,
        linkHandler: {
          activate: activateTerminalLink,
          hover: hoverTerminalLink,
          leave: leaveTerminalLink,
        },
        theme: TERMINAL_THEMES[theme],
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(hostRef.current);
      terminalRef.current = terminal;
      let suppressTerminalInput = false;
      terminalElement = terminal.element;
      terminal.loadAddon(new WebLinksAddon(activateTerminalLink, {
        hover: hoverTerminalLink,
        leave: leaveTerminalLink,
      }));
      const terminalDocument = terminalElement?.ownerDocument;
      const replayedMouseEvents = new WeakSet<MouseEvent>();

      terminal.attachCustomKeyEventHandler((event) => {
        if (!browserCopyModeRef.current || event.altKey) return true;
        const clipboardModifier = macBrowser
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey;
        if (!clipboardModifier) return true;
        const key = event.key.toLowerCase();
        return key !== "c" && key !== "v";
      });

      const dispatchMouseEvent = (target: EventTarget, event: MouseEvent) => {
        replayedMouseEvents.add(event);
        suppressTerminalInput = true;
        try {
          target.dispatchEvent(event);
        } finally {
          suppressTerminalInput = false;
        }
      };

      const handleModifiedLinkMouseEvent = (event: MouseEvent) => {
        if (browserCopyModeRef.current || event.button !== 0) return;
        if (event.type === "mousedown") {
          if (
            hoveredTerminalLink === null
            || !hasTerminalLinkModifier(event, macBrowser)
          ) return;
          pressedTerminalLink = hoveredTerminalLink;
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (pressedTerminalLink === null) return;
        const uri = pressedTerminalLink;
        pressedTerminalLink = null;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (
          hoveredTerminalLink === uri
          && hasTerminalLinkModifier(event, macBrowser)
        ) openTerminalWebLink(uri);
      };

      const handleCopyMouseDown = (event: MouseEvent) => {
        if (!browserCopyModeRef.current || replayedMouseEvents.has(event)) return;
        event.stopImmediatePropagation();
        if (event.button !== 0 || !terminalElement) return;
        event.preventDefault();
        copySelectionActiveRef.current = true;
        const forcedEvent = copyMouseEvent(event, macBrowser);
        const previousMacSelection = terminal.options.macOptionClickForcesSelection;
        if (macBrowser) terminal.options.macOptionClickForcesSelection = true;
        try {
          dispatchMouseEvent(
            event.target instanceof Element ? event.target : terminalElement,
            forcedEvent,
          );
        } finally {
          if (macBrowser) {
            terminal.options.macOptionClickForcesSelection = previousMacSelection;
          }
        }
      };

      const replayCopyDragEvent = (event: MouseEvent) => {
        if (
          !browserCopyModeRef.current
          || !copySelectionActiveRef.current
          || replayedMouseEvents.has(event)
          || !terminalDocument
        ) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        dispatchMouseEvent(terminalDocument, copyMouseEvent(event, macBrowser));
        if (event.type === "mouseup") copySelectionActiveRef.current = false;
      };

      const blockCopyMouseMove = (event: MouseEvent) => {
        if (!browserCopyModeRef.current || replayedMouseEvents.has(event)) return;
        event.stopImmediatePropagation();
      };

      const blockCopyClick = (event: MouseEvent) => {
        if (!browserCopyModeRef.current) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };

      const handleCopyWheel = (event: WheelEvent) => {
        if (!browserCopyModeRef.current || !terminalElement) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const rowHeight = Math.max(1, terminalElement.clientHeight / Math.max(1, terminal.rows));
        const lineDelta = event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * terminal.rows
          : event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? event.deltaY
            : event.deltaY / rowHeight;
        copyWheelRemainderRef.current += lineDelta;
        const wholeLines = Math.trunc(copyWheelRemainderRef.current);
        if (wholeLines !== 0) {
          copyWheelRemainderRef.current -= wholeLines;
          terminal.scrollLines(wholeLines);
        }
      };

      terminalElement?.addEventListener("mousedown", handleModifiedLinkMouseEvent, true);
      terminalElement?.addEventListener("mouseup", handleModifiedLinkMouseEvent, true);
      terminalElement?.addEventListener("mousedown", handleCopyMouseDown, true);
      terminalElement?.addEventListener("mousemove", blockCopyMouseMove, true);
      terminalElement?.addEventListener("click", blockCopyClick, true);
      terminalElement?.addEventListener("wheel", handleCopyWheel, { capture: true, passive: false });
      terminalDocument?.addEventListener("mousemove", replayCopyDragEvent, true);
      terminalDocument?.addEventListener("mouseup", replayCopyDragEvent, true);
      const redraw = () => {
        if (cancelled || terminalRef.current !== terminal) return false;
        try {
          // xterm uses this public repair API to invalidate its renderer and repaint all rows.
          terminal.clearTextureAtlas();
          return true;
        } catch {
          return false;
        }
      };
      redrawRef.current = redraw;

      const settleSubmission = (id: string, accepted: boolean) => {
        const pending = pendingSubmissions.get(id);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        pendingSubmissions.delete(id);
        pending.resolve(accepted);
      };

      const rejectPendingSubmissions = () => {
        for (const id of [...pendingSubmissions.keys()]) settleSubmission(id, false);
      };

      submitRef.current = async (data: string, terminator: TerminalSubmissionTerminator) => {
        const socket = socketRef.current;
        if (socket?.readyState !== WebSocket.OPEN || terminalRef.current !== terminal) return false;
        const id = nextSubmissionId();
        const prepared = prepareTerminalSubmission(
          data,
          terminator,
          terminal.modes.bracketedPasteMode,
        );
        return new Promise<boolean>((resolve) => {
          const timer = window.setTimeout(() => settleSubmission(id, false), SUBMISSION_TIMEOUT_MS);
          pendingSubmissions.set(id, { resolve, timer });
          try {
            socket.send(JSON.stringify({ type: "input", id, data: prepared }));
          } catch {
            settleSubmission(id, false);
          }
        });
      };

      const sendResize = () => {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          if (
            lastResize?.socket === socket
            && lastResize.cols === terminal.cols
            && lastResize.rows === terminal.rows
          ) return;
          socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
          lastResize = { socket, cols: terminal.cols, rows: terminal.rows };
        }
      };

      const fitAndResize = () => {
        if (cancelled || layoutSuspendedRef.current || !hostRef.current) return;
        try {
          fit.fit();
          // Invalidate every row after the host grows so xterm paints the newly exposed area.
          terminal.refresh(0, terminal.rows - 1);
          sendResize();
        } catch {
          // The terminal can briefly have zero height while the mobile keyboard moves.
        }
      };

      const scheduleFitAndResize = () => {
        if (layoutSuspendedRef.current) return;
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(fitAndResize, 80);
      };
      scheduleFitAndResizeRef.current = scheduleFitAndResize;

      const connect = () => {
        if (cancelled || ended) return;
        onStateChange(attempts > 0 ? "reconnecting" : "connecting");
        const socket = new WebSocket(
          terminalWebSocketUrl(session, terminal.cols, terminal.rows, ignoreSize),
        );
        socket.binaryType = "arraybuffer";
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (!cancelled) sendResize();
        });
        socket.addEventListener("message", (event) => {
          if (cancelled) return;
          if (event.data instanceof ArrayBuffer) {
            terminal.write(new Uint8Array(event.data));
            return;
          }
          if (event.data instanceof Blob) {
            void event.data.arrayBuffer().then((data) => {
              if (!cancelled) terminal.write(new Uint8Array(data));
            });
            return;
          }
          try {
            const message = JSON.parse(String(event.data)) as {
              type: string;
              id?: string;
              paneId?: string | null;
              message?: string;
            };
            if (message.type === "inputAck" && message.id) {
              settleSubmission(message.id, true);
            } else if (message.type === "inputNack" && message.id) {
              settleSubmission(message.id, false);
            } else if (message.type === "ready") {
              attempts = 0;
              onPaneChange(message.paneId || null);
              onStateChange("live");
            } else if (message.type === "exit") {
              ended = true;
              onStateChange("ended");
              socket.close();
            } else if (message.type === "error") {
              terminal.writeln(`\r\n[Muxdeck: ${message.message || "terminal error"}]`);
              onStateChange("error");
            }
          } catch {
            // Only JSON control frames are sent as text.
          }
        });
        socket.addEventListener("close", () => {
          if (socketRef.current === socket) socketRef.current = null;
          rejectPendingSubmissions();
          if (cancelled || ended) return;
          attempts += 1;
          onStateChange("reconnecting");
          reconnectTimer = window.setTimeout(connect, Math.min(1000 * 2 ** (attempts - 1), 8000));
        });
        socket.addEventListener("error", () => {
          if (!cancelled) onStateChange("error");
        });
      };

      const input = terminal.onData((data) => {
        if (suppressTerminalInput) return;
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(encoder.encode(data));
        }
      });
      const scroll = terminal.onScroll(() => {
        const buffer = terminal.buffer.active;
        setAwayFromLive(buffer.viewportY < buffer.baseY);
      });
      const resizeObserver = new ResizeObserver(() => {
        scheduleFitAndResize();
      });
      resizeObserver.observe(hostRef.current);
      window.visualViewport?.addEventListener("resize", scheduleFitAndResize);
      window.visualViewport?.addEventListener("scroll", scheduleFitAndResize);

      requestAnimationFrame(() => {
        fitAndResize();
        connect();
      });

      return () => {
        cancelled = true;
        submitRef.current = async () => false;
        rejectPendingSubmissions();
        onStateChange("disconnected");
        window.clearTimeout(reconnectTimer);
        window.clearTimeout(resizeTimer);
        if (scheduleFitAndResizeRef.current === scheduleFitAndResize) {
          scheduleFitAndResizeRef.current = null;
        }
        if (redrawRef.current === redraw) redrawRef.current = null;
        copySelectionActiveRef.current = false;
        copyWheelRemainderRef.current = 0;
        terminalElement?.removeEventListener("mousedown", handleModifiedLinkMouseEvent, true);
        terminalElement?.removeEventListener("mouseup", handleModifiedLinkMouseEvent, true);
        terminalElement?.removeEventListener("mousedown", handleCopyMouseDown, true);
        terminalElement?.removeEventListener("mousemove", blockCopyMouseMove, true);
        terminalElement?.removeEventListener("click", blockCopyClick, true);
        terminalElement?.removeEventListener("wheel", handleCopyWheel, true);
        terminalDocument?.removeEventListener("mousemove", replayCopyDragEvent, true);
        terminalDocument?.removeEventListener("mouseup", replayCopyDragEvent, true);
        resizeObserver.disconnect();
        window.visualViewport?.removeEventListener("resize", scheduleFitAndResize);
        window.visualViewport?.removeEventListener("scroll", scheduleFitAndResize);
        input.dispose();
        scroll.dispose();
        socketRef.current?.close(1000, "view closed");
        socketRef.current = null;
        terminal.dispose();
        terminalRef.current = null;
      };
    }, [ignoreSize, onPaneChange, onStateChange, session]);

    useEffect(() => {
      if (terminalRef.current) {
        terminalRef.current.options.theme = TERMINAL_THEMES[theme];
      }
    }, [theme]);

    return (
      <div
        id="muxdeck-active-console"
        className="terminal-stage"
        data-copy-mode={browserCopyMode ? "true" : "false"}
        data-attachment-drag-active={attachmentDragActive ? "true" : "false"}
        data-attachment-uploading={attachmentUploadPending ? "true" : "false"}
        role="tabpanel"
        aria-label={`${session} live terminal`}
        aria-busy={attachmentUploadPending}
        onDragEnterCapture={handleAttachmentDragEnter}
        onDragOverCapture={handleAttachmentDragOver}
        onDragLeaveCapture={handleAttachmentDragLeave}
        onDropCapture={handleAttachmentDrop}
      >
        <div
          ref={hostRef}
          className="terminal-host"
          onPointerDown={(event) => {
            if (event.pointerType !== "touch") terminalRef.current?.focus();
          }}
        />
        {awayFromLive && (
          <button type="button" className="jump-live" onClick={() => {
            terminalRef.current?.scrollToBottom();
            setAwayFromLive(false);
          }}>
            Jump to live
          </button>
        )}
        {(attachmentDragActive || attachmentUploadPending) && (
          <div className="terminal-attachment-drop-overlay" role="status" aria-live="polite">
            <AttachmentIcon />
            <strong>{attachmentUploadPending ? "Uploading files..." : "Drop files into terminal input"}</strong>
            <span>{attachmentUploadPending
              ? "The private server path will be pasted when the upload finishes."
              : "Uploads to this host, pastes the path at the cursor, and never presses Enter."}</span>
          </div>
        )}
        {!attachmentDragActive && !attachmentUploadPending && attachmentFeedback && (
          <aside
            className={`terminal-attachment-feedback ${attachmentFeedback.tone}`}
            role={attachmentFeedback.tone === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            <AttachmentIcon />
            <div>
              <strong>{attachmentFeedback.title}</strong>
              <span>{attachmentFeedback.detail}</span>
              {attachmentFeedback.terminalText && (
                <code title={attachmentFeedback.terminalText}>{attachmentFeedback.terminalText}</code>
              )}
            </div>
            <div className="terminal-attachment-feedback-actions">
              {attachmentFeedback.retry && (
                <button type="button" onClick={() => void retryUploadedAttachmentPaths()}>
                  Paste again
                </button>
              )}
              {attachmentFeedback.terminalText && (
                <button
                  type="button"
                  title={attachmentFeedback.terminalText}
                  aria-label="Copy uploaded file path"
                  onClick={() => void copyUploadedAttachmentPaths()}
                >
                  Copy path
                </button>
              )}
              <button
                type="button"
                className="terminal-attachment-feedback-dismiss"
                aria-label="Dismiss file attachment status"
                onClick={clearAttachmentFeedback}
              >
                <CloseIcon />
              </button>
            </div>
          </aside>
        )}
      </div>
    );
  },
);
