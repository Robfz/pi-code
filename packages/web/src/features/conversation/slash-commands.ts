/**
 * Slash commands (`docs/design/03-web-client.md`, "Composer" → "Built-in commands").
 * Built-ins are implemented by the client; everything else (`get_commands`: extension,
 * skill, prompt template) is sent to pi as a prompt, which runs it.
 */

import type { SlashCommandInfo } from "@pi-code/protocol";

export type SlashSource = "builtin" | SlashCommandInfo["source"];

export interface SlashItem {
  name: string;
  description?: string;
  argumentHint?: string;
  source: SlashSource;
}

export interface BuiltinCommand extends SlashItem {
  source: "builtin";
  /** Only the TUI can do it; the client answers "Use the TUI for this". */
  tuiOnly?: boolean;
}

export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  { name: "new", description: "Start a new session", source: "builtin" },
  { name: "resume", description: "Resume a different session", source: "builtin" },
  {
    name: "name",
    description: "Set session display name",
    argumentHint: "<name>",
    source: "builtin",
  },
  {
    name: "model",
    description: "Select model",
    argumentHint: "[provider/model]",
    source: "builtin",
  },
  {
    name: "thinking",
    description: "Set thinking level",
    argumentHint: "[level]",
    source: "builtin",
  },
  {
    name: "compact",
    description: "Manually compact the session context",
    argumentHint: "[instructions]",
    source: "builtin",
  },
  { name: "tree", description: "Navigate session tree (switch branches)", source: "builtin" },
  {
    name: "fork",
    description: "Create a new fork from a previous user message",
    source: "builtin",
  },
  {
    name: "clone",
    description: "Duplicate the current session at the current position",
    source: "builtin",
  },
  { name: "session", description: "Show session info and stats", source: "builtin" },
  { name: "copy", description: "Copy last agent message to clipboard", source: "builtin" },
  { name: "diff", description: "Show the project's git diff", source: "builtin" },
  {
    name: "pr",
    description: "Review a GitHub pull request with the agent",
    argumentHint: "[url|number]",
    source: "builtin",
  },
  ...(
    [
      ["settings", "Open settings menu"],
      ["login", "Configure provider authentication"],
      ["logout", "Remove provider authentication"],
      ["trust", "Save project trust decision for future sessions"],
      ["export", "Export session"],
      ["share", "Share session as a secret GitHub gist"],
      ["import", "Import and resume a session from a JSONL file"],
      ["reload", "Reload keybindings, extensions, skills, prompts, themes, and context files"],
      ["scoped-models", "Enable/disable models for Ctrl+P cycling"],
      ["hotkeys", "Show all keyboard shortcuts"],
      ["changelog", "Show changelog entries"],
      ["bug", "Report a bug to the Pi developers"],
      ["quit", "Quit pi"],
    ] as const
  ).map(
    ([name, description]): BuiltinCommand => ({
      name,
      description,
      source: "builtin",
      tuiOnly: true,
    }),
  ),
];

/** The built-ins the server refuses for a conversation attached to a PR. */
const BRANCHING_COMMANDS: ReadonlySet<string> = new Set(["tree", "fork"]);

/** The built-ins to suggest: without `/tree` and `/fork` when attached to a PR. */
export function builtinCommands(prAttached: boolean): readonly BuiltinCommand[] {
  return prAttached
    ? BUILTIN_COMMANDS.filter((c) => !BRANCHING_COMMANDS.has(c.name))
    : BUILTIN_COMMANDS;
}

const builtinByName = new Map(BUILTIN_COMMANDS.map((c) => [c.name, c]));

export function findBuiltin(name: string): BuiltinCommand | undefined {
  return builtinByName.get(name);
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/** `get_commands` results as autocomplete items, without pi-code's own extension commands. */
export function commandItems(
  commands: readonly Pick<SlashCommandInfo, "name" | "description" | "source">[],
): SlashItem[] {
  return commands
    .filter((c) => !c.name.startsWith("pi-code"))
    .map((c) => ({
      name: c.name,
      source: c.source,
      ...(c.description ? { description: c.description } : {}),
    }));
}

/**
 * The command name being typed, while the text is a lone `/word` (no whitespace yet);
 * otherwise null.
 */
export function slashQuery(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text);
  return match ? (match[1] ?? "") : null;
}

/** Items whose name starts with the query (then those containing it), built-ins first. */
export function filterSlashItems(items: readonly SlashItem[], query: string): SlashItem[] {
  const q = query.toLowerCase();
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
  const prefix = unique.filter((i) => i.name.toLowerCase().startsWith(q));
  const contains =
    q === ""
      ? []
      : unique.filter(
          (i) => !i.name.toLowerCase().startsWith(q) && i.name.toLowerCase().includes(q),
        );
  return [...prefix, ...contains];
}

/** `/name args` → `{ name, args }` (args trimmed); null when the text isn't a slash command. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}

/** `!cmd` → bash; `!!cmd` → bash excluded from the context. */
export function parseBash(text: string): { command: string; excludeFromContext: boolean } | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("!!")) {
    const command = trimmed.slice(2).trim();
    return command === "" ? null : { command, excludeFromContext: true };
  }
  if (trimmed.startsWith("!")) {
    const command = trimmed.slice(1).trim();
    return command === "" ? null : { command, excludeFromContext: false };
  }
  return null;
}

export const SOURCE_LABEL: Record<SlashSource, string> = {
  builtin: "built-in",
  extension: "extension",
  skill: "skill",
  prompt: "template",
};
