import { workLinkTitle, type WorkLinkSummary } from "../workLinks";
import "./WorkLinks.css";

export function WorkLinkBadges({ links = [], compact = false, linked = false }: { links?: WorkLinkSummary[]; compact?: boolean; linked?: boolean }) {
  if (!links.length) return null;
  const visible = links.slice(0, compact ? 1 : 3);
  return <span className="work-link-badges" aria-label="Linked work">
    {visible.map((link) => {
      const content = <><span className="work-link-kind">{{ github: "GitHub", jira: "Jira", google_docs: "Doc" }[link.provider]}</span>
        <span>{workLinkTitle(link)}</span>
        {!compact && link.status && <span className="work-link-badge-state">{link.status.state}</span>}</>;
      const className = `work-link-badge work-link-tone-${link.status?.tone ?? "neutral"}`;
      const title = `${link.title || link.label}${link.status ? ` · ${link.status.state}` : " · No status reported"}\n${link.url}`;
      return linked ? <a key={link.id} className={className} title={title} href={link.url} target="_blank" rel="noopener noreferrer">{content}</a>
        : <span key={link.id} className={className} title={title}>{content}</span>;
    })}
    {links.length > visible.length && <span className="work-link-overflow">+{links.length - visible.length}</span>}
  </span>;
}
