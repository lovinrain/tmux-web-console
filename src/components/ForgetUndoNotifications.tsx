import { useEffect, useRef, useState } from "react";
import "./ForgetUndoNotifications.css";

export interface ForgetUndoNotification {
  /** Unique per forget operation, such as the server's undo token. */
  id: string;
  name: string;
  expiresAt: number;
  busy?: boolean;
  error?: string | null;
}

interface ForgetUndoNotificationsProps {
  items: ForgetUndoNotification[];
  onUndo: (id: string) => void;
  onExpire: (id: string) => void;
}

function ForgetUndoNotificationCard({
  item,
  onUndo,
  onExpire,
}: {
  item: ForgetUndoNotification;
  onUndo: (id: string) => void;
  onExpire: (id: string) => void;
}) {
  const [now, setNow] = useState(Date.now);
  const onExpireRef = useRef(onExpire);
  const expiredRef = useRef(false);

  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const currentTime = Date.now();
      setNow(currentTime);
      const remaining = item.expiresAt - currentTime;
      if (remaining <= 0) {
        if (!expiredRef.current) {
          expiredRef.current = true;
          onExpireRef.current(item.id);
        }
        return;
      }
      timer = setTimeout(tick, Math.min(1_000, remaining));
    };
    tick();
    // Check immediately after a background tab returns: browser timers can
    // be throttled while hidden, but that does not extend the undo window.
    const refresh = () => {
      clearTimeout(timer);
      tick();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [item.id, item.expiresAt]);

  const remainingSeconds = Math.ceil((item.expiresAt - now) / 1_000);
  if (remainingSeconds <= 0) return null;

  return (
    <div className="forget-undo-notification">
      <div className="forget-undo-notification-message">
        <p>Forgot <strong title={item.name}>{item.name}</strong></p>
        <span className="workspace-sr-only">Undo is available for 30 seconds.</span>
        {item.error && <p className="forget-undo-notification-error">{item.error}</p>}
      </div>
      <span className="forget-undo-notification-countdown" aria-hidden="true">
        {remainingSeconds}s
      </span>
      <button
        type="button"
        aria-label={`Undo forgetting ${item.name}`}
        disabled={item.busy}
        onClick={() => {
          // A suspended tab may still show its last countdown until its next
          // timer fires. Never send an undo after its deadline.
          if (Date.now() >= item.expiresAt) {
            setNow(Date.now());
            if (!expiredRef.current) {
              expiredRef.current = true;
              onExpireRef.current(item.id);
            }
            return;
          }
          onUndo(item.id);
        }}
      >
        {item.busy ? "Restoring…" : "Undo"}
      </button>
    </div>
  );
}

export function ForgetUndoNotifications({ items, onUndo, onExpire }: ForgetUndoNotificationsProps) {
  return (
    <div
      className="forget-undo-notifications"
      role="region"
      aria-label="Forgotten sessions"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {items.map((item) => (
        <ForgetUndoNotificationCard key={item.id} item={item} onUndo={onUndo} onExpire={onExpire} />
      ))}
    </div>
  );
}
