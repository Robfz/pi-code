import { API_ERROR_STATUS, type ApiErrorCode } from "@pi-code/protocol";

/**
 * Contract error codes plus two server-internal ones: `not_found` (no such route) and
 * `internal` (unexpected failures).
 */
type ErrorCode = ApiErrorCode | "not_found" | "internal";

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string };
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  ...API_ERROR_STATUS,
  not_found: 404,
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
