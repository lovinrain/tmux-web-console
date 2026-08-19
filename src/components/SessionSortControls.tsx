import { ChevronRightIcon, CloseIcon } from "../icons";
import type {
  SessionGroupMode,
  SessionSortKey,
} from "../sessionDashboardModel";

interface SessionSortControlsProps {
  criteria: readonly SessionSortKey[];
  group: SessionGroupMode;
  onChange: (criteria: SessionSortKey[]) => void;
  onGroupChange: (group: SessionGroupMode) => void;
}

const SORT_OPTIONS: readonly SessionSortKey[] = [
  "state",
  "title",
  "tmux-name",
  "state-change",
  "activity",
];

const SORT_COPY: Readonly<Record<SessionSortKey, { label: string; detail: string }>> = {
  state: { label: "State", detail: "attention first" },
  title: { label: "Title", detail: "A-Z" },
  "tmux-name": { label: "Tmux name", detail: "A-Z" },
  "state-change": { label: "State changed", detail: "newest first" },
  activity: { label: "Activity", detail: "newest first" },
};

export function SessionSortControls({
  criteria,
  group,
  onChange,
  onGroupChange,
}: SessionSortControlsProps) {
  const available = SORT_OPTIONS.filter((criterion) => !criteria.includes(criterion));

  const move = (index: number, offset: -1 | 1) => {
    const destination = index + offset;
    if (destination < 0 || destination >= criteria.length) return;
    const next = [...criteria];
    [next[index], next[destination]] = [next[destination], next[index]];
    onChange(next);
  };

  const remove = (criterion: SessionSortKey) => {
    if (criteria.length <= 1) return;
    onChange(criteria.filter((candidate) => candidate !== criterion));
  };

  return (
    <section className="sort-builder" aria-labelledby="sort-builder-heading">
      <header className="sort-builder-header">
        <div>
          <p className="eyebrow">ORDER</p>
          <h3 id="sort-builder-heading">Sort priority</h3>
          <p>
            {group === "state"
              ? "State groups use attention order. These criteria sort inside each group."
              : group === "tag"
                ? "Sessions with several tags appear in each matching group."
              : "Sessions are compared from priority 1 onward."}
          </p>
        </div>
        <div className="group-mode-controls" role="group" aria-label="Group sessions">
          <button
            type="button"
            className={group === "state" ? "group-state-toggle active" : "group-state-toggle"}
            aria-pressed={group === "state"}
            onClick={() => onGroupChange(group === "state" ? "none" : "state")}
          >
            <span>Group</span>
            <strong>State / attention</strong>
          </button>
          <button
            type="button"
            className={group === "tag" ? "group-state-toggle group-tag-toggle active" : "group-state-toggle group-tag-toggle"}
            aria-pressed={group === "tag"}
            onClick={() => onGroupChange(group === "tag" ? "none" : "tag")}
          >
            <span>Group</span>
            <strong>Tags / labels</strong>
          </button>
        </div>
      </header>

      <div className="sort-priority-track">
        <ol className="sort-priority-list" aria-label="Sort priority">
          {criteria.map((criterion, index) => {
            const copy = SORT_COPY[criterion];
            return (
              <li className="sort-priority-chip" key={criterion}>
                <span className="sort-priority-rank" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="sort-priority-copy">
                  <strong>{copy.label}</strong>
                  <span>{copy.detail}</span>
                </span>
                <span className="sort-priority-actions">
                  <button
                    type="button"
                    className="sort-move-earlier"
                    aria-label={`Move ${copy.label} earlier`}
                    title="Move earlier"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ChevronRightIcon />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${copy.label} later`}
                    title="Move later"
                    disabled={index === criteria.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ChevronRightIcon />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${copy.label} sort`}
                    title="Remove criterion"
                    disabled={criteria.length <= 1}
                    onClick={() => remove(criterion)}
                  >
                    <CloseIcon />
                  </button>
                </span>
              </li>
            );
          })}
        </ol>

        <label className="sort-add-criterion">
          <span>Add criterion</span>
          <select
            aria-label="Add sort criterion"
            value=""
            disabled={available.length === 0}
            onChange={(event) => {
              const criterion = event.target.value as SessionSortKey;
              if (criterion && available.includes(criterion)) {
                onChange([...criteria, criterion]);
              }
            }}
          >
            <option value="">{available.length > 0 ? "Choose..." : "All added"}</option>
            {available.map((criterion) => (
              <option value={criterion} key={criterion}>
                {SORT_COPY[criterion].label} / {SORT_COPY[criterion].detail}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="sort-order-summary" aria-live="polite">
        Order: {criteria.map((criterion, index) => (
          `${index + 1} ${SORT_COPY[criterion].label} (${SORT_COPY[criterion].detail})`
        )).join(", then ")}. Exact ties use tmux name and session ID.
      </p>
    </section>
  );
}
