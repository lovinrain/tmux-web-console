import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BellIcon, CloseIcon } from "../icons";
import { CALLBACK_NOTIFICATION_SCOPES, type CallbackNotificationScope, type MutedCallbackSession } from "../callbackNotifications";
import "./CallbackNotifications.css";

interface Props {
  scope: CallbackNotificationScope;
  onChange: (scope: CallbackNotificationScope) => void;
  mutedSessions?: readonly MutedCallbackSession[];
  onUnmuteSession?: (identity: string) => void;
}

export function CallbackNotificationSettings({ scope, onChange, mutedSessions = [], onUnmuteSession }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 48, left: 12 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const id = useId();
  const label = CALLBACK_NOTIFICATION_SCOPES.find((option) => option.value === scope)!.label;
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!open) return;
    const positionMenu = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = menuRef.current?.offsetWidth || 320;
      const height = menuRef.current?.offsetHeight || 360;
      setPosition({
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - height - 12)),
      });
    };
    positionMenu();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(positionMenu);
    if (menuRef.current) observer?.observe(menuRef.current);
    menuRef.current?.querySelector<HTMLInputElement>("input:checked")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open]);

  return <>
    <button ref={buttonRef} type="button" className="callback-notification-toggle"
      data-enabled={scope !== "off"} aria-label="Callback notifications"
      aria-description={`Notifications: ${label}`} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? id : undefined} title={`Callback notifications: ${label}`}
      onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}>
      <BellIcon muted={scope === "off"} />
      {scope !== "off" && <i aria-hidden="true" />}
    </button>
    {open && createPortal(<section ref={menuRef} id={id} role="dialog" aria-labelledby={`${id}-heading`}
      className="callback-notification-settings" style={position}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); close(); }
        event.stopPropagation();
      }} onKeyUp={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
      <header><h2 id={`${id}-heading`}>Callback notifications</h2>
        <button type="button" aria-label="Close notification settings" onClick={close}><CloseIcon /></button>
      </header>
      <fieldset><legend>Notify me about</legend>
        {CALLBACK_NOTIFICATION_SCOPES.map((option) => <label key={option.value} data-selected={scope === option.value}>
          <input type="radio" name={`${id}-scope`} value={option.value} checked={scope === option.value}
            onChange={() => onChange(option.value)} />
          <span><strong>{option.label}</strong><small>{option.description}</small></span>
        </label>)}
      </fieldset>
      <section className="callback-notification-muted" aria-labelledby={`${id}-muted-heading`}>
        <h3 id={`${id}-muted-heading`}>Muted sessions <span>{mutedSessions.length}</span></h3>
        {mutedSessions.length ? <ul>
          {mutedSessions.map((session) => <li key={session.identity}>
            <div><strong>{session.title}</strong>
              {session.title !== session.sessionName && <small>{session.sessionName}</small>}
            </div>
            <button type="button" aria-label={`Re-enable notifications for ${session.sessionName}`}
              disabled={!onUnmuteSession} onClick={() => onUnmuteSession?.(session.identity)}>Re-enable</button>
          </li>)}
        </ul> : <p>No muted sessions.</p>}
        <small>Muted sessions stay quiet until re-enabled. Closed sessions are removed automatically.</small>
      </section>
      <p>Floating notices for new reports, finished work, and ended sessions. They fade after 8 seconds; hover or focus to pause. Click a notice to dismiss it.</p>
      <small>Saved for this browser. Callbacks stay in the list for review.</small>
    </section>, document.body)}
  </>;
}
