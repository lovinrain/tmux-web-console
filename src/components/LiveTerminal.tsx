import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { terminalWebSocketUrl } from "../api";
import { prepareTerminalSubmission } from "../terminalInput";
import type { ConnectionState } from "../types";

export interface LiveTerminalHandle {
  send: (data: string) => boolean;
  paste: (data: string) => boolean;
  submit: (data: string, withEnter: boolean) => Promise<boolean>;
  focus: () => void;
  jumpToLive: () => void;
}

interface LiveTerminalProps {
  session: string;
  ignoreSize: boolean;
  onStateChange: (state: ConnectionState) => void;
  onPaneChange: (paneId: string | null) => void;
}

const encoder = new TextEncoder();
const SUBMISSION_TIMEOUT_MS = 5_000;
let submissionCounter = 0;

function nextSubmissionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  submissionCounter += 1;
  return `${Date.now()}-${submissionCounter}`;
}

export const LiveTerminal = forwardRef<LiveTerminalHandle, LiveTerminalProps>(
  function LiveTerminal({ session, ignoreSize, onStateChange, onPaneChange }, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const submitRef = useRef<(data: string, withEnter: boolean) => Promise<boolean>>(
      async () => false,
    );
    const [awayFromLive, setAwayFromLive] = useState(false);

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
      submit(data: string, withEnter: boolean) {
        return submitRef.current(data, withEnter);
      },
      focus() {
        terminalRef.current?.focus();
      },
      jumpToLive() {
        terminalRef.current?.scrollToBottom();
        setAwayFromLive(false);
      },
    }), []);

    useEffect(() => {
      if (!hostRef.current) return;
      let cancelled = false;
      let ended = false;
      let reconnectTimer: number | undefined;
      let resizeTimer: number | undefined;
      let attempts = 0;
      const pendingSubmissions = new Map<string, {
        resolve: (accepted: boolean) => void;
        timer: number;
      }>();

      const terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        fontFamily: '"JetBrains Mono Variable", monospace',
        fontSize: window.innerWidth < 640 ? 11 : 13,
        fontWeight: 430,
        lineHeight: 1.08,
        letterSpacing: 0,
        scrollback: 5000,
        allowTransparency: true,
        theme: {
          background: "#0b0e0c",
          foreground: "#e3e8df",
          cursor: "#ffb648",
          cursorAccent: "#0b0e0c",
          selectionBackground: "#bbf45144",
          black: "#151915",
          red: "#ff6b5f",
          green: "#bbf451",
          yellow: "#ffca68",
          blue: "#77bdfb",
          magenta: "#d9a0ff",
          cyan: "#68dfd0",
          white: "#e3e8df",
          brightBlack: "#667064",
          brightRed: "#ff8f86",
          brightGreen: "#d1ff7d",
          brightYellow: "#ffdd95",
          brightBlue: "#9ed0ff",
          brightMagenta: "#e7bdff",
          brightCyan: "#91f1e4",
          brightWhite: "#ffffff",
        },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(hostRef.current);
      terminalRef.current = terminal;

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

      submitRef.current = async (data: string, withEnter: boolean) => {
        const socket = socketRef.current;
        if (socket?.readyState !== WebSocket.OPEN || terminalRef.current !== terminal) return false;
        const id = nextSubmissionId();
        const prepared = prepareTerminalSubmission(
          data,
          withEnter,
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
          socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
        }
      };

      const fitAndResize = () => {
        if (cancelled || !hostRef.current) return;
        try {
          fit.fit();
          sendResize();
        } catch {
          // The terminal can briefly have zero height while the mobile keyboard moves.
        }
      };

      const connect = () => {
        if (cancelled || ended) return;
        onStateChange(attempts > 0 ? "reconnecting" : "connecting");
        const socket = new WebSocket(
          terminalWebSocketUrl(session, terminal.cols, terminal.rows, ignoreSize),
        );
        socket.binaryType = "arraybuffer";
        socketRef.current = socket;

        socket.addEventListener("open", () => sendResize());
        socket.addEventListener("message", (event) => {
          if (event.data instanceof ArrayBuffer) {
            terminal.write(new Uint8Array(event.data));
            return;
          }
          if (event.data instanceof Blob) {
            void event.data.arrayBuffer().then((data) => terminal.write(new Uint8Array(data)));
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
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(encoder.encode(data));
        }
      });
      const scroll = terminal.onScroll(() => {
        const buffer = terminal.buffer.active;
        setAwayFromLive(buffer.viewportY < buffer.baseY);
      });
      const resizeObserver = new ResizeObserver(() => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(fitAndResize, 80);
      });
      resizeObserver.observe(hostRef.current);
      window.visualViewport?.addEventListener("resize", fitAndResize);

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
        resizeObserver.disconnect();
        window.visualViewport?.removeEventListener("resize", fitAndResize);
        input.dispose();
        scroll.dispose();
        socketRef.current?.close(1000, "view closed");
        socketRef.current = null;
        terminal.dispose();
        terminalRef.current = null;
      };
    }, [ignoreSize, onPaneChange, onStateChange, session]);

    return (
      <div className="terminal-stage">
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
      </div>
    );
  },
);
