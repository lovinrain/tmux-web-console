export type SharedStreamStatus = "connecting" | "open" | "error";

export interface SharedStreamHandlers {
  onEvent: (data: string) => void;
  onStatus?: (status: SharedStreamStatus) => void;
  onError?: (error: Error) => void;
}

type ChannelMessage =
  | { type: "hello"; senderId: string }
  | { type: "sync"; targetId: string; status: SharedStreamStatus; data: string | null }
  | { type: "event"; data: string }
  | { type: "status"; status: SharedStreamStatus };

interface Subscriber extends SharedStreamHandlers {
  closed: boolean;
  receivedData: boolean;
}

interface StreamHub {
  readonly key: string;
  readonly tabId: string;
  readonly subscribers: Set<Subscriber>;
  readonly channel: BroadcastChannel;
  readonly abort: AbortController;
  isLeader: boolean;
  status: SharedStreamStatus;
  lastData: string | null;
}

const activeHubs = new Map<string, StreamHub>();

function randomTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function canShareAcrossTabs(): boolean {
  return typeof BroadcastChannel !== "undefined"
    && typeof navigator !== "undefined"
    && typeof navigator.locks?.request === "function";
}

function subscribeDirectEventStream(
  url: string,
  eventName: string,
  errorMessage: string,
  { onEvent, onStatus, onError }: SharedStreamHandlers,
): () => void {
  onStatus?.("connecting");
  const source = new EventSource(url);
  let closed = false;

  const handleEvent = (event: MessageEvent<string>) => {
    if (closed) return;
    onEvent(event.data);
  };

  source.addEventListener(eventName, handleEvent);
  source.onopen = () => {
    if (!closed) onStatus?.("open");
  };
  source.onerror = () => {
    if (closed) return;
    onStatus?.("error");
    onError?.(new Error(errorMessage));
  };

  return () => {
    if (closed) return;
    closed = true;
    source.removeEventListener(eventName, handleEvent);
    source.close();
  };
}

function broadcast(channel: BroadcastChannel, message: ChannelMessage): void {
  try {
    channel.postMessage(message);
  } catch {
    // Channel may already be closing during tab teardown.
  }
}

function createHub(
  url: string,
  eventName: string,
  errorMessage: string,
  initialSubscriber: Subscriber,
): StreamHub {
  const key = `muxdeck-sse:v1:${eventName}:${url}`;
  const channel = new BroadcastChannel(key);
  const abort = new AbortController();
  const hub: StreamHub = {
    key,
    tabId: randomTabId(),
    subscribers: new Set([initialSubscriber]),
    channel,
    abort,
    isLeader: false,
    status: "connecting",
    lastData: null,
  };
  initialSubscriber.onStatus?.("connecting");

  const notifyEvent = (data: string) => {
    hub.lastData = data;
    hub.status = "open";
    for (const sub of [...hub.subscribers]) {
      if (sub.closed) continue;
      sub.receivedData = true;
      sub.onEvent(data);
    }
  };

  const notifyStatus = (status: SharedStreamStatus) => {
    hub.status = status;
    for (const sub of [...hub.subscribers]) {
      if (sub.closed) continue;
      sub.onStatus?.(status);
      if (status === "error") {
        sub.onError?.(new Error(errorMessage));
      }
    }
  };

  channel.onmessage = (raw: MessageEvent<unknown>) => {
    const msg = raw.data as ChannelMessage | null;
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

    if (msg.type === "hello") {
      if (hub.isLeader && typeof msg.senderId === "string") {
        broadcast(channel, {
          type: "sync",
          targetId: msg.senderId,
          status: hub.status,
          data: hub.lastData,
        });
      }
      return;
    }

    if (hub.isLeader) return;

    if (msg.type === "event" && typeof msg.data === "string") {
      notifyEvent(msg.data);
      return;
    }

    if (msg.type === "status" && (msg.status === "connecting" || msg.status === "open" || msg.status === "error")) {
      notifyStatus(msg.status);
      return;
    }

    if (msg.type === "sync" && msg.targetId === hub.tabId) {
      if (typeof msg.data === "string") {
        hub.lastData = msg.data;
        for (const sub of [...hub.subscribers]) {
          if (sub.closed || sub.receivedData) continue;
          sub.receivedData = true;
          sub.onEvent(msg.data);
        }
      }
      if (msg.status === "open" || msg.status === "error") {
        notifyStatus(msg.status);
      }
    }
  };

  void navigator.locks.request(key, { signal: abort.signal }, async () => {
    if (abort.signal.aborted) return;
    hub.isLeader = true;
    const source = new EventSource(url);

    const handleEvent = (event: MessageEvent<string>) => {
      if (abort.signal.aborted) return;
      notifyEvent(event.data);
      broadcast(channel, { type: "event", data: event.data });
    };

    source.addEventListener(eventName, handleEvent);
    source.onopen = () => {
      if (abort.signal.aborted) return;
      notifyStatus("open");
      broadcast(channel, { type: "status", status: "open" });
    };
    source.onerror = () => {
      if (abort.signal.aborted) return;
      notifyStatus("error");
      broadcast(channel, { type: "status", status: "error" });
    };

    try {
      await new Promise<void>((resolve) => {
        if (abort.signal.aborted) {
          resolve();
          return;
        }
        abort.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      hub.isLeader = false;
      source.removeEventListener(eventName, handleEvent);
      source.close();
    }
  }).catch((error: unknown) => {
    if (abort.signal.aborted) return;
    if (error instanceof DOMException && error.name === "AbortError") return;
    notifyStatus("error");
  });

  broadcast(channel, { type: "hello", senderId: hub.tabId });
  return hub;
}

/**
 * Share identical EventSource streams across same-origin browser tabs so
 * multiple open tabs do not exhaust the browser's 6-socket HTTP/1.1 pool.
 */
export function subscribeSharedEventStream(
  url: string,
  eventName: string,
  errorMessage: string,
  handlers: SharedStreamHandlers,
): () => void {
  if (typeof EventSource === "undefined") {
    throw new Error("Server-sent events are not supported by this browser");
  }

  if (!canShareAcrossTabs()) {
    return subscribeDirectEventStream(url, eventName, errorMessage, handlers);
  }

  const subscriber: Subscriber = {
    ...handlers,
    closed: false,
    receivedData: false,
  };

  const key = `muxdeck-sse:v1:${eventName}:${url}`;
  let hub = activeHubs.get(key);
  if (!hub) {
    try {
      hub = createHub(url, eventName, errorMessage, subscriber);
      activeHubs.set(key, hub);
    } catch {
      return subscribeDirectEventStream(url, eventName, errorMessage, handlers);
    }
  } else {
    hub.subscribers.add(subscriber);
    subscriber.onStatus?.("connecting");
    const activeHub = hub;
    queueMicrotask(() => {
      if (subscriber.closed || !activeHub.subscribers.has(subscriber)) return;
      if (!subscriber.receivedData && activeHub.lastData !== null) {
        subscriber.receivedData = true;
        subscriber.onEvent(activeHub.lastData);
      }
      if (activeHub.status === "open" || activeHub.status === "error") {
        subscriber.onStatus?.(activeHub.status);
        if (activeHub.status === "error") {
          subscriber.onError?.(new Error(errorMessage));
        }
      }
    });
  }

  const targetHub = hub;
  return () => {
    if (subscriber.closed) return;
    subscriber.closed = true;
    targetHub.subscribers.delete(subscriber);
    if (targetHub.subscribers.size === 0 && activeHubs.get(key) === targetHub) {
      activeHubs.delete(key);
      targetHub.abort.abort();
      targetHub.channel.close();
    }
  };
}
