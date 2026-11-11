import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

/**
 * The server matches the guide job's events on this name (`GUIDE_TOOL` in
 * `packages/server/src/pr/guide-prompt.ts`).
 */
export const GUIDE_TOOL = "submit_guide";

export const guideSchema = Type.Object({
  sections: Type.Array(
    Type.Object({
      title: Type.String({ description: "Short title of the section" }),
      explanation: Type.String({
        description: "Markdown: why these changes exist and how they fit the PR",
      }),
      hunks: Type.Array(Type.String(), {
        minItems: 1,
        description: "Ids of the section's hunks, as labelled in the diff file (`<path>#<n>`)",
      }),
    }),
    { minItems: 1, description: "The guide's sections, in reading order" },
  ),
});

export type GuideArgs = Static<typeof guideSchema>;

/**
 * The PR guide job's extension (design/11-pr-guide.md), loaded with `-e` only into the guide
 * job's `pi --mode json`, never into conversations: it registers `submit_guide`, whose validated
 * arguments the server reads from the job's event stream as the result's `details`. pi coerces
 * arguments while validating them (a lone string for an array), so the raw arguments that
 * `tool_execution_start` carries may not match the schema. Ending the run on the call spares a
 * closing turn.
 */
export default function guideExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: GUIDE_TOOL,
    label: "Submit guide",
    description:
      "Submit the finished PR guide: its sections in reading order, each with a title, a markdown explanation of why its changes exist, and the ids of its hunks. Call it exactly once, as your last action.",
    parameters: guideSchema,
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "Guide submitted." }],
        details: params,
        terminate: true,
      };
    },
  });
}
