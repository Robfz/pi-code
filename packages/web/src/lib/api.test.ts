import { describe, expect, it } from "vitest";
import { ApiRequestError, errorMessage, isNetworkError } from "./api";

describe("errorMessage", () => {
  it("uses the contract error message", () => {
    expect(errorMessage(new ApiRequestError(409, "agent_busy", "agent is busy"))).toBe(
      "agent is busy",
    );
  });

  it("explains fetch rejections", () => {
    for (const message of ["Failed to fetch", "Load failed", "NetworkError when attempting"]) {
      expect(isNetworkError(new TypeError(message))).toBe(true);
      expect(errorMessage(new TypeError(message))).toBe("Can't reach the pi-code server.");
    }
    expect(isNetworkError(new TypeError("x is not a function"))).toBe(false);
    expect(errorMessage("plain")).toBe("plain");
  });
});
