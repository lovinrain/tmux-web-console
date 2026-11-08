import { ChevronRightIcon } from "../icons";
import "./SessionHistoryControls.css";

export function SessionHistoryButton({
  direction,
  target,
  onNavigate,
  className,
  ariaLabel,
}: {
  direction: "back" | "forward";
  target?: string | null;
  onNavigate?: (direction: "back" | "forward") => void;
  className: string;
  ariaLabel?: string;
}) {
  const back = direction === "back";
  return (
    <button
      type="button"
      className={className}
      data-direction={direction}
      aria-label={ariaLabel ?? (back ? "Back to previous session" : "Forward to next session")}
      title={target
        ? `${back ? "Back" : "Forward"} to ${target}`
        : back ? "No previous session" : "No next session"}
      disabled={!target || !onNavigate}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onNavigate?.(direction)}
    >
      <ChevronRightIcon />
    </button>
  );
}

export function SessionHistoryControls({
  back,
  forward,
  onNavigate,
}: {
  back?: string | null;
  forward?: string | null;
  onNavigate?: (direction: "back" | "forward") => void;
}) {
  return (
    <div className="session-picker-history-controls" role="group" aria-label="Session visit history">
      <SessionHistoryButton direction="back" target={back} onNavigate={onNavigate}
        className="icon-button session-picker-history-button" ariaLabel="Back" />
      <SessionHistoryButton direction="forward" target={forward} onNavigate={onNavigate}
        className="icon-button session-picker-history-button" ariaLabel="Forward" />
    </div>
  );
}
