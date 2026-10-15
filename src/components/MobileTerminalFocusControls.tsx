import { ContractIcon, KeyboardIcon } from "../icons";
import "./MobileTerminalFocus.css";

interface MobileTerminalFocusControlsProps {
  terminalControlId: string;
  shortcutsControlId: string;
  shortcutsOpen: boolean;
  onToggleShortcuts: () => void;
  onInput: () => void;
  onExit: () => void;
}

export function MobileTerminalFocusControls({
  terminalControlId,
  shortcutsControlId,
  shortcutsOpen,
  onToggleShortcuts,
  onInput,
  onExit,
}: MobileTerminalFocusControlsProps) {
  return (
    <div className="mobile-terminal-focus-actions" role="group" aria-label="Mobile terminal focus controls">
      <button type="button" aria-label="Open staged input" onClick={onInput}>
        <KeyboardIcon /><span>Input</span>
      </button>
      <button type="button"
        aria-label={shortcutsOpen ? "Hide mobile terminal buttons" : "Show mobile terminal buttons"}
        aria-controls={shortcutsControlId}
        aria-expanded={shortcutsOpen}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggleShortcuts}
      >
        <KeyboardIcon /><span>Buttons</span>
      </button>
      <button type="button" aria-label="Exit mobile terminal focus"
        aria-controls={terminalControlId}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onExit}
      >
        <ContractIcon /><span>Exit</span>
      </button>
    </div>
  );
}
