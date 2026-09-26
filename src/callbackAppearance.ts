import { useCallback, useEffect, useState } from "react";

export const CALLBACK_FONT_SIZE_STORAGE_KEY = "muxdeck.callback-font-size.v1";
export const DEFAULT_CALLBACK_FONT_SIZE = 14;
export const MIN_CALLBACK_FONT_SIZE = 12;
export const MAX_CALLBACK_FONT_SIZE = 20;
export const CALLBACK_SIZE_PRESETS = {
  small: { width: 390, height: 520 },
  medium: { width: 640, height: 560 },
  large: { width: 860, height: 720 },
} as const;
export type CallbackSizePreset = keyof typeof CALLBACK_SIZE_PRESETS;
export const CALLBACK_SIZE_LABELS: Record<CallbackSizePreset, string> = {
  small: "Small", medium: "Medium", large: "Large",
};

function validFontSize(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_CALLBACK_FONT_SIZE && value <= MAX_CALLBACK_FONT_SIZE;
}

function readFontSize(): number {
  try {
    const value = Number(window.localStorage.getItem(CALLBACK_FONT_SIZE_STORAGE_KEY));
    return validFontSize(value) ? value : DEFAULT_CALLBACK_FONT_SIZE;
  } catch {
    return DEFAULT_CALLBACK_FONT_SIZE;
  }
}

export function useCallbackFontSize() {
  const [fontSize, setFontSize] = useState(readFontSize);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === CALLBACK_FONT_SIZE_STORAGE_KEY || event.key === null) setFontSize(readFontSize());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const changeFontSize = useCallback((value: number) => {
    if (!validFontSize(value)) return;
    setFontSize(value);
    try {
      window.localStorage.setItem(CALLBACK_FONT_SIZE_STORAGE_KEY, String(value));
    } catch {
      // Text sizing still works when browser preferences cannot be saved.
    }
  }, []);
  return [fontSize, changeFontSize] as const;
}
