import type { StartPrReviewBody } from "@pi-code/protocol";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { ApiError } from "../errors.ts";
import type { PrReviews } from "../pr/pr-reviews.ts";

function parseStartBody(value: unknown): StartPrReviewBody {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const { url } = value as Record<string, unknown>;
    if (Object.keys(value).every((key) => key === "url") && typeof url === "string") {
      return { url };
    }
  }
  throw new ApiError("invalid_body", "expected { url: string }");
}

/**
 * `/api/pr-reviews` (design/11-pr-guide.md, "Entry"): a PR review started from its URL. Chained so
 * the route types reach `AppType`.
 */
export function prReviewsRoutes(reviews: PrReviews) {
  return new Hono().post(
    "/",
    validator("json", (value) => parseStartBody(value)),
    async (c) => {
      const agent = await reviews.start(c.req.valid("json").url);
      return c.json({ agent: agent.info() }, 201);
    },
  );
}
