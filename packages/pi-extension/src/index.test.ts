import { describe, expect, it } from "vitest";
import piCodeExtension from "./index.ts";

describe("pi-code extension", () => {
  it("default-exports a factory function", () => {
    expect(typeof piCodeExtension).toBe("function");
  });
});
