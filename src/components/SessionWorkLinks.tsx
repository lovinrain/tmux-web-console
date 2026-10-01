import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { ApiRequestError } from "../api";
import { formatTimestamp, useDisplayTimeZone } from "../timeZone";
import type { Session } from "../types";
import {
  addWorkLink, getWorkLinkContext, removeWorkLink, updateWorkLink, updateWorkLinkConfig,
  WORK_LINK_PROVIDERS, WORK_LINK_PROVIDER_LABELS,
  workLinkTitle,
  type WorkLink, type WorkLinkChanges, type WorkLinkConfig, type WorkLinkContext, type WorkLinkProvider,
} from "../workLinks";
import { WorkLinkBadges } from "./WorkLinkBadges";
import "./WorkLinks.css";

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Unable to save work links.";
const metadata = (link: WorkLink) => ({ label: link.label, title: link.title, url: link.url, notes: link.notes, instructions: link.instructions });

function WorkLinkCard({ link, config, onChange }: { link: WorkLink; config: WorkLinkConfig; onChange: () => Promise<void> }) {
  const { timeZone } = useDisplayTimeZone();
  const [base, setBase] = useState(link);
  const [draft, setDraft] = useState(() => metadata(link));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(metadata(base));
  useEffect(() => {
    if (!dirty && link.revision > base.revision) { setBase(link); setDraft(metadata(link)); }
  }, [link, dirty, base.revision]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    const changes: WorkLinkChanges = {};
    for (const field of Object.keys(draft) as Array<keyof typeof draft>) {
      if (draft[field] !== base[field]) changes[field] = draft[field];
    }
    try {
      const result = await updateWorkLink(base, changes);
      setBase(result.link);
      setDraft((current) => current === draft ? metadata(result.link) : current);
      setConflict(false);
      await onChange();
    } catch (failure) {
      setError(errorMessage(failure));
      setConflict(failure instanceof ApiRequestError && failure.status === 409);
      await onChange().catch(() => undefined);
    } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError(null);
    try { await removeWorkLink(base); await onChange(); }
    catch (failure) { setError(errorMessage(failure)); setBusy(false); }
  };
  const provider = config.providers[link.provider];
  return <article className="work-link-card" aria-label={workLinkTitle(link)}>
    <header>
      <a href={link.url} target="_blank" rel="noopener noreferrer">{workLinkTitle(link)} <span aria-hidden="true">↗</span></a>
      <span className="work-link-provider">{WORK_LINK_PROVIDER_LABELS[link.provider]}</span>
    </header>
    {link.title && link.provider !== "google_docs" && <p className="work-link-title">{link.title}</p>}
    <div className={`work-link-status work-link-tone-${link.status?.tone ?? "neutral"}`}>
      <strong>{link.status?.state || "No status reported"}</strong>
      {link.status?.summary && <p>{link.status.summary}</p>}
    </div>
    <p className="work-link-report-time">
      {link.statusUpdatedAt ? <>Reported {formatTimestamp(link.statusUpdatedAt * 1000, timeZone)}
        {link.status?.reportedBy && ` · ${link.status.reportedBy}`}</> : "Awaiting an agent report"}
      {!provider.refreshEnabled && <span> · Status refresh off</span>}
    </p>
    <form onSubmit={(event) => { void save(event); }}>
      <label>Retained notes
        <textarea aria-label={`Notes for ${workLinkTitle(link)}`} maxLength={32000} rows={3}
          value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
      </label>
      <details className="work-link-edit-details">
        <summary>Edit link and agent instructions</summary>
        <label>Label<input value={draft.label} maxLength={80} required
          onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
        <label>Title<input value={draft.title} maxLength={240}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <label>URL<input value={draft.url} type="url" maxLength={2048} required
          onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label>
        <label>Instructions for this link<textarea value={draft.instructions} maxLength={8000} rows={3}
          placeholder="For example: use the corporate Jira MCP for this ticket."
          onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></label>
        <button className="work-link-remove" type="button" disabled={busy || dirty} onClick={() => { void remove(); }}>Remove link</button>
      </details>
      {error && <p role="alert">{error}{conflict && " Your draft is preserved. Load the saved version to reconcile changes."}</p>}
      <div className="work-link-actions">
        <button type="submit" disabled={busy || !dirty}>{busy ? "Saving…" : "Save changes"}</button>
        {dirty && <span>Unsaved changes</span>}
        {conflict && <button type="button" disabled={busy} onClick={() => {
          setBase(link); setDraft(metadata(link)); setConflict(false); setError(null);
        }}>Load saved version</button>}
      </div>
    </form>
  </article>;
}

function WorkLinkSettings({ config, onChange }: { config: WorkLinkConfig; onChange: () => Promise<void> }) {
  const [base, setBase] = useState(config);
  const [draft, setDraft] = useState(config);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  useEffect(() => { if (!dirty && config.revision > base.revision) { setBase(config); setDraft(config); } }, [config, dirty, base.revision]);
  const setProvider = (provider: WorkLinkProvider, changes: Partial<WorkLinkConfig["providers"][WorkLinkProvider]>) => {
    setDraft({ ...draft, providers: { ...draft.providers, [provider]: { ...draft.providers[provider], ...changes } } });
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const result = await updateWorkLinkConfig(draft);
      setDraft((current) => current === draft ? result.config : { ...current, revision: result.config.revision });
      setBase(result.config); setConflict(false); await onChange();
    } catch (failure) {
      setError(errorMessage(failure));
      setConflict(failure instanceof ApiRequestError && failure.status === 409);
      await onChange().catch(() => undefined);
    }
    finally { setBusy(false); }
  };
  return <form className="work-link-settings" onSubmit={(event) => { void save(event); }}>
    <p>Settings apply to this Muxdeck installation. Agents read these instructions and submit reports.</p>
    <label className="work-link-check"><input type="checkbox" checked={draft.enabled}
      onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />Enable work links</label>
    {WORK_LINK_PROVIDERS.map((provider) => <fieldset key={provider}>
      <legend>{WORK_LINK_PROVIDER_LABELS[provider]}</legend>
      <label className="work-link-check"><input type="checkbox" checked={draft.providers[provider].enabled}
        onChange={(event) => setProvider(provider, { enabled: event.target.checked })} />Enable links</label>
      <label className="work-link-check"><input type="checkbox" checked={draft.providers[provider].refreshEnabled}
        onChange={(event) => setProvider(provider, { refreshEnabled: event.target.checked })} />Allow agent status refresh</label>
      <label>Suggested refresh interval (seconds)<input type="number" min={30} max={86400} required
        value={draft.providers[provider].refreshIntervalSeconds}
        onChange={(event) => setProvider(provider, { refreshIntervalSeconds: Number(event.target.value) })} /></label>
      <label>Agent access instructions<textarea rows={4} maxLength={8000} value={draft.providers[provider].instructions}
        placeholder={provider === "github" ? "Use gh with the work account on github.company.example. Read credentials from the existing credential store." : provider === "jira" ? "Use the company Jira MCP to read this host. Record the ticket state and blockers." : "Use the Google Docs MCP with the work account. Supply the document title and relevant notes."}
        onChange={(event) => setProvider(provider, { instructions: event.target.value })} /></label>
    </fieldset>)}
    <p>Refresh runs in the agent. Store account and tool guidance here; keep credentials in their existing credential store.</p>
    {error && <p role="alert">{error} Your settings draft is preserved.</p>}
    {conflict && <button disabled={busy} type="button" onClick={() => {
      setDraft(config); setBase(config); setConflict(false); setError(null);
    }}>Load saved configuration</button>}
    <button disabled={busy || !dirty} type="submit">{busy ? "Saving…" : "Save configuration"}</button>
  </form>;
}

function AddWorkLink({ context, onChange }: { context: WorkLinkContext; onChange: () => Promise<void> }) {
  const providers = WORK_LINK_PROVIDERS.filter((provider) => context.config.providers[provider].enabled);
  const [provider, setProvider] = useState<WorkLinkProvider>(providers[0] ?? "github");
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedProvider = providers.includes(provider) ? provider : providers[0];
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!context.session || !selectedProvider) return;
    setBusy(true); setError(null);
    try {
      await addWorkLink(context.session.name, context.session.historyId,
        { provider: selectedProvider, url, ...(label.trim() ? selectedProvider === "google_docs" ? { title: label.trim() } : { label: label.trim() } : {}) });
      setUrl(""); setLabel(""); await onChange();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  if (!providers.length) return <p>All providers are disabled. Enable one in configuration to add links.</p>;
  return <details className="work-link-add" open={context.links.length === 0}>
    <summary>Add a work link</summary>
    <form onSubmit={(event) => { void add(event); }}>
      <label>Type<select value={selectedProvider} onChange={(event) => setProvider(event.target.value as WorkLinkProvider)}>
        {providers.map((item) => <option key={item} value={item}>{WORK_LINK_PROVIDER_LABELS[item]}</option>)}
      </select></label>
      <label>Link URL<input type="url" required maxLength={2048} value={url} placeholder="https://…"
        onChange={(event) => setUrl(event.target.value)} /></label>
      <label>{selectedProvider === "google_docs" ? "Document title" : "Badge label (optional)"}<input
        maxLength={selectedProvider === "google_docs" ? 240 : 80} required={selectedProvider === "google_docs"}
        value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "Adding…" : "Add link"}</button>
    </form>
  </details>;
}

export function SessionWorkLinks({ session }: { session: Session }) {
  const storageKey = `muxdeck.work-links.panel.v1:${session.id}:${session.created}:${session.serverStarted}:${session.serverPid}`;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(storageKey) === "open"; } catch { return false; } });
  const [context, setContext] = useState<WorkLinkContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(async () => {
    const result = await getWorkLinkContext(session.name);
    setContext(result); setError(null);
  }, [session.name]);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void getWorkLinkContext(session.name, abort.signal).then((result) => {
      if (!abort.signal.aborted) { setContext(result); setError(null); }
    }).catch((failure) => { if (!abort.signal.aborted) setError(errorMessage(failure)); });
    return () => abort.abort();
  }, [open, session.name, session.workLinksRevision]);
  const toggle = (next: boolean) => {
    setOpen(next);
    try { localStorage.setItem(storageKey, next ? "open" : "closed"); } catch { /* page-only preference */ }
    if (!next) button.current?.focus();
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current || !panel.current) return;
    const rect = panel.current.getBoundingClientRect();
    setPosition({ x: Math.max(8, Math.min(window.innerWidth - rect.width - 8, drag.current.left + event.clientX - drag.current.x)),
      y: Math.max(8, Math.min(window.innerHeight - 50, drag.current.top + event.clientY - drag.current.y)) });
  };
  // Older servers omit this feature; disabled integrations add no terminal UI.
  if (session.workLinksEnabled !== true) return null;
  const links = context?.links.filter((link) => context.config.providers[link.provider].enabled) ?? [];
  return <>
    <span className="work-links-control"><button ref={button} type="button" className="work-links-toggle" aria-expanded={open} aria-haspopup="dialog"
      onClick={() => toggle(!open)}>Work links{session.workLinks?.length ? ` (${session.workLinks.length})` : ""}</button>
    <WorkLinkBadges links={session.workLinks} linked /></span>
    {open && createPortal(<aside ref={panel} className="work-links-panel" role="dialog" aria-label={`Work links for ${session.name}`}
      style={position ? { left: position.x, top: position.y, bottom: "auto", right: "auto" } : undefined}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); toggle(false); } }}>
      <header className="work-links-panel-header">
        <button className="work-links-drag" type="button" aria-label="Move work links panel"
          onPointerDown={(event) => {
            if (event.button !== 0 || !panel.current) return;
            const rect = panel.current.getBoundingClientRect();
            drag.current = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
            event.currentTarget.setPointerCapture(event.pointerId);
          }} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
          onKeyDown={(event) => {
            const offset = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
            if (!offset || !panel.current) return;
            event.preventDefault(); event.stopPropagation();
            const rect = panel.current.getBoundingClientRect();
            setPosition({ x: Math.max(8, Math.min(window.innerWidth - rect.width - 8, rect.left + offset[0])),
              y: Math.max(8, Math.min(window.innerHeight - 50, rect.top + offset[1])) });
          }}><strong>Work links</strong><small>{session.customTitle || session.name}</small></button>
        <button type="button" onClick={() => setSettings(!settings)} aria-pressed={settings}>Configure</button>
        <button type="button" aria-label="Close work links" onClick={() => toggle(false)}>×</button>
      </header>
      <div className="work-links-panel-body">
        {error && <p role="alert">{error}</p>}
        {!context && !error && <p>Loading work links…</p>}
        {context && (settings ? <WorkLinkSettings config={context.config} onChange={refresh} /> : <>
          <p className="work-links-intro">Agent-reported status and retained notes.</p>
          {links.map((link) => <WorkLinkCard key={link.id} link={link} config={context.config} onChange={refresh} />)}
          <AddWorkLink context={context} onChange={refresh} />
        </>)}
        <button className="work-links-reload" type="button" onClick={() => { void refresh().catch((failure) => setError(errorMessage(failure))); }}>Reload saved reports</button>
      </div>
    </aside>, document.body)}
  </>;
}
