import { afterEach, describe, expect, it, vi } from "vitest";
import { syncThemeColor } from "./theme-color";

/** A canvas whose pixel is the RGB a test names for each fill style. */
function stubCanvas(pixels: Record<string, [number, number, number]>) {
  const context = {
    fillStyle: "",
    fillRect: () => {},
    getImageData: () => ({ data: [...(pixels[context.fillStyle] ?? [0, 0, 0]), 255] }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
}

/** Each value `--surface-chrome` computes to on <html>, in order. */
function stubChrome(...colors: string[]) {
  const real = window.getComputedStyle;
  let next = 0;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    element === document.documentElement
      ? ({
          getPropertyValue: (name: string) =>
            name === "--surface-chrome" ? ` ${colors[Math.min(next++, colors.length - 1)]}` : "",
        } as CSSStyleDeclaration)
      : real(element),
  );
}

function addMeta(): HTMLMetaElement {
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = "#0d0d0d";
  document.head.append(meta);
  return meta;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.querySelector('meta[name="theme-color"]')?.remove();
  document.documentElement.className = "";
  delete document.documentElement.dataset.palette;
});

describe("syncThemeColor", () => {
  it("sets the meta to the chrome surface as hex, then follows theme and palette", async () => {
    stubCanvas({
      "oklch(0.992 0 0)": [253, 253, 253],
      "oklch(0.16 0 0)": [14, 14, 14],
      "oklch(0.2 0.03 280)": [20, 22, 40],
    });
    stubChrome("oklch(0.992 0 0)", "oklch(0.16 0 0)", "oklch(0.2 0.03 280)");
    const meta = addMeta();

    const stop = syncThemeColor();
    expect(meta.content).toBe("#fdfdfd");

    document.documentElement.classList.add("dark");
    await vi.waitFor(() => expect(meta.content).toBe("#0e0e0e"));

    document.documentElement.dataset.palette = "aurora";
    await vi.waitFor(() => expect(meta.content).toBe("#141628"));
    stop();
  });

  it("clears the meta for a frame after the first paint, then sets it again", async () => {
    let report: (names: string[]) => void = () => {};
    class FakeObserver {
      static supportedEntryTypes = ["paint"];
      constructor(callback: PerformanceObserverCallback) {
        report = (names) =>
          callback(
            { getEntriesByName: (name: string) => (names.includes(name) ? [{}] : []) } as never,
            this as never,
          );
      }
      observe() {}
      disconnect() {
        report = () => {};
      }
    }
    vi.stubGlobal("PerformanceObserver", FakeObserver);
    stubCanvas({ "oklch(0.992 0 0)": [253, 253, 253] });
    stubChrome("oklch(0.992 0 0)");
    const meta = addMeta();

    const stop = syncThemeColor();
    report(["first-paint"]);
    expect(meta.content).toBe("#fdfdfd");

    report(["first-contentful-paint"]);
    expect(meta.hasAttribute("content")).toBe(false);
    await vi.waitFor(() => expect(meta.content).toBe("#fdfdfd"));
    stop();
  });

  it("passes the colour through without a canvas", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    stubChrome("rgb(1, 2, 3)");
    const meta = addMeta();
    syncThemeColor()();
    expect(meta.content).toBe("rgb(1, 2, 3)");
  });

  it("does nothing without the meta", () => {
    const getComputedStyle = vi.spyOn(window, "getComputedStyle");
    syncThemeColor()();
    expect(getComputedStyle).not.toHaveBeenCalled();
  });
});
