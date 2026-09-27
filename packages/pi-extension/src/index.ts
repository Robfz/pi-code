import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProjectTrustEventResult,
} from "@earendil-works/pi-coding-agent";

/**
 * pi-code extension, loaded with `--extension` into server-spawned pi processes only.
 * See docs/design/04-pi-extension.md.
 */
export default function piCodeExtension(pi: ExtensionAPI): void {
  pi.on("project_trust", projectTrust);
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
