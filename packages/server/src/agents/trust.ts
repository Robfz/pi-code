/**
 * Project-trust pre-check (design/01-server.md, "Project trust"). RPC mode can't prompt for
 * trust, so the server decides before spawning pi whether to ask the user.
 */
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Entries under `<cwd>/.pi` that make pi ask for project trust. Mirrors
 * `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` in pi's `dist/core/trust-manager.js`
 * (`hasTrustRequiringProjectResources`); re-check on pi upgrades.
 */
export const TRUST_REQUIRING_PROJECT_RESOURCES = [
  "settings.json",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
] as const;

/** pi's `canonicalizePath`: the realpath, or the path itself when it can't be resolved. */
async function canonicalize(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Whether `cwd` has project-local resources gated by project trust: an entry of
 * `TRUST_REQUIRING_PROJECT_RESOURCES` under `cwd/.pi`, or `.agents/skills` in `cwd` or an
 * ancestor, except `~/.agents/skills` (a user resource).
 */
export async function hasTrustRequiringProjectResources(
  cwd: string,
  home: string,
): Promise<boolean> {
  const userAgentsSkills = join(await canonicalize(home), ".agents", "skills");
  let dir = await canonicalize(cwd);
  const configDir = join(dir, ".pi");
  if (TRUST_REQUIRING_PROJECT_RESOURCES.some((entry) => existsSync(join(configDir, entry)))) {
    return true;
  }
  for (;;) {
    const agentsSkills = join(dir, ".agents", "skills");
    if (agentsSkills !== userAgentsSkills && existsSync(agentsSkills)) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * The closest saved decision for `cwd` (its realpath, then each parent) in pi's `trust.json`
 * (`{ "<realpath>": true | false | null }`; `null` means "no decision here"). Read-only; a
 * missing or unreadable file counts as no decision.
 */
export async function savedTrustDecision(trustFile: string, cwd: string): Promise<boolean | null> {
  let data: unknown;
  try {
    data = JSON.parse((await readFile(trustFile, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const store = data as Record<string, unknown>;
  let dir = await canonicalize(cwd);
  for (;;) {
    const value = Object.hasOwn(store, dir) ? store[dir] : undefined;
    if (value === true || value === false) return value;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Whether pi would need a trust decision for `cwd` that nobody has made yet. */
export async function needsTrustDecision(opts: {
  cwd: string;
  home: string;
  agentDir: string;
}): Promise<boolean> {
  if (!(await hasTrustRequiringProjectResources(opts.cwd, opts.home))) return false;
  return (await savedTrustDecision(join(opts.agentDir, "trust.json"), opts.cwd)) === null;
}
