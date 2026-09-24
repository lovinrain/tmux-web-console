import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRightIcon, WindowCopyIcon } from "../icons";
import "./CopySessionControl.css";

export type CopySessionPlacement = "sibling" | "child";

interface CopySessionControlProps {
  busy: boolean;
  disabled: boolean;
  title: string;
  shortcut: string | undefined;
  onCopy: (placement: CopySessionPlacement) => void;
}

export function CopySessionControl({
  busy, disabled, title, shortcut, onCopy,
}: CopySessionControlProps) {
  const menuId = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const initialItemRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const visible = open && !disabled;

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) toggleRef.current?.focus();
  };

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    if (!visible) return;
    const positionMenu = () => {
      const anchor = groupRef.current?.getBoundingClientRect();
      const menu = menuRef.current?.getBoundingClientRect();
      if (!anchor || !menu) return;
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - menu.width - 8));
      const top = anchor.bottom + menu.height + 8 <= window.innerHeight
        ? anchor.bottom + 6
        : Math.max(8, anchor.top - menu.height - 6);
      setPosition({ left, top });
    };
    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const items = () => Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    items()[initialItemRef.current]?.focus();
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && (groupRef.current?.contains(target) || menuRef.current?.contains(target))) return;
      setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        setOpen(false);
        toggleRef.current?.focus();
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const options = items();
      const current = options.findIndex((item) => item === document.activeElement);
      const next = event.key === "Home" ? 0
        : event.key === "End" ? options.length - 1
          : (current + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
      options[next]?.focus();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("focusin", outside);
    window.addEventListener("keydown", keyboard, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("focusin", outside);
      window.removeEventListener("keydown", keyboard, true);
    };
  }, [visible]);

  const copy = (placement: CopySessionPlacement, restoreFocus = true) => {
    close(restoreFocus);
    onCopy(placement);
  };

  return (
    <div className="copy-session-control" role="group" aria-label="Copy New" ref={groupRef}>
      <button
        type="button"
        className="copy-new-button"
        aria-keyshortcuts={shortcut}
        aria-busy={busy}
        disabled={disabled}
        title={title}
        onClick={() => copy("sibling", false)}
      >
        <WindowCopyIcon />
        <span>{busy ? "Creating..." : "Copy New"}</span>
      </button>
      <button
        type="button"
        className="copy-new-button copy-session-options"
        ref={toggleRef}
        aria-label="Copy New options"
        aria-haspopup="menu"
        aria-expanded={visible}
        aria-controls={visible ? menuId : undefined}
        disabled={disabled}
        title="Copy as a same-level session or a child indented under this session"
        onClick={() => {
          initialItemRef.current = 0;
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          initialItemRef.current = event.key === "ArrowUp" ? 1 : 0;
          setOpen(true);
        }}
      >
        <ChevronRightIcon />
      </button>
      {visible && createPortal(
        <div
          id={menuId}
          ref={menuRef}
          className="copy-session-menu"
          role="menu"
          aria-label="Copy New options"
          style={position}
        >
          <button type="button" role="menuitem" tabIndex={-1} aria-label="Same-level session" onClick={() => copy("sibling")}>
            <WindowCopyIcon />
            <span><strong>Same-level session</strong><small>Open beside the current session</small></span>
          </button>
          <button type="button" role="menuitem" tabIndex={-1} aria-label="Nested child session" onClick={() => copy("child")}>
            <span className="copy-session-child-mark" aria-hidden="true">↳</span>
            <span><strong>Nested child session</strong><small>Indent under the current session</small></span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
