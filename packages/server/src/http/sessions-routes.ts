import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { DeleteSessionBody } from "@pi-code/protocol";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type { AgentManager } from "../agents/agent-manager.ts";
import { deleteSessionFiles } from "../catalog/session-files.ts";
import type { SessionCatalog } from "../catalog/sessions.ts";
import { ApiError } from "../errors.ts";
import type { StreamHub } from "../live/stream-hub.ts";
import { canonicalize } from "../paths.ts";

interface SessionsDeps {
  manager: AgentManager;
  catalog: SessionCatalog;
  hub: StreamHub;
  /** Moves a file to the Trash (default `trash`). */
  trashCommand?: string;
}

function parseDeleteBody(value: unknown): DeleteSessionBody {
  if (typeof value === "object" && value !== null) {
    const { file } = value as Record<string, unknown>;
    if (typeof file === "string" && file !== "") {
      if (!isAbsolute(file)) throw new ApiError("invalid_body", "file must be an absolute path");
      return { file };
    }
  }
  throw new ApiError("invalid_body", "expected { file: string }");
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Deletes `file` only if the catalog lists it (`<agentDir>/sessions/<dir>/*.jsonl` with a session
 * header). A missing file is done: already gone, or never written (pi writes it on the first
 * message). `stopped`: an agent holding it was closed, which the refusal mentions.
 */
async function deleteListed(
  catalog: SessionCatalog,
  file: string,
  stopped: boolean,
  trashCommand: string | undefined,
): Promise<void> {
  catalog.invalidate();
  if ((await catalog.sessions()).some((s) => s.file === file)) {
    const failed = await deleteSessionFiles([file], trashCommand);
    if (failed.length > 0) throw new ApiError("internal", `could not delete session file: ${file}`);
  } else if (await exists(file)) {
    const kept = `${file} is outside pi's sessions folder or not a listed session`;
    throw new ApiError(
      "session_not_listed",
      stopped ? `the conversation was stopped but its file was kept: ${kept}` : kept,
    );
  }
}

/**
 * `DELETE /api/sessions` (the listing is in `catalog-routes.ts`). Chained so the route types
 * reach `AppType`. pi has no session locking: an agent opening the file between the close and the
 * deletion races it.
 */
export function sessionsRoutes({ manager, catalog, hub, trashCommand }: SessionsDeps) {
  return new Hono().delete(
    "/",
    validator("json", (value) => parseDeleteBody(value)),
    async (c) => {
      // Agents' and the catalog's session files are realpaths.
      const file = await canonicalize(c.req.valid("json").file);
      try {
        // A running pi would recreate its session file after the deletion below.
        const stopped = await manager.closeWhere((a) => a.sessionFile === file);
        await deleteListed(catalog, file, stopped > 0, trashCommand);
      } finally {
        await hub.refreshCatalog();
      }
      return c.body(null, 204);
    },
  );
}
