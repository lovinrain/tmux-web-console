import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import {
  ApiRequestError,
  getShortcutSettings,
  saveShortcutSettings,
  type ShortcutBindingPayload,
  type ShortcutSettingsPayload,
} from "./api";

export type ShortcutGroup = "Open" | "Session" | "Terminal" | "View" | "Tabs";

export interface ShortcutDefinition {
  id: string;
  label: string;
  group: ShortcutGroup;
  direct: string | null;
  launcher: string | null;
  directEditable?: boolean;
  launcherEditable?: boolean;
}

const CORE_SHORTCUT_DEFINITIONS = [
  { id: "command-palette", label: "Fuzzy command search", group: "Open", direct: "KeyH", launcher: "KeyH" },
  { id: "shortcut-launcher", label: "Shortcut window", group: "Open", direct: "KeyZ", launcher: null, launcherEditable: false },
  { id: "workspace-new-session", label: "New session", group: "Session", direct: "KeyB", launcher: "KeyB" },
  { id: "workspace-quick-new-session", label: "Quick temporary session", group: "Session", direct: "KeyK", launcher: "KeyK" },
  { id: "session-copy-new", label: "Copy New", group: "Session", direct: "KeyM", launcher: "KeyM" },
  { id: "session-rename", label: "Rename session", group: "Session", direct: "KeyR", launcher: "KeyR" },
  { id: "session-end", label: "End session", group: "Session", direct: "KeyE", launcher: "KeyE" },
  { id: "terminal-return-live", label: "Return to live", group: "Terminal", direct: "KeyL", launcher: "KeyL" },
  { id: "terminal-page-up", label: "Preferred page up", group: "Terminal", direct: "KeyU", launcher: "KeyU" },
  { id: "terminal-page-down", label: "Preferred page down", group: "Terminal", direct: "KeyD", launcher: "KeyD" },
  { id: "terminal-copy-mode", label: "Copy mode", group: "Terminal", direct: "KeyC", launcher: "KeyC" },
  { id: "view-tab-actions", label: "Tab action buttons", group: "View", direct: "KeyA", launcher: "KeyA" },
  { id: "view-session-tabs", label: "Session tabs", group: "View", direct: "KeyS", launcher: "KeyS" },
  { id: "view-terminal-focus", label: "Terminal Focus", group: "View", direct: "KeyF", launcher: "KeyF" },
  { id: "view-floating-input", label: "Floating staged input", group: "View", direct: "KeyY", launcher: "KeyY" },
  { id: "view-theme", label: "Theme", group: "View", direct: null, launcher: "KeyT", directEditable: false },
  { id: "workspace-find-tab", label: "Find tab", group: "Tabs", direct: "Semicolon", launcher: "Semicolon" },
  { id: "workspace-previous-tab", label: "Previous tab", group: "Tabs", direct: "Comma", launcher: "Comma" },
  { id: "workspace-next-tab", label: "Next tab", group: "Tabs", direct: "Period", launcher: "Period" },
] as const satisfies readonly ShortcutDefinition[];

const TAB_SHORTCUT_DEFINITIONS = Array.from({ length: 9 }, (_, index) => {
  const position = index + 1;
  return {
    id: `workspace-tab-${position}`,
    label: `Open tab ${position}`,
    group: "Tabs" as const,
    direct: `Digit${position}`,
    launcher: `Digit${position}`,
  };
});

export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  ...CORE_SHORTCUT_DEFINITIONS,
  ...TAB_SHORTCUT_DEFINITIONS,
];

export type ShortcutActionId =
  | (typeof CORE_SHORTCUT_DEFINITIONS)[number]["id"]
  | `workspace-tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export interface ShortcutBinding {
  direct: string | null;
  launcher: string | null;
}

export type ShortcutBindings = Record<ShortcutActionId, ShortcutBinding>;

export const SHORTCUT_ACTION_EVENT = "muxdeck:shortcut-action";

export function dispatchShortcutAction(action: ShortcutActionId): void {
  window.dispatchEvent(new CustomEvent<ShortcutActionId>(SHORTCUT_ACTION_EVENT, {
    detail: action,
  }));
}

function defaultBindings(): ShortcutBindings {
  return Object.fromEntries(SHORTCUT_DEFINITIONS.map((definition) => [
    definition.id,
    { direct: definition.direct, launcher: definition.launcher },
  ])) as ShortcutBindings;
}

export const DEFAULT_SHORTCUT_BINDINGS = defaultBindings();

export const SUPPORTED_SHORTCUT_CODES = new Set([
  ...Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_, index) => `Digit${index}`),
  "Backquote",
  "Backslash",
  "BracketLeft",
  "BracketRight",
  "Comma",
  "Equal",
  "Minus",
  "Period",
  "Quote",
  "Semicolon",
  "Slash",
]);

const CODE_LABELS: Record<string, string> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

export function shortcutCodeLabel(code: string | null): string {
  if (!code) return "Not set";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return CODE_LABELS[code] || code;
}

export function canonicalShortcutCode(code: string): string | null {
  const normalized = /^Numpad([0-9])$/.exec(code)?.[1];
  const candidate = normalized ? `Digit${normalized}` : code;
  return SUPPORTED_SHORTCUT_CODES.has(candidate) ? candidate : null;
}

export function directShortcutLabel(binding: ShortcutBinding | undefined): string | null {
  return binding?.direct ? `Ctrl+Shift+${shortcutCodeLabel(binding.direct)}` : null;
}

export function directShortcutAria(binding: ShortcutBinding | undefined): string | undefined {
  return binding?.direct
    ? `Control+Shift+${shortcutCodeLabel(binding.direct)}`
    : undefined;
}

export function launcherShortcutLabel(binding: ShortcutBinding | undefined): string | null {
  return binding?.launcher ? shortcutCodeLabel(binding.launcher) : null;
}

export function hasExactShortcutModifiers(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
}

export function matchesShortcutCode(event: KeyboardEvent, code: string | null): boolean {
  if (!code) return false;
  const eventCode = canonicalShortcutCode(event.code);
  if (eventCode) return eventCode === code;
  if (code.startsWith("Key")) return event.key.toUpperCase() === code.slice(3);
  if (code.startsWith("Digit")) return event.key === code.slice(5);
  return event.key === shortcutCodeLabel(code);
}

export function matchesDirectShortcut(
  event: KeyboardEvent,
  binding: ShortcutBinding | undefined,
): boolean {
  return hasExactShortcutModifiers(event)
    && matchesShortcutCode(event, binding?.direct ?? null);
}

export function shortcutConflictMessages(bindings: ShortcutBindings): string[] {
  const messages: string[] = [];
  for (const layer of ["direct", "launcher"] as const) {
    const owners = new Map<string, string>();
    for (const definition of SHORTCUT_DEFINITIONS) {
      const code = bindings[definition.id as ShortcutActionId][layer];
      if (!code) continue;
      const previous = owners.get(code);
      if (previous) {
        messages.push(
          `${layer === "direct" ? "Direct" : "Shortcut window"} key ${shortcutCodeLabel(code)} is used by ${previous} and ${definition.label}.`,
        );
      } else {
        owners.set(code, definition.label);
      }
    }
  }
  return messages;
}

function normalizePayload(payload: ShortcutSettingsPayload): {
  revision: number;
  bindings: ShortcutBindings;
} {
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 0) {
    throw new Error("The shortcut response has an invalid revision.");
  }
  const expectedIds = new Set(SHORTCUT_DEFINITIONS.map((definition) => definition.id));
  if (!payload.bindings || typeof payload.bindings !== "object") {
    throw new Error("The shortcut response has invalid bindings.");
  }
  const actualIds = Object.keys(payload.bindings);
  if (actualIds.length !== expectedIds.size || actualIds.some((id) => !expectedIds.has(id))) {
    throw new Error("The shortcut response does not match this Muxdeck version.");
  }

  const bindings = defaultBindings();
  for (const definition of SHORTCUT_DEFINITIONS) {
    const action = definition.id as ShortcutActionId;
    const binding = payload.bindings[action];
    if (!binding || typeof binding !== "object") {
      throw new Error(`The shortcut response is missing ${definition.label}.`);
    }
    for (const layer of ["direct", "launcher"] as const) {
      const code = binding[layer];
      if (code !== null && (typeof code !== "string" || !SUPPORTED_SHORTCUT_CODES.has(code))) {
        throw new Error(`The shortcut response has an invalid ${layer} key.`);
      }
      bindings[action][layer] = code;
    }
  }
  const conflicts = shortcutConflictMessages(bindings);
  if (conflicts.length > 0) throw new Error(conflicts[0]);
  return { revision: payload.revision, bindings };
}

export type ShortcutSettingsStatus = "loading" | "ready" | "saving" | "unavailable";

interface ShortcutSettingsContextValue {
  revision: number;
  bindings: ShortcutBindings;
  status: ShortcutSettingsStatus;
  error: string | null;
  save: (bindings: ShortcutBindings) => Promise<void>;
  reload: () => Promise<void>;
}

const fallbackContext: ShortcutSettingsContextValue = {
  revision: 0,
  bindings: DEFAULT_SHORTCUT_BINDINGS,
  status: "ready",
  error: null,
  save: async () => {
    throw new Error("Shortcut persistence is unavailable outside the application.");
  },
  reload: async () => undefined,
};

const ShortcutSettingsContext = createContext<ShortcutSettingsContextValue>(fallbackContext);

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof Error) return error.message;
  return "Unable to load shortcut settings.";
}

export function ShortcutSettingsProvider({ children }: PropsWithChildren) {
  const [revision, setRevision] = useState(0);
  const [bindings, setBindings] = useState<ShortcutBindings>(defaultBindings);
  const [status, setStatus] = useState<ShortcutSettingsStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setStatus("loading");
    setError(null);
    try {
      const snapshot = normalizePayload(await getShortcutSettings(signal));
      setRevision(snapshot.revision);
      setBindings(snapshot.bindings);
      setStatus("ready");
    } catch (loadError) {
      if (signal?.aborted) return;
      setStatus("unavailable");
      setError(errorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const save = useCallback(async (nextBindings: ShortcutBindings) => {
    const conflicts = shortcutConflictMessages(nextBindings);
    if (conflicts.length > 0) throw new Error(conflicts[0]);
    setStatus("saving");
    setError(null);
    try {
      const payloadBindings = nextBindings as Record<string, ShortcutBindingPayload>;
      const snapshot = normalizePayload(
        await saveShortcutSettings(payloadBindings, revision),
      );
      setRevision(snapshot.revision);
      setBindings(snapshot.bindings);
      setStatus("ready");
    } catch (saveError) {
      setStatus("unavailable");
      setError(errorMessage(saveError));
      throw saveError;
    }
  }, [revision]);

  const reload = useCallback(() => load(), [load]);
  const value = useMemo<ShortcutSettingsContextValue>(() => ({
    revision,
    bindings,
    status,
    error,
    save,
    reload,
  }), [bindings, error, reload, revision, save, status]);

  return (
    <ShortcutSettingsContext.Provider value={value}>
      {children}
    </ShortcutSettingsContext.Provider>
  );
}

export function useShortcutSettings(): ShortcutSettingsContextValue {
  return useContext(ShortcutSettingsContext);
}

export function cloneShortcutBindings(bindings: ShortcutBindings): ShortcutBindings {
  return Object.fromEntries(Object.entries(bindings).map(([action, binding]) => [
    action,
    { ...binding },
  ])) as ShortcutBindings;
}
