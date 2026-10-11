/** HTTP status for every API error code. */
export const API_ERROR_STATUS = {
  invalid_body: 400,
  outside_home: 400,
  command_not_allowed: 400,
  streaming_behavior_required: 400,
  not_in_layout: 400,
  not_a_worktree: 400,
  session_not_listed: 400,
  forbidden_origin: 403,
  forbidden_host: 403,
  agent_not_found: 404,
  session_not_found: 404,
  not_a_git_repo: 404,
  dialog_not_found: 404,
  session_owned: 409,
  agent_exited: 409,
  agent_busy: 409,
  worktree_exists: 409,
  branch_exists: 409,
  worktree_dirty: 409,
  pi_error: 502,
  git_failed: 502,
  pi_timeout: 504,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

/** Error response body: `{ error: { code, message } }`. */
export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}

export function isApiError(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === "string" && code in API_ERROR_STATUS && typeof message === "string";
}
