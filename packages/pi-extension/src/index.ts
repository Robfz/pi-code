import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ProjectTrustEventResult,
} from "@earendil-works/pi-coding-agent";

/** Asks the model to write line references the web client can parse and link. */
export const REFERENCE_GUIDELINE =
  'When you point to specific lines of code, write the reference as `@path:N` for one line or `@path:N-M` for a range, with the path relative to the working directory. Quote paths that contain spaces: `@"dir name/file.ts":N`. The user can click these references to open those lines.';

/**
 * pi-code extension, loaded with `--extension` into server-spawned pi processes only.
 * See docs/design/04-pi-extension.md.
 */
export default function piCodeExtension(pi: ExtensionAPI): void {
  pi.on("project_trust", projectTrust);
  pi.on("before_agent_start", addReferenceGuideline);
  pi.registerCommand("pi-code-tree", {
    description: "Internal: pi-code tree navigation",
    handler: treeCommand,
  });
}

/** Relays the trust decision the server obtained before spawning pi (`PI_CODE_TRUST`). */
export function projectTrust(): ProjectTrustEventResult {
  const decision = process.env.PI_CODE_TRUST;
  if (decision === "yes" || decision === "no") return { trusted: decision, remember: true };
  return { trusted: "undecided" };
}

/**
 * Adds the reference guideline to the run's prompt sections, leaving the rest of the prompt
 * (and the user's `APPEND_SYSTEM.md`) to pi. pi renders `promptGuidelines` only without a custom
 * prompt (`SYSTEM.md`), so with one the guideline joins `appendSystemPrompt` instead.
 */
export function addReferenceGuideline(event: BeforeAgentStartEvent): void {
  const options = event.systemPromptOptions;
  if (options.customPrompt) {
    if (!options.appendSystemPrompt.includes(REFERENCE_GUIDELINE)) {
      options.appendSystemPrompt = [options.appendSystemPrompt, REFERENCE_GUIDELINE]
        .filter(Boolean)
        .join("\n\n");
    }
  } else if (!options.promptGuidelines.includes(REFERENCE_GUIDELINE)) {
    options.promptGuidelines.push(REFERENCE_GUIDELINE);
  }
}

export interface TreeArgs {
  entryId: string;
  summarize?: boolean;
  customInstructions?: string;
}

/** Parses the `/pi-code-tree` JSON argument; returns an error message when invalid. */
export function parseTreeArgs(raw: string): TreeArgs | string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "argument is not valid JSON";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "argument must be a JSON object";
  }
  const { entryId, summarize, customInstructions } = value as Record<string, unknown>;
  if (typeof entryId !== "string" || entryId === "") return "entryId must be a non-empty string";
  if (summarize !== undefined && typeof summarize !== "boolean") {
    return "summarize must be a boolean";
  }
  if (customInstructions !== undefined && typeof customInstructions !== "string") {
    return "customInstructions must be a string";
  }
  return { entryId, summarize, customInstructions };
}

/**
 * `/pi-code-tree {"entryId":…,"summarize"?:…,"customInstructions"?:…}`: moves the leaf in place,
 * like the TUI's `/tree`. Navigation errors propagate (pi reports them as `extension_error`).
 */
export async function treeCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parsed = parseTreeArgs(args);
  if (typeof parsed === "string") {
    ctx.ui.notify(`pi-code-tree: ${parsed}`, "error");
    return;
  }
  const { entryId, summarize, customInstructions } = parsed;
  const result = await ctx.navigateTree(entryId, { summarize, customInstructions });
  if (result.cancelled) return;

  const entry = ctx.sessionManager.getEntry(entryId);
  if (entry?.type !== "message" || entry.message.role !== "user") return;
  const { content } = entry.message;
  const text =
    typeof content === "string"
      ? content
      : content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  if (text) ctx.ui.setEditorText(text);
}
