import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

/** Small, cheap model that writes the titles. */
export const TITLE_MODEL = { provider: "anthropic", id: "claude-haiku-5-5" } as const;

/** Longest excerpt of each side of the exchange sent to the title model, in characters. */
export const EXCERPT_MAX = 4_000;

/** Longest accepted title, in characters. */
export const TITLE_MAX = 80;

const TITLE_PROMPT =
  "You name conversations between a user and a coding agent. Reply with only a short title of 3 to 6 words, in sentence case, that captures what the user wants. No quotes, no trailing punctuation.";

export interface Exchange {
  user: string;
  assistant: string;
}

/** Joined text blocks of message content. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n")
    .trim();
}

/**
 * The first user message on the branch and the last assistant text before the next user message
 * (the first run's final reply). `undefined` until that reply has text.
 *
 * The user side keeps its end: attached files are prepended as `<file>` blocks, so the request
 * itself comes last. The reply keeps its start.
 */
export function firstExchange(branch: SessionEntry[]): Exchange | undefined {
  let user: string | undefined;
  let assistant = "";
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role === "user") {
      if (user !== undefined) break;
      user = textOf(message.content);
    } else if (message.role === "assistant" && user !== undefined) {
      assistant = textOf(message.content) || assistant;
    }
  }
  if (!user || !assistant) return undefined;
  return { user: user.slice(-EXCERPT_MAX), assistant: assistant.slice(0, EXCERPT_MAX) };
}

/** First non-empty line, without wrapping quotes or trailing punctuation; `undefined` if empty. */
export function cleanTitle(raw: string): string | undefined {
  const line = raw
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return undefined;
  const title = line
    .replace(/^["'`*_#\s]+|["'`*_\s]+$/g, "")
    .replace(/[.!?:;,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return undefined;
  const chars = Array.from(title);
  return chars.length <= TITLE_MAX
    ? title
    : `${chars
        .slice(0, TITLE_MAX - 1)
        .join("")
        .trimEnd()}…`;
}

/** Asks the title model for a title; throws when the request fails or the reply is empty. */
async function generateTitle(
  ctx: ExtensionContext,
  model: NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>,
  exchange: Exchange,
  signal: AbortSignal,
): Promise<string> {
  const reply = await ctx.modelRegistry
    .streamSimple(
      model,
      {
        systemPrompt: TITLE_PROMPT,
        messages: [
          {
            role: "user",
            content: `<user>\n${exchange.user}\n</user>\n\n<assistant>\n${exchange.assistant}\n</assistant>`,
            timestamp: Date.now(),
          },
        ],
      },
      // Haiku 5.5 can't turn reasoning off; "low" is its lightest level, and the token budget
      // leaves room for that reasoning before the title.
      { reasoning: "low", maxTokens: 2_048, signal },
    )
    .result();
  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    throw new Error(reply.errorMessage ?? reply.stopReason);
  }
  const title = cleanTitle(textOf(reply.content));
  if (!title) throw new Error("empty reply");
  return title;
}

/**
 * Names an unnamed session after its first reply, once per session. Skips silently without
 * auth for the title model; warns once when a configured request fails. A name set meanwhile
 * (e.g. a manual rename) wins.
 */
export function registerAutoName(pi: ExtensionAPI): void {
  let attempted = false;
  let inFlight: AbortController | undefined;

  pi.on("session_start", () => {
    attempted = false;
  });
  // A late title must not land on the session that replaced this one.
  pi.on("session_shutdown", () => {
    inFlight?.abort();
  });

  pi.on("agent_end", (_event, ctx) => {
    if (attempted || pi.getSessionName()) return;
    const exchange = firstExchange(ctx.sessionManager.getBranch());
    if (!exchange) return;
    attempted = true;

    const model = ctx.modelRegistry.find(TITLE_MODEL.provider, TITLE_MODEL.id);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;

    const controller = new AbortController();
    inFlight = controller;
    // Not awaited, so the title request never holds up the end of the run.
    void generateTitle(ctx, model, exchange, controller.signal)
      .then((title) => {
        if (!controller.signal.aborted && !pi.getSessionName()) pi.setSessionName(title);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Couldn't auto-name this conversation: ${reason}`, "warning");
      })
      .finally(() => {
        if (inFlight === controller) inFlight = undefined;
      });
  });
}
