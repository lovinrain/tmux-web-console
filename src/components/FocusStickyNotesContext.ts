import { createContext } from "react";

/** Keeps one set of note state while moving its cards out of the hidden header. */
export const FocusStickyNotesContext = createContext<HTMLDivElement | null>(null);
