import type { SidebarPatch, SidebarState } from "./types.ts";

/** The lists of a `SidebarState`; `satisfies` fails to compile until a new key is listed. */
export const SIDEBAR_KEYS = Object.keys({
  pinned: true,
  collapsed: true,
} satisfies Record<keyof SidebarState, true>) as (keyof SidebarState)[];

/** `state` with `patch`'s flags set; a list `patch` doesn't change keeps its identity. */
export function applySidebarPatch<S extends SidebarState>(state: S, patch: SidebarPatch): S {
  const next = { ...state };
  for (const key of SIDEBAR_KEYS) {
    for (const [path, on] of Object.entries(patch[key] ?? {})) {
      const has = next[key].includes(path);
      if (on && !has) next[key] = [...next[key], path];
      else if (!on && has) next[key] = next[key].filter((p) => p !== path);
    }
  }
  return next;
}
