import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, closeAgent, errorMessage, isNetworkError } from "./api";

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

describe("closeAgent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends DELETE with a JSON content type (required by the server's request guard)", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await closeAgent("a1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const request = new Request(input, init);
    expect(request.method).toBe("DELETE");
    expect(new URL(request.url).pathname).toBe("/api/agents/a1");
    expect(request.headers.get("content-type")).toBe("application/json");
  });
});
