import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CloseIcon, WindowCopyIcon } from "../icons";

export function ConsoleSessionTitle({ title, children }: { title: string; children?: ReactNode }) {
  const [copied, setCopied] = useState<"idle" | "done" | "manual">("idle");
  const currentTitleRef = useRef<string | null>(title);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const manualRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    currentTitleRef.current = title;
    setCopied("idle");
    return () => { currentTitleRef.current = null; };
  }, [title]);

  useEffect(() => {
    if (copied === "manual") {
      manualRef.current?.focus();
      manualRef.current?.select();
    }
    if (copied !== "done") return;
    const timer = window.setTimeout(() => setCopied("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    let result: "done" | "manual";
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(title);
      result = "done";
    } catch { result = "manual"; }
    if (currentTitleRef.current === title) setCopied(result);
  };
  const closeManualCopy = () => {
    setCopied("idle");
    buttonRef.current?.focus();
  };

  return <>
    <div className="console-title-line">
      <h1>{title}</h1>
      <button ref={buttonRef} type="button"
        className="console-session-history-button console-title-copy-button"
        aria-label="Copy session title"
        title={copied === "done" ? "Session title copied" : "Copy session title"}
        data-copied={copied === "done" ? "true" : undefined}
        onMouseDown={(event) => event.preventDefault()} onClick={() => void copy()}>
        {copied === "done" ? <CheckIcon /> : <WindowCopyIcon />}
      </button>
      {copied === "done" && <span className="session-sr-only" role="status">Session title copied</span>}
      {children}
    </div>
    {copied === "manual" && <div className="console-title-manual-copy">
      <span>Clipboard unavailable. Select and copy the title:</span>
      <div>
        <input ref={manualRef} value={title} readOnly aria-label="Session title to copy"
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault(); event.stopPropagation(); closeManualCopy();
            }
          }} />
        <button type="button" className="console-session-history-button"
          aria-label="Close manual title copy" onClick={closeManualCopy}><CloseIcon /></button>
      </div>
    </div>}
  </>;
}
