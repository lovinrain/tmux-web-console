import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  getCommonWorkspaceQuickLinks,
  getSessionQuickLinks,
  getWorkspaceQuickLinks,
  replaceCommonWorkspaceQuickLinks,
  replaceSessionQuickLinks,
  replaceWorkspaceQuickLinks,
  type WorkspaceQuickLink,
} from "../api";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import {
  CloseIcon,
  EditIcon,
  ExternalLinkIcon,
  PlusIcon,
  SaveIcon,
  TrashIcon,
} from "../icons";

export const MAX_WORKSPACE_QUICK_LINKS = 16;
export const MAX_WORKSPACE_QUICK_LINK_LABEL_LENGTH = 48;
export const MAX_WORKSPACE_QUICK_LINK_URL_LENGTH = 2048;

type QuickLinkScope = "common" | "workspace" | "session";

interface WorkspaceQuickLinksProps {
  sessionName: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
}

interface QuickLinkDialogProps {
  scope: QuickLinkScope;
  sessionName: string;
  workspaceName?: string | null;
  links: WorkspaceQuickLink[];
  onClose: () => void;
  onSave: (links: WorkspaceQuickLink[]) => Promise<void>;
}

function requestErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function quickLinkId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `link_${uuid.replaceAll("-", "")}`;
  return `link_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export function normalizeWorkspaceQuickLinkUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a URL.");
  if (trimmed.length > MAX_WORKSPACE_QUICK_LINK_URL_LENGTH) {
    throw new Error(`URL must be ${MAX_WORKSPACE_QUICK_LINK_URL_LENGTH} characters or fewer.`);
  }
  if (/\s/.test(trimmed) || [...trimmed].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  })) {
    throw new Error("URL cannot contain whitespace or control characters.");
  }
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS URL.");
  }
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("Only HTTP and HTTPS links are supported.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not supported.");
  }
  return parsed.href;
}

function WorkspaceQuickLinksDialog({
  scope,
  sessionName,
  workspaceName,
  links,
  onClose,
  onSave,
}: QuickLinkDialogProps) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const restoreFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [draftLinks, setDraftLinks] = useState(() => links.map((link) => ({ ...link })));
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [entryError, setEntryError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const scopeName = scope === "common"
    ? "Common"
    : scope === "session"
      ? sessionName
      : workspaceName || "This workspace";
  const scopeEyebrow = scope === "common"
    ? "EVERY WORKSPACE"
    : scope === "session"
      ? "THIS SESSION"
      : "THIS WORKSPACE";

  useEffect(() => {
    mountedRef.current = true;
    const releaseBodyScroll = acquireBodyScrollLock();
    const containFocus = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || !(event.target instanceof Node) || dialog.contains(event.target)) return;
      labelRef.current?.focus();
    };
    document.addEventListener("focusin", containFocus);
    labelRef.current?.focus();
    return () => {
      mountedRef.current = false;
      document.removeEventListener("focusin", containFocus);
      releaseBodyScroll();
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!saving) onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), [href], "
          + "[tabindex]:not([tabindex='-1'])",
      )).filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose, saving]);

  const addLink = () => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setEntryError("Enter a short label.");
      labelRef.current?.focus();
      return;
    }
    if (trimmedLabel.length > MAX_WORKSPACE_QUICK_LINK_LABEL_LENGTH) {
      setEntryError(
        `Label must be ${MAX_WORKSPACE_QUICK_LINK_LABEL_LENGTH} characters or fewer.`,
      );
      labelRef.current?.focus();
      return;
    }
    try {
      const normalizedUrl = normalizeWorkspaceQuickLinkUrl(url);
      setDraftLinks((current) => [
        ...current,
        { id: quickLinkId(), label: trimmedLabel, url: normalizedUrl },
      ]);
      setLabel("");
      setUrl("");
      setEntryError(null);
      setRequestError(null);
      window.requestAnimationFrame(() => labelRef.current?.focus());
    } catch (error) {
      setEntryError(requestErrorMessage(error, "Enter a valid link."));
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setEntryError(null);
    setRequestError(null);
    try {
      await onSave(draftLinks);
      if (mountedRef.current) onClose();
    } catch (error) {
      if (!mountedRef.current) return;
      setRequestError(requestErrorMessage(error, "Unable to save quick links."));
      setSaving(false);
    }
  };

  const close = () => {
    if (!saving) onClose();
  };

  return createPortal(
    <div
      className="title-backdrop workspace-quick-links-backdrop"
      role="presentation"
      onMouseDown={close}
    >
      <form
        ref={dialogRef}
        className="title-sheet workspace-quick-links-sheet"
        noValidate
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        aria-busy={saving}
        tabIndex={-1}
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">{scopeEyebrow}</p>
            <h2 id={headingId}>Manage {scopeName} links</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            disabled={saving}
            aria-label="Close quick link manager"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="workspace-quick-links-dialog-body">
          <p id={descriptionId} className="workspace-quick-links-dialog-description">
            {scope === "common"
              ? "These links stay pinned in every desktop workspace."
              : scope === "session"
                ? `These links follow ${sessionName} wherever that tmux session is open.`
                : "These links belong only to this saved workspace."}
          </p>

          <section className="workspace-quick-links-editor" aria-label={`${scopeName} links`}>
            {draftLinks.length === 0 ? (
              <p className="workspace-quick-links-empty-editor">No links pinned yet.</p>
            ) : (
              <ol>
                {draftLinks.map((link) => (
                  <li key={link.id}>
                    <span>
                      <strong>{link.label}</strong>
                      <small>{link.url}</small>
                    </span>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      referrerPolicy="no-referrer"
                      aria-label={`Open ${link.label} in a new tab`}
                    >
                      <ExternalLinkIcon />
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        setDraftLinks((current) => current.filter((item) => item.id !== link.id));
                        setRequestError(null);
                      }}
                      aria-label={`Remove ${link.label}`}
                      title="Remove link"
                      disabled={saving}
                    >
                      <TrashIcon />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <fieldset disabled={saving || draftLinks.length >= MAX_WORKSPACE_QUICK_LINKS}>
            <legend>Add a link</legend>
            <label htmlFor={`${headingId}-label`}>Label</label>
            <input
              ref={labelRef}
              id={`${headingId}-label`}
              value={label}
              maxLength={MAX_WORKSPACE_QUICK_LINK_LABEL_LENGTH}
              autoComplete="off"
              placeholder="Issue tracker"
              onChange={(event) => {
                setLabel(event.target.value);
                setEntryError(null);
              }}
            />
            <label htmlFor={`${headingId}-url`}>URL</label>
            <input
              id={`${headingId}-url`}
              type="url"
              inputMode="url"
              value={url}
              maxLength={MAX_WORKSPACE_QUICK_LINK_URL_LENGTH}
              autoComplete="url"
              placeholder="https://example.com/project"
              onChange={(event) => {
                setUrl(event.target.value);
                setEntryError(null);
              }}
            />
            <button
              type="button"
              className="secondary-button workspace-quick-links-add"
              onClick={addLink}
              disabled={saving || draftLinks.length >= MAX_WORKSPACE_QUICK_LINKS}
            >
              <PlusIcon /> Add to shelf
            </button>
          </fieldset>

          {draftLinks.length >= MAX_WORKSPACE_QUICK_LINKS && (
            <p className="workspace-quick-links-limit">
              This shelf supports up to {MAX_WORKSPACE_QUICK_LINKS} links.
            </p>
          )}
          {entryError && <p className="title-error" role="alert">{entryError}</p>}
          {requestError && <p className="title-error" role="alert">{requestError}</p>}
        </div>

        <div className="title-actions">
          <button type="button" className="secondary-button" onClick={close} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={saving}>
            <SaveIcon /> {saving ? "Saving..." : "Save links"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function QuickLinkRegion({
  scope,
  label,
  detail,
  links,
  loading,
  error,
  disabledReason,
  onManage,
}: {
  scope: QuickLinkScope;
  label: string;
  detail: string;
  links: WorkspaceQuickLink[];
  loading: boolean;
  error: string | null;
  disabledReason?: string;
  onManage: () => void;
}) {
  const regionLabel = scope === "common"
    ? "Common quick links"
    : scope === "session"
      ? "Session quick links"
      : "Workspace quick links";
  const unavailable = loading || Boolean(error) || Boolean(disabledReason);
  return (
    <section
      className={`workspace-quick-links-region ${scope}`}
      aria-label={regionLabel}
      aria-busy={loading}
    >
      <div className="workspace-quick-links-region-heading">
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <div className="workspace-quick-links-list" role="list">
        {loading ? (
          <span className="workspace-quick-links-placeholder">Loading...</span>
        ) : error ? (
          <span className="workspace-quick-links-placeholder error" title={error}>
            Links unavailable
          </span>
        ) : disabledReason ? (
          <span className="workspace-quick-links-placeholder">{disabledReason}</span>
        ) : links.length === 0 ? (
          <span className="workspace-quick-links-placeholder">No links yet</span>
        ) : links.map((link) => (
          <span key={link.id} role="listitem">
            <a
              className="workspace-quick-link"
              href={link.url}
              target="_blank"
              rel="noreferrer"
              referrerPolicy="no-referrer"
              title={`${link.label} - ${link.url}`}
            >
              <span>{link.label}</span>
              <ExternalLinkIcon />
            </a>
          </span>
        ))}
      </div>
      <button
        type="button"
        className="workspace-quick-links-manage"
        onClick={onManage}
        disabled={unavailable}
        aria-label={`Manage ${regionLabel.toLowerCase()}`}
        title={disabledReason || error || `Add or remove ${regionLabel.toLowerCase()}`}
      >
        {links.length === 0 ? <PlusIcon /> : <EditIcon />}
      </button>
    </section>
  );
}

export function WorkspaceQuickLinks({
  sessionName,
  workspaceId = null,
  workspaceName = null,
}: WorkspaceQuickLinksProps) {
  const [commonLinks, setCommonLinks] = useState<WorkspaceQuickLink[]>([]);
  const [commonLoading, setCommonLoading] = useState(true);
  const [commonError, setCommonError] = useState<string | null>(null);
  const [workspaceLinks, setWorkspaceLinks] = useState<WorkspaceQuickLink[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(Boolean(workspaceId));
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [sessionLinks, setSessionLinks] = useState<WorkspaceQuickLink[]>([]);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [dialogScope, setDialogScope] = useState<QuickLinkScope | null>(null);
  const currentWorkspaceIdRef = useRef(workspaceId);
  currentWorkspaceIdRef.current = workspaceId;
  const currentSessionNameRef = useRef(sessionName);
  currentSessionNameRef.current = sessionName;

  useEffect(() => {
    const controller = new AbortController();
    setCommonLoading(true);
    setCommonError(null);
    void getCommonWorkspaceQuickLinks(controller.signal).then((links) => {
      if (controller.signal.aborted) return;
      setCommonLinks(links);
      setCommonLoading(false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setCommonError(requestErrorMessage(error, "Unable to load common links."));
      setCommonLoading(false);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setDialogScope(null);
    setWorkspaceLinks([]);
    setWorkspaceError(null);
    if (!workspaceId) {
      setWorkspaceLoading(false);
      return;
    }

    const controller = new AbortController();
    setWorkspaceLoading(true);
    void getWorkspaceQuickLinks(workspaceId, controller.signal).then((links) => {
      if (controller.signal.aborted) return;
      setWorkspaceLinks(links);
      setWorkspaceLoading(false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setWorkspaceError(requestErrorMessage(error, "Unable to load workspace links."));
      setWorkspaceLoading(false);
    });
    return () => controller.abort();
  }, [workspaceId]);

  useEffect(() => {
    setDialogScope(null);
    setSessionLinks([]);
    setSessionError(null);
    const controller = new AbortController();
    setSessionLoading(true);
    void getSessionQuickLinks(sessionName, controller.signal).then((links) => {
      if (controller.signal.aborted) return;
      setSessionLinks(links);
      setSessionLoading(false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setSessionError(requestErrorMessage(error, "Unable to load session links."));
      setSessionLoading(false);
    });
    return () => controller.abort();
  }, [sessionName]);

  const saveDialogLinks = async (links: WorkspaceQuickLink[]) => {
    if (dialogScope === "common") {
      const saved = await replaceCommonWorkspaceQuickLinks(links);
      setCommonLinks(saved);
      setCommonError(null);
      return;
    }
    if (dialogScope === "session") {
      const targetSessionName = sessionName;
      const saved = await replaceSessionQuickLinks(targetSessionName, links);
      if (currentSessionNameRef.current !== targetSessionName) return;
      setSessionLinks(saved);
      setSessionError(null);
      return;
    }
    if (!workspaceId) throw new Error("Save this workspace before adding its own links.");
    const targetWorkspaceId = workspaceId;
    const saved = await replaceWorkspaceQuickLinks(targetWorkspaceId, links);
    if (currentWorkspaceIdRef.current !== targetWorkspaceId) return;
    setWorkspaceLinks(saved);
    setWorkspaceError(null);
  };

  const workspaceLabel = workspaceName?.trim() || "This workspace";
  return (
    <>
      <div className="workspace-quick-links" aria-label="Workspace link shelf">
        <QuickLinkRegion
          scope="common"
          label="Common"
          detail="Every workspace"
          links={commonLinks}
          loading={commonLoading}
          error={commonError}
          onManage={() => setDialogScope("common")}
        />
        <QuickLinkRegion
          scope="workspace"
          label={workspaceLabel}
          detail="This workspace"
          links={workspaceLinks}
          loading={workspaceLoading}
          error={workspaceError}
          disabledReason={workspaceId ? undefined : "Save workspace to add links"}
          onManage={() => setDialogScope("workspace")}
        />
        <QuickLinkRegion
          scope="session"
          label={sessionName}
          detail="This session"
          links={sessionLinks}
          loading={sessionLoading}
          error={sessionError}
          onManage={() => setDialogScope("session")}
        />
      </div>

      {dialogScope && (
        <WorkspaceQuickLinksDialog
          key={`${dialogScope}:${workspaceId ?? "unsaved"}:${sessionName}`}
          scope={dialogScope}
          sessionName={sessionName}
          workspaceName={workspaceName}
          links={dialogScope === "common"
            ? commonLinks
            : dialogScope === "session"
              ? sessionLinks
              : workspaceLinks}
          onClose={() => setDialogScope(null)}
          onSave={saveDialogLinks}
        />
      )}
    </>
  );
}
