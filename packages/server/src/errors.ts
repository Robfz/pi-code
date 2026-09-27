import type { ErrorCode, ErrorEnvelope } from "./types-temp.ts";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_body: 400,
  outside_home: 400,
  command_not_allowed: 400,
  streaming_behavior_required: 400,
  forbidden_origin: 403,
  forbidden_host: 403,
  not_found: 404,
  agent_not_found: 404,
  session_not_found: 404,
  not_a_git_repo: 404,
  dialog_not_found: 404,
  session_owned: 409,
  agent_exited: 409,
  agent_busy: 409,
  pi_error: 502,
  pi_timeout: 504,
  internal: 500,
};

/** An error with a contract error code; the HTTP layer renders it as the error envelope. */
export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  toJSON(): ErrorEnvelope {
    return errorEnvelope(this.code, this.message);
  }
}

export function errorEnvelope(code: ErrorCode, message: string): ErrorEnvelope {
  return { error: { code, message } };
}

export function isApiError(e: unknown, code?: ErrorCode): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}
