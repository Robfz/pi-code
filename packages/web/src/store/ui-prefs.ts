import { useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Palette } from "@/lib/palettes";

/** How much of each turn the transcript shows (`docs/design/09-ui-overhaul.md`, "Density"). */
export type Density = "compact" | "balanced" | "detailed";

export const DENSITIES: readonly Density[] = ["compact", "balanced", "detailed"];

export const DENSITY_LABEL: Record<Density, { name: string; description: string }> = {
  compact: { name: "Compact", description: "Finished turns fold into ‘Worked for …’" },
  balanced: { name: "Balanced", description: "Every step, exploration grouped" },
  detailed: { name: "Detailed", description: "No grouping, everything expanded" },
};

/** Diff viewer font sizes (px), smallest first. */
export const DIFF_FONT_SIZES = [11, 12, 13, 14, 16] as const;

export type DiffFontSize = (typeof DIFF_FONT_SIZES)[number];

interface UiPrefs {
  density: Density;
  setDensity(density: Density): void;
  palette: Palette;
  setPalette(palette: Palette): void;
  diffFontSize: DiffFontSize;
  setDiffFontSize(size: DiffFontSize): void;
}

export const useUiPrefs = create<UiPrefs>()(
  persist(
    (set) => ({
      density: "balanced",
      setDensity: (density) => set({ density }),
      palette: "neutral",
      setPalette: (palette) => set({ palette }),
      diffFontSize: 12,
      setDiffFontSize: (diffFontSize) => set({ diffFontSize }),
    }),
    {
      name: "pi-code:ui-prefs",
      storage: createJSONStorage(() => localStorage),
      version: 1,
      migrate: (persisted, version) => {
        if (version === 0) {
          const { toolsExpanded } = (persisted ?? {}) as { toolsExpanded?: unknown };
          return { density: toolsExpanded === true ? "detailed" : "balanced" };
        }
        return persisted as UiPrefs;
      },
    },
  ),
);

/**
 * A transcript row's open state: `defaultOpen` for the current density until the user toggles
 * it; a density change drops the toggle.
 */
export function useRowOpen(
  defaultOpen: (density: Density) => boolean,
): [boolean, (open: boolean) => void] {
  const density = useUiPrefs((s) => s.density);
  const [override, setOverride] = useState<{ density: Density; open: boolean }>();
  if (override !== undefined && override.density !== density) setOverride(undefined);
  const open = override?.density === density ? override.open : defaultOpen(density);
  return [open, (next) => setOverride({ density, open: next })];
}
