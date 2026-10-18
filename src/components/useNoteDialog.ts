import { useEffect, useRef } from "react";

// Capture/storage dialogs must own keyboard focus while a terminal is running behind them.
export function useNoteDialog(open: boolean, onDismiss: () => void) {
  const ref = useRef<HTMLElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previous = document.activeElement;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.closest('[hidden],[inert]'));
    (controls()[0] ?? dialog).focus();
    const contain = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) (controls()[0] ?? dialog).focus();
    };
    const trap = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); dismiss.current(); return;
      }
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        event.preventDefault(); event.stopPropagation(); (controls()[0] ?? dialog).focus(); return;
      }
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0] ?? dialog;
      const last = items.at(-1) ?? dialog;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("focusin", contain, true);
    document.addEventListener("keydown", trap, true);
    return () => {
      document.removeEventListener("focusin", contain, true);
      document.removeEventListener("keydown", trap, true);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);
  return ref;
}
