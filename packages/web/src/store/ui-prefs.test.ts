import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useRowOpen, useUiPrefs } from "./ui-prefs";

const KEY = "pi-code:ui-prefs";

async function rehydrateFrom(stored: unknown) {
  if (stored === undefined) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(stored));
  await useUiPrefs.persist.rehydrate();
  return useUiPrefs.getState().density;
}

beforeEach(() => {
  localStorage.removeItem(KEY);
  useUiPrefs.setState(useUiPrefs.getInitialState());
});

describe("ui prefs", () => {
  it("defaults to Balanced with nothing stored", async () => {
    expect(await rehydrateFrom(undefined)).toBe("balanced");
  });

  it("migrates version 0's toolsExpanded", async () => {
    expect(await rehydrateFrom({ state: { toolsExpanded: true }, version: 0 })).toBe("detailed");
    expect(await rehydrateFrom({ state: { toolsExpanded: false }, version: 0 })).toBe("balanced");
    expect(useUiPrefs.getState()).not.toHaveProperty("toolsExpanded");
  });

  it("persists the density, palette and diff font size as version 1", async () => {
    useUiPrefs.getState().setDensity("compact");
    useUiPrefs.getState().setPalette("deco");
    useUiPrefs.getState().setDiffFontSize(14);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toEqual({
      state: { density: "compact", palette: "deco", diffFontSize: 14 },
      version: 1,
    });
    expect(await rehydrateFrom({ state: { density: "compact" }, version: 1 })).toBe("compact");
  });

  it("keeps the neutral palette and 12px diffs for a stored state without them", async () => {
    await rehydrateFrom({ state: { density: "detailed" }, version: 1 });
    expect(useUiPrefs.getState()).toMatchObject({ palette: "neutral", diffFontSize: 12 });
    await rehydrateFrom({ state: { toolsExpanded: true }, version: 0 });
    expect(useUiPrefs.getState()).toMatchObject({ density: "detailed", palette: "neutral" });
  });
});

describe("useRowOpen", () => {
  it("follows the density's default until toggled; a density change drops the toggle", () => {
    const { result } = renderHook(() => useRowOpen((density) => density === "detailed"));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    act(() => useUiPrefs.getState().setDensity("compact"));
    expect(result.current[0]).toBe(false);
    act(() => useUiPrefs.getState().setDensity("balanced"));
    expect(result.current[0]).toBe(false);
    act(() => useUiPrefs.getState().setDensity("detailed"));
    expect(result.current[0]).toBe(true);
  });
});
