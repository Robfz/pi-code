import { describe, expect, it } from "vitest";
import { lazyCodePlugin } from "./code-highlighter";

describe("lazyCodePlugin", () => {
  it("highlights with the Vitesse pair", () => {
    expect(lazyCodePlugin.getThemes()).toEqual(["vitesse-light", "vitesse-dark"]);
  });
});
