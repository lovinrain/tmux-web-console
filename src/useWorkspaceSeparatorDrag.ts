import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { separatorMoveTo, type SeparatorAnchor, type SeparatorCrossing } from "./workspaceSeparatorMovement";

interface SeparatorDrag {
  context: string;
  from: SeparatorAnchor;
  target: SeparatorAnchor | null;
}

export function useWorkspaceSeparatorDrag({
  enabled, workspaceId, tabs, before, after, onMove, onDragOver,
}: {
  enabled: boolean;
  workspaceId: string | null;
  tabs: string[];
  before: string[];
  after: string[];
  onMove?: (move: SeparatorCrossing) => void;
  onDragOver: (element: HTMLElement, clientX: number, clientY: number) => void;
}) {
  const context = JSON.stringify([enabled, workspaceId, tabs, before, after]);
  const [drag, setDrag] = useState<SeparatorDrag | null>(null);
  const dragRef = useRef<SeparatorDrag | null>(null);
  const update = useCallback((value: SeparatorDrag | null) => {
    dragRef.current = value;
    setDrag(value);
  }, []);
  const cancel = useCallback(() => update(null), [update]);
  const clearTarget = useCallback(() => {
    const current = dragRef.current;
    if (current?.target) update({ ...current, target: null });
  }, [update]);

  useEffect(() => {
    if (dragRef.current && dragRef.current.context !== context) cancel();
  }, [context, cancel]);

  const start = (event: DragEvent<HTMLElement>, from: SeparatorAnchor) => {
    event.stopPropagation();
    if (!enabled) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    // Keep this distinct from terminal/session drags. Only this view's live
    // drag ref is accepted; payloads from other pages are never applied.
    event.dataTransfer.setData("application/x-muxdeck-separator", JSON.stringify(from));
    update({ context, from, target: null });
  };

  const movement = (event: DragEvent<HTMLElement>, name: string) => {
    const current = dragRef.current;
    if (!enabled || !current || current.context !== context) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    return separatorMoveTo(tabs, before, after, current.from, {
      name, side: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
    });
  };

  const over = (event: DragEvent<HTMLElement>, name: string) => {
    if (!dragRef.current) return false;
    event.stopPropagation();
    const move = movement(event, name);
    if (!move) {
      event.dataTransfer.dropEffect = "none";
      clearTarget();
      return true;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const current = dragRef.current;
    if (current.target?.name !== move.to.name || current.target.side !== move.to.side) {
      update({ ...current, target: move.to });
    }
    onDragOver(event.currentTarget, event.clientX, event.clientY);
    return true;
  };

  const drop = (event: DragEvent<HTMLElement>, name: string) => {
    if (!dragRef.current) return false;
    event.preventDefault();
    event.stopPropagation();
    const move = movement(event, name);
    cancel();
    if (move) onMove?.(move);
    return true;
  };

  return { source: drag?.context === context ? drag.from : null,
    target: drag?.context === context ? drag.target : null,
    start, over, drop, cancel, clearTarget };
}
