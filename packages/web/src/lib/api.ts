/**
 * API client for `docs/design/02-api-contract.md`: one typed function per route over a single
 * `fetch` wrapper (`request`), with request and response types from `@pi-code/protocol`. Errors
 * become `ApiRequestError` carrying the contract error code.
 */

import type {
  AgentId,
  AgentInfo,
  AgentResponse,
  AllowedRpcCommandType,
  CreateWorktreeBody,
  CursorList,
  DeleteSessionBody,
  DirSuggestion,
  DirsResponse,
  FileContentResponse,
  FileSearchResponse,
  GitBranchesResponse,
  GitDiffResponse,
  HealthResponse,
  NavigateBody,
  NavigateResponse,
  OpenAgentBody,
  PrAttachment,
  PrGuideResponse,
  ProjectSummary,
  ProjectsResponse,
  PrResponse,
  RemoveWorktreeBody,
  RpcCommandBody,
  RpcCommandResult,
  SessionSummary,
  SessionsResponse,
  SidebarPatch,
  SidebarResponse,
  SidebarView,
  Snapshot,
  UiResponseBody,
  VapidKeyResponse,
} from "@pi-code/protocol";
import { isApiError } from "@pi-code/protocol";

function origin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
}

/** Non-2xx response. `code` is the contract error code (or `http_<status>` when absent). */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

export function isApiRequestError(error: unknown, code?: string): error is ApiRequestError {
  return error instanceof ApiRequestError && (code === undefined || error.code === code);
}

/** `fetch` rejections (no network, server down): "Failed to fetch", "Load failed", … */
export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError && /fetch|network|load failed/i.test(error.message);
}

/** Human-readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (isNetworkError(error)) return "Can't reach the pi-code server.";
  if (error instanceof Error) return error.message;
  return String(error);
}

async function toError(res: Response): Promise<ApiRequestError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (isApiError(body)) return new ApiRequestError(res.status, body.error.code, body.error.message);
  // Error codes outside the protocol's list (e.g. the server's `not_found`, `internal`).
  const error = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  if (typeof error?.code === "string") {
    return new ApiRequestError(res.status, error.code, String(error.message ?? res.statusText));
  }
  return new ApiRequestError(res.status, `http_${res.status}`, res.statusText || "Request failed");
}

/** JSON request to an API path; every non-GET request carries a JSON content type. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  } else if (method !== "GET") {
    // Every non-GET request must carry a JSON content type.
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await fetch(new URL(path, origin()), init);
  if (!res.ok) throw await toError(res);
  if (res.status === 204 || res.headers.get("content-length") === "0") return undefined as T;
  const text = await res.text();
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

/** A response of `getRevalidated` with its `ETag`, for revalidating it. */
export type Revalidatable<T> = T & { etag?: string };

/**
 * GET of an API path, conditional on `previous`, the cached response to the same path: on a 304,
 * `previous` itself, so react-query keeps its data without parsing or comparing a new copy. The
 * ETag rides in the data rather than beside it: react-query's structural sharing replaces the
 * object when anything changed, and the tag has to match whatever object the cache ends up with.
 */
async function getRevalidated<T extends object>(
  path: string,
  previous: Revalidatable<T> | undefined,
): Promise<Revalidatable<T>> {
  const headers: Record<string, string> = previous?.etag ? { "If-None-Match": previous.etag } : {};
  const res = await fetch(new URL(path, origin()), { headers });
  if (res.status === 304 && previous) {
    // Chromium reports a request finished only once its body is read, even a 304's empty one;
    // cancelling the body aborts the request instead.
    await res.arrayBuffer();
    return previous;
  }
  if (!res.ok) throw await toError(res);
  const data = (await res.json()) as T;
  const etag = res.headers.get("ETag");
  return etag === null ? data : { ...data, etag };
}

const agentPath = (id: AgentId, suffix = "") => `/api/agents/${encodeURIComponent(id)}${suffix}`;

// ---------------------------------------------------------------------------
// Health and agents

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("GET", "/api/health");
}

export async function openAgent(body: OpenAgentBody): Promise<AgentInfo> {
  return (await request<AgentResponse>("POST", "/api/agents", body)).agent;
}

export function closeAgent(id: AgentId): Promise<void> {
  return request<void>("DELETE", agentPath(id));
}

export function getSnapshot(id: AgentId): Promise<Snapshot> {
  return request<Snapshot>("GET", agentPath(id, "/snapshot"));
}

/** Send an allowlisted pi command; resolves to pi's response `data`. */
export async function rpc<C extends RpcCommandBody>(
  id: AgentId,
  command: C,
): Promise<RpcCommandResult<C["type"] & AllowedRpcCommandType>["data"]> {
  const res = await request<RpcCommandResult<C["type"] & AllowedRpcCommandType> | undefined>(
    "POST",
    agentPath(id, "/rpc"),
    command,
  );
  return res?.data as RpcCommandResult<C["type"] & AllowedRpcCommandType>["data"];
}

export function respondUi(id: AgentId, body: UiResponseBody): Promise<void> {
  return request<void>("POST", agentPath(id, "/ui-responses"), body);
}

export async function trustAgent(id: AgentId, trusted: boolean): Promise<AgentInfo> {
  return (await request<AgentResponse>("POST", agentPath(id, "/trust"), { trusted })).agent;
}

export async function restartAgent(id: AgentId): Promise<AgentInfo> {
  return (await request<AgentResponse>("POST", agentPath(id, "/restart"), {})).agent;
}

export function ackAgent(id: AgentId): Promise<void> {
  return request<void>("POST", agentPath(id, "/ack"), {});
}

/**
 * The agent's project diff: uncommitted changes against `HEAD`, or with `base` the branch's changes
 * since its merge-base with `origin/<base>`, else the local branch (`uncommitted` adds the working
 * tree and untracked files), or with `pr` the attached PR's pinned base to its pinned head.
 * `not_a_git_repo` outside a repository. `previous` (the cached diff of the same query) comes back
 * as is when unchanged.
 */
export function getGitDiff(
  id: AgentId,
  { base, uncommitted, pr }: { base?: string; uncommitted?: boolean; pr?: boolean } = {},
  previous?: Revalidatable<GitDiffResponse>,
): Promise<Revalidatable<GitDiffResponse>> {
  const params = new URLSearchParams();
  if (pr) params.set("pr", "1");
  else if (base !== undefined) {
    params.set("base", base);
    if (uncommitted) params.set("uncommitted", "1");
  }
  const query = params.toString();
  return getRevalidated(agentPath(id, `/git/diff${query && `?${query}`}`), previous);
}

/** Local branches, most recent first, and the detected default branch. */
export function getGitBranches(id: AgentId): Promise<GitBranchesResponse> {
  return request<GitBranchesResponse>("GET", agentPath(id, "/git/branches"));
}

/** `git fetch origin` in the agent's cwd; `git_failed` (with git's error) when it fails. */
export function fetchOrigin(id: AgentId): Promise<void> {
  return request<void>("POST", agentPath(id, "/git/fetch"), {});
}

/** Fuzzy file search in the agent's cwd: at most 10 cwd-relative paths, best first. */
export async function searchFiles(id: AgentId, q: string): Promise<string[]> {
  return (
    await request<FileSearchResponse>("GET", agentPath(id, `/files?q=${encodeURIComponent(q)}`))
  ).files;
}

/**
 * A project file's working-tree content, or with `rev` its content in that commit
 * (`file_not_found` when missing). `previous` (the cached content of the same path and rev) comes
 * back as is when unchanged.
 */
export function getFileContent(
  id: AgentId,
  path: string,
  rev?: string,
  previous?: Revalidatable<FileContentResponse>,
): Promise<Revalidatable<FileContentResponse>> {
  const query = `path=${encodeURIComponent(path)}${rev === undefined ? "" : `&rev=${encodeURIComponent(rev)}`}`;
  return getRevalidated(agentPath(id, `/files/content?${query}`), previous);
}

// ---------------------------------------------------------------------------
// Pull requests

/**
 * `/pr`: attaches the conversation to a PR (a URL or number; without one, the current branch's)
 * and sends the agent its context. `pr_not_found`, `pr_attached`, `not_a_github_repo`, … when
 * it can't.
 */
export async function attachPr(id: AgentId, pr?: string): Promise<PrAttachment> {
  return (await request<PrResponse>("POST", agentPath(id, "/pr"), pr ? { pr } : {})).pr;
}

/** Re-pins the attached PR to its latest commits and sends the agent what changed. */
export async function refreshPr(id: AgentId): Promise<PrAttachment> {
  return (await request<PrResponse>("POST", agentPath(id, "/pr/refresh"), {})).pr;
}

/** The attached PR's guide: generating, failed, or ready with its units. */
export function getPrGuide(id: AgentId): Promise<PrGuideResponse> {
  return request<PrGuideResponse>("GET", agentPath(id, "/pr/guide"));
}

/** Regenerates the attached PR's guide; its end arrives as a `guide` frame. */
export function retryPrGuide(id: AgentId): Promise<PrGuideResponse> {
  return request<PrGuideResponse>("POST", agentPath(id, "/pr/guide/retry"), {});
}

/** Checks the attached PR for new pushes; the result arrives as a `prs` frame. */
export function pollPr(id: AgentId): Promise<void> {
  return request<void>("POST", agentPath(id, "/pr/poll"), {});
}

/** `GET /api/stream` URL opening each conversation in `cursors` (status and catalog only when empty). */
export function streamUrl(cursors: CursorList): string {
  const query = cursors === "" ? "" : `?open=${encodeURIComponent(cursors)}`;
  return new URL(`/api/stream${query}`, origin()).toString();
}

// ---------------------------------------------------------------------------
// Catalog and tree navigation

export async function listProjects(): Promise<ProjectSummary[]> {
  return (await request<ProjectsResponse>("GET", "/api/projects")).projects;
}

/** Sessions, most recently prompted first; all projects when `cwd` is absent. */
export async function listSessions(cwd?: string): Promise<SessionSummary[]> {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  return (await request<SessionsResponse>("GET", `/api/sessions${query}`)).sessions;
}

/** Sessions whose cwd path or name contains `q` (case-insensitive), most recently prompted first. */
export async function searchSessions(q: string): Promise<SessionSummary[]> {
  return (await request<SessionsResponse>("GET", `/api/sessions?q=${encodeURIComponent(q)}`))
    .sessions;
}

/** Deletes a listed session file, stopping the agents that hold it first. */
export function deleteSession(file: string): Promise<void> {
  const body: DeleteSessionBody = { file };
  return request<void>("DELETE", "/api/sessions", body);
}

/** Directory autocomplete under `$HOME` (`prefix` may start with `~`). */
export async function listDirs(prefix: string): Promise<DirSuggestion[]> {
  return (await request<DirsResponse>("GET", `/api/fs/dirs?prefix=${encodeURIComponent(prefix)}`))
    .dirs;
}

export function navigateTree(id: AgentId, body: NavigateBody): Promise<NavigateResponse> {
  return request<NavigateResponse>("POST", agentPath(id, "/tree/navigate"), body);
}

// ---------------------------------------------------------------------------
// Sidebar

/** Sets pinned / collapsed flags per path; every client gets the result as a `sidebar` frame. */
export async function patchSidebar(patch: SidebarPatch): Promise<SidebarView> {
  return (await request<SidebarResponse>("PATCH", "/api/sidebar", patch)).sidebar;
}

// ---------------------------------------------------------------------------
// Worktrees

/** Creates `<repo>/<name>` (after a fetch) and opens a conversation there. */
export async function createWorktree(body: CreateWorktreeBody): Promise<AgentInfo> {
  return (await request<AgentResponse>("POST", "/api/worktrees", body)).agent;
}

/** Removes a linked or missing worktree, its conversations and its session files. */
export function removeWorktree(path: string, force = false): Promise<void> {
  const body: RemoveWorktreeBody = force ? { path, force } : { path };
  return request<void>("DELETE", "/api/worktrees", body);
}

// ---------------------------------------------------------------------------
// Push

export async function getVapidKey(): Promise<string> {
  return (await request<VapidKeyResponse>("GET", "/api/push/vapid-key")).publicKey;
}

/** Upload the browser's subscription (idempotent: the server keys it by endpoint). */
export function savePushSubscription(subscription: PushSubscriptionJSON): Promise<void> {
  return request<void>("POST", "/api/push/subscriptions", subscription);
}

export function deletePushSubscription(endpoint: string): Promise<void> {
  return request<void>("DELETE", "/api/push/subscriptions", { endpoint });
}
