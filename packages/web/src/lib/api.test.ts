import type { GitDiffResponse } from "@pi-code/protocol";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  closeAgent,
  errorMessage,
  getFileContent,
  getGitDiff,
  isNetworkError,
} from "./api";

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

describe("review reads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stub(...responses: Response[]) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const res = responses.shift();
      if (!res) throw new Error("unexpected fetch");
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = (i: number) => {
      const [input, init] = fetchMock.mock.calls[i] as [RequestInfo | URL, RequestInit];
      return new Request(input, init);
    };
    return { fetchMock, request };
  }

  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json", ...headers },
    });

  it("GET the diff and the file content, returning the parsed body", async () => {
    const diff = { files: [], oldRev: "abc1234" };
    const content = { path: "a.txt", content: "a\n", binary: false, tooLarge: false };
    const { request } = stub(json(diff), json(content));
    expect(await getGitDiff("a1", { base: "main", uncommitted: true })).toEqual(diff);
    expect(await getFileContent("a1", "src/a b.ts")).toEqual(content);
    expect(request(0).method).toBe("GET");
    const pathOf = (i: number) => {
      const url = new URL(request(i).url);
      return url.pathname + url.search;
    };
    expect(pathOf(0)).toBe("/api/agents/a1/git/diff?base=main&uncommitted=1");
    expect(pathOf(1)).toBe("/api/agents/a1/files/content?path=src%2Fa%20b.ts");
  });

  it("revalidates with the previous response's ETag and returns it as is on a 304", async () => {
    const { fetchMock, request } = stub(
      json({ files: [] }, { ETag: '"e1"' }),
      new Response(null, { status: 304, headers: { ETag: '"e1"' } }),
      json({ files: [], oldRev: "abc1234" }, { ETag: '"e2"' }),
    );
    const first = await getGitDiff("a1");
    expect(first).toEqual({ files: [], etag: '"e1"' });
    expect(request(0).headers.get("if-none-match")).toBeNull();

    expect(await getGitDiff("a1", {}, first)).toBe(first);
    expect(request(1).headers.get("if-none-match")).toBe('"e1"');

    expect(await getGitDiff("a1", {}, first)).toEqual({
      files: [],
      oldRev: "abc1234",
      etag: '"e2"',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reads the body of a 304", async () => {
    // Chromium gives a 304 an empty body stream; the Fetch standard (and so Node) gives it none.
    const notModified = new Response("", { headers: { ETag: '"e1"' } });
    Object.defineProperties(notModified, { status: { value: 304 }, ok: { value: false } });
    stub(notModified);
    const previous = { files: [], etag: '"e1"' };
    expect(await getGitDiff("a1", {}, previous)).toBe(previous);
    expect(notModified.bodyUsed).toBe(true);
  });

  it("sends no condition without an ETag to match", async () => {
    const content = { path: "a.txt", content: "a\n", binary: false, tooLarge: false };
    const { request } = stub(json(content));
    expect(await getFileContent("a1", "a.txt", content)).toEqual(content);
    expect(request(0).headers.get("if-none-match")).toBeNull();
  });

  it("keeps the ETag on the data react-query holds after structural sharing", async () => {
    const a = { path: "a.txt", status: "modified", binary: false, tooLarge: false, patch: "a" };
    const b = { ...a, path: "b.txt", patch: "b" };
    const { request } = stub(
      json({ files: [a] }, { ETag: '"e1"' }),
      json({ files: [a, b] }, { ETag: '"e2"' }),
      new Response(null, { status: 304, headers: { ETag: '"e2"' } }),
    );
    const client = new QueryClient();
    const query = {
      queryKey: ["diff"],
      queryFn: ({ client, queryKey }: { client: QueryClient; queryKey: readonly unknown[] }) =>
        getGitDiff("a1", {}, client.getQueryData(queryKey)),
      staleTime: 0,
    };
    const cached = async () => {
      await client.fetchQuery(query);
      return client.getQueryData<GitDiffResponse>(query.queryKey);
    };
    const first = await cached();
    const second = await cached();
    // Shared with the first response where unchanged, so not the object `getGitDiff` returned.
    expect(second?.files[0]).toBe(first?.files[0]);
    expect(await cached()).toBe(second);
    expect(request(2).headers.get("if-none-match")).toBe('"e2"');
  });

  it("throws the contract error", async () => {
    stub(
      new Response(JSON.stringify({ error: { code: "not_a_git_repo", message: "nope" } }), {
        status: 404,
      }),
    );
    await expect(getGitDiff("a1")).rejects.toMatchObject({ status: 404, code: "not_a_git_repo" });
  });
});
