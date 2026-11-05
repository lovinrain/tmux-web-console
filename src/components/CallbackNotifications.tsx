import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CALLBACK_NOTIFICATION_DURATION,
  CALLBACK_NOTIFICATION_FADE,
  type CallbackNotification,
} from "../callbackNotifications";
import { CloseIcon } from "../icons";
import "./CallbackNotifications.css";

interface Props {
  items: readonly CallbackNotification[];
  onDismiss: (id: string) => void;
  onExpire: (id: string) => void;
}

function CallbackToast({ item, onDismiss, onExpire }: { item: CallbackNotification } & Omit<Props, "items">) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [leaving, setLeaving] = useState(false);
  const remaining = useRef(CALLBACK_NOTIFICATION_DURATION);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;
  const paused = hovered || focused || hidden;

  useEffect(() => {
    const visibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => {
    if (paused) { setLeaving(false); return; }
    const started = Date.now();
    const fade = window.setTimeout(() => setLeaving(true), Math.max(0, remaining.current - CALLBACK_NOTIFICATION_FADE));
    const expire = window.setTimeout(() => expireRef.current(item.id), remaining.current);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(expire);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [item.id, paused]);

  return <article className={`callback-toast${leaving ? " leaving" : ""}`} data-kind={item.kind}
    aria-label={`${item.sessionName}: ${item.label}`} title="Click to dismiss this notification"
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    onClick={() => onDismiss(item.id)}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); onDismiss(item.id); }
      event.stopPropagation();
    }} onKeyUp={(event) => event.stopPropagation()}>
    <div className="callback-toast-content">
      <span className="callback-toast-kind">{item.label}</span>
      <strong>{item.title}</strong>
      {(item.title !== item.sessionName || item.workspace) && <small className="callback-toast-source">
        {[item.title !== item.sessionName ? item.sessionName : "", item.workspace].filter(Boolean).join(" · ")}
      </small>}
      <p>{item.detail}</p>
    </div>
    <button type="button" aria-label={`Dismiss notification from ${item.sessionName}`}
      onClick={(event) => { event.stopPropagation(); onDismiss(item.id); }}><CloseIcon /></button>
  </article>;
}

export function CallbackNotifications({ items, onDismiss, onExpire }: Props) {
  return createPortal(<aside className="callback-notifications" role="region" aria-label="Callback notifications"
    aria-live="polite" aria-relevant="additions" aria-atomic="false">
    {items.map((item) => <CallbackToast key={item.id} item={item} onDismiss={onDismiss} onExpire={onExpire} />)}
  </aside>, document.body);
}
