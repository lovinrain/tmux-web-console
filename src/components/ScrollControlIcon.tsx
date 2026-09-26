import type { AgentScrollMode } from "../agentScrollPreferences";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  PageDownIcon,
  PageUpIcon,
  TerminalIcon,
} from "../icons";

interface ScrollControlIconProps {
  mode: AgentScrollMode;
  step: "page" | "line";
  direction: "up" | "down";
}

export function ScrollControlIcon({ mode, step, direction }: ScrollControlIconProps) {
  const MovementIcon = step === "page"
    ? direction === "up" ? PageUpIcon : PageDownIcon
    : direction === "up" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <span className="scroll-control-icons" aria-hidden="true">
      {mode === "tmux" && <TerminalIcon className="scroll-context-icon" />}
      <MovementIcon className="scroll-movement-icon" />
    </span>
  );
}
