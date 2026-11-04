import type { PrAttachment } from "@pi-code/protocol";
import { useConversation, useLive } from "@/store/context";

/** The PR the current conversation is attached to (`docs/design/10-pr-review.md`), if any. */
export function useConversationPr(): PrAttachment | undefined {
  const file = useConversation((s) => s.agent.sessionFile);
  return useLive((s) => (file === undefined ? undefined : s.prs[file]));
}

/** Whether the PR has pushes newer than the head the conversation is pinned to. */
export function isOutdated(pr: PrAttachment): boolean {
  return pr.remoteHeadSha !== pr.headSha;
}

/**
 * The prompt behind "No PR for this branch"'s button: push the branch and open a draft PR. The
 * conversation isn't attached afterwards; `/pr` does that.
 */
export function draftPrPrompt(branch: string | null): string {
  // Git allows `;`, `$`, backticks and the like in branch names: quoted for the shell.
  const target = branch === null ? "HEAD" : `'${branch.replaceAll("'", `'\\''`)}'`;
  return [
    "Open a draft pull request for this branch:",
    `1. Push it: \`git push -u origin ${target}\`.`,
    "2. Create the PR with `gh pr create --draft --title <title> --body <description>`, writing the title and description from the branch's changes.",
    "3. Tell me the PR number.",
  ].join("\n");
}
