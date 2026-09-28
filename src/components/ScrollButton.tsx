import { useCallback, useEffect, useRef, type ButtonHTMLAttributes } from "react";

const HOLD_DELAY_MS = 350;
const REPEAT_DELAY_MS = 100;

interface ScrollButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  onActivate: () => boolean | void | Promise<boolean | void>;
  repeat?: boolean;
  repeatContext?: string;
  busy?: boolean;
}

interface HeldPress {
  pointerId: number;
  element: HTMLButtonElement;
  context: string;
  timer?: number;
  cleanup: () => void;
}

// Keep repetition local to the physical press, even when a request temporarily
// disables the button or a session change reuses the same component.
export function ScrollButton({
  onActivate, repeat = true, repeatContext = "", busy = false, disabled = false,
  title, ...props
}: ScrollButtonProps) {
  const latest = useRef({ onActivate, repeat, repeatContext, busy, disabled });
  latest.current = { onActivate, repeat, repeatContext, busy, disabled };
  const press = useRef<HeldPress | null>(null);
  const suppressClick = useRef(false);
  const stop = useCallback(() => {
    const current = press.current;
    press.current = null;
    if (!current) return;
    window.clearTimeout(current.timer);
    current.cleanup();
  }, []);

  useEffect(() => {
    stop();
    return stop;
  }, [disabled, repeat, repeatContext, stop]);

  const step = (current: HeldPress, delay: number) => {
    if (press.current !== current) return;
    const options = latest.current;
    if (options.disabled || !options.repeat || options.repeatContext !== current.context
      || document.visibilityState === "hidden" || !current.element.isConnected
      || current.element.closest("[hidden], [inert]")
      || current.element.checkVisibility?.({ visibilityProperty: true }) === false) {
      stop();
      return;
    }
    const schedule = (nextDelay: number) => {
      if (press.current === current) {
        current.timer = window.setTimeout(() => step(current, REPEAT_DELAY_MS), nextDelay);
      }
    };
    if (options.busy) {
      schedule(REPEAT_DELAY_MS);
      return;
    }
    const completed = (accepted: boolean | void) => {
      if (press.current !== current) return;
      if (accepted === false) stop();
      else schedule(delay);
    };
    try {
      const result = options.onActivate();
      if (result instanceof Promise) void result.then(completed, () => {
        if (press.current === current) stop();
      });
      else completed(result);
    } catch {
      stop();
    }
  };

  return <button
    {...props}
    type={props.type ?? "button"}
    disabled={disabled || busy}
    data-hold-scroll={repeat ? "true" : undefined}
    title={repeat && title ? `${title}. Hold to keep scrolling.` : title}
    onMouseDown={(event) => event.preventDefault()}
    onPointerDown={(event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      suppressClick.current = false;
      if (!repeat || disabled || busy) return;
      stop();
      const current: HeldPress = {
        pointerId: event.pointerId, element: event.currentTarget,
        context: repeatContext, cleanup: () => {},
      };
      const release = (next: PointerEvent) => {
        if (next.pointerId === current.pointerId) stop();
      };
      const move = (next: PointerEvent) => {
        if (next.pointerId !== current.pointerId) return;
        const box = current.element.getBoundingClientRect();
        if (!(next.buttons & 1) || next.clientX < box.left || next.clientX > box.right
          || next.clientY < box.top || next.clientY > box.bottom) stop();
      };
      const visibility = () => { if (document.visibilityState === "hidden") stop(); };
      window.addEventListener("pointerup", release, true);
      window.addEventListener("pointercancel", release, true);
      window.addEventListener("pointermove", move, true);
      window.addEventListener("blur", stop);
      window.addEventListener("keydown", stop, true);
      document.addEventListener("visibilitychange", visibility);
      current.cleanup = () => {
        window.removeEventListener("pointerup", release, true);
        window.removeEventListener("pointercancel", release, true);
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("blur", stop);
        window.removeEventListener("keydown", stop, true);
        document.removeEventListener("visibilitychange", visibility);
      };
      press.current = current;
      suppressClick.current = true;
      step(current, HOLD_DELAY_MS);
    }}
    onPointerLeave={(event) => { if (event.pointerId === press.current?.pointerId) stop(); }}
    onLostPointerCapture={(event) => { if (event.pointerId === press.current?.pointerId) stop(); }}
    onContextMenu={(event) => { if (repeat) event.preventDefault(); }}
    onClick={(event) => {
      if (suppressClick.current && event.detail > 0) {
        suppressClick.current = false;
        event.preventDefault();
        return;
      }
      if (!disabled && !busy) void onActivate();
    }}
  />;
}
