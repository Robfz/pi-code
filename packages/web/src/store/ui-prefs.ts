import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface UiPrefs {
  /** Global tool expansion (the TUI's Ctrl+O). */
  toolsExpanded: boolean;
  setToolsExpanded(expanded: boolean): void;
}

export const useUiPrefs = create<UiPrefs>()(
  persist(
    (set) => ({
      toolsExpanded: false,
      setToolsExpanded: (toolsExpanded) => set({ toolsExpanded }),
    }),
    { name: "pi-code:ui-prefs", storage: createJSONStorage(() => localStorage) },
  ),
);
