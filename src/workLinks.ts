import { jsonRequest } from "./api";

export type WorkLinkProvider = "github" | "jira" | "google_docs";
export const WORK_LINK_PROVIDERS: WorkLinkProvider[] = ["github", "jira", "google_docs"];
export const WORK_LINK_PROVIDER_LABELS = { github: "GitHub PR", jira: "Jira ticket", google_docs: "Google Doc" };

export function workLinkTitle(link: Pick<WorkLinkSummary, "provider" | "title" | "label">): string {
  return link.provider === "google_docs" ? link.title || link.label : link.label;
}
export type WorkLinkTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface WorkLinkStatus {
  state: string;
  tone: WorkLinkTone;
  summary: string;
  reportedBy: string;
}

export interface WorkLinkSummary {
  id: string;
  provider: WorkLinkProvider;
  url: string;
  label: string;
  title: string;
  status: Pick<WorkLinkStatus, "state" | "tone"> | null;
  statusUpdatedAt: number | null;
}

export interface WorkLink extends WorkLinkSummary {
  historyId: string;
  notes: string;
  instructions: string;
  revision: number;
  statusRevision: number;
  status: WorkLinkStatus | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkLinkProviderConfig {
  enabled: boolean;
  refreshEnabled: boolean;
  refreshIntervalSeconds: number;
  instructions: string;
}

export interface WorkLinkConfig {
  enabled: boolean;
  revision: number;
  providers: Record<WorkLinkProvider, WorkLinkProviderConfig>;
}

export interface WorkLinkContext {
  session: { name: string; historyId: string } | null;
  config: WorkLinkConfig;
  links: WorkLink[];
}

export interface NewWorkLink {
  provider: WorkLinkProvider;
  url: string;
  label?: string;
  title?: string;
  notes?: string;
  instructions?: string;
}

export type WorkLinkChanges = Partial<Pick<WorkLink, "label" | "title" | "url" | "notes" | "instructions">>;
const body = (method: string, value: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
});

export function getWorkLinkContext(sessionName: string, signal?: AbortSignal): Promise<WorkLinkContext> {
  return jsonRequest(`/api/sessions/${encodeURIComponent(sessionName)}/work-links`, { signal });
}

export function addWorkLink(sessionName: string, historyId: string, link: NewWorkLink): Promise<{ link: WorkLink; created: boolean }> {
  return jsonRequest(`/api/sessions/${encodeURIComponent(sessionName)}/work-links`, body("POST", { ...link, historyId }));
}

export function updateWorkLink(link: WorkLink, changes: WorkLinkChanges): Promise<{ link: WorkLink }> {
  return jsonRequest(`/api/work-links/${encodeURIComponent(link.id)}`, body("PATCH", { ...changes, expectedRevision: link.revision }));
}

export function removeWorkLink(link: WorkLink): Promise<{ deleted: boolean }> {
  return jsonRequest(`/api/work-links/${encodeURIComponent(link.id)}`, body("DELETE", { expectedRevision: link.revision }));
}

export function updateWorkLinkConfig(config: WorkLinkConfig): Promise<{ config: WorkLinkConfig }> {
  return jsonRequest("/api/work-links/config", body("PATCH", {
    enabled: config.enabled, providers: config.providers, expectedRevision: config.revision,
  }));
}
