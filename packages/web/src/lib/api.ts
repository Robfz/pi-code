/**
 * API client for `docs/design/02-api-contract.md`.
 *
 * Routes already in the server's `AppType` (health, agents list/open/close) go through Hono's
 * typed `hc` client. The rest (snapshot, rpc, ui-responses, trust, restart, ack) use thin typed
 * `fetch` wrappers over the protocol types; each can switch to `hc` once its route is chained
 * into `AppType`, without changing call sites.
 */

import type {
  AgentId,
  AgentInfo,
  AgentResponse,
  AgentsResponse,
  AllowedRpcCommandType,
  DirSuggestion,
  DirsResponse,
  HealthResponse,
  NavigateBody,
  NavigateResponse,
  OpenAgentBody,
  ProjectSummary,
  ProjectsResponse,
  RpcCommandBody,
  RpcCommandResult,
  SessionSummary,
  SessionsResponse,
  Snapshot,
  UiResponseBody,
  VapidKeyResponse,
} from "@pi-code/protocol";
import { isApiError } from "@pi-code/protocol";
import type { AppType } from "@pi-code/server";
import { hc } from "hono/client";

function origin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
}

/** Typed `hc` client; routes come from the server's `AppType`. */
export const api = hc<AppType>(origin());

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

async function checked(res: Response): Promise<Response> {
  if (!res.ok) throw await toError(res);
  return res;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  } else if (method !== "GET") {
    // Every non-GET request must carry a JSON content type.
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await checked(await fetch(new URL(path, origin()), init));
  if (res.status === 204 || res.headers.get("content-length") === "0") return undefined as T;
  const text = await res.text();
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

const agentPath = (id: AgentId, suffix = "") => `/api/agents/${encodeURIComponent(id)}${suffix}`;

// ---------------------------------------------------------------------------
// Typed through `hc`

export async function getHealth(): Promise<HealthResponse> {
  const res = await checked(await api.api.health.$get());
  return (await res.json()) as HealthResponse;
}

export async function listAgents(): Promise<AgentInfo[]> {
  const res = await checked(await api.api.agents.$get());
  return ((await res.json()) as AgentsResponse).agents;
}

export async function openAgent(body: OpenAgentBody): Promise<AgentInfo> {
  const res = await checked(await api.api.agents.$post({ json: body }));
  return ((await res.json()) as AgentResponse).agent;
}

export async function closeAgent(id: AgentId): Promise<void> {
  await checked(await api.api.agents[":id"].$delete({ param: { id } }));
}

// ---------------------------------------------------------------------------
// Thin fetch wrappers (routes not in `AppType` yet)

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

/** SSE URL; `since` is the snapshot's `seq` on the first connect. */
export function eventsUrl(id: AgentId, since: number): string {
  return new URL(agentPath(id, `/events?since=${since}`), origin()).toString();
}

// ---------------------------------------------------------------------------
// Catalog and tree navigation

export async function listProjects(): Promise<ProjectSummary[]> {
  return (await request<ProjectsResponse>("GET", "/api/projects")).projects;
}

/** Sessions, most recent first; all projects when `cwd` is absent. */
export async function listSessions(cwd?: string): Promise<SessionSummary[]> {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  return (await request<SessionsResponse>("GET", `/api/sessions${query}`)).sessions;
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
