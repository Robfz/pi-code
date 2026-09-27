/**
 * Registers every tool renderer (and the custom message cards of the same extensions). Import
 * once (the conversation screen does, through `tool-call-view`) before rendering tool calls.
 */

import { genericToolRenderer } from "./generic";
import { setFallbackToolRenderer } from "./registry";
import "./builtin";
import "./file-edits";
import "./subagent";
import "./web-access";
import "./mcp";
import "./custom-messages";

setFallbackToolRenderer(genericToolRenderer);

export type { ToolRenderer, ToolRendererProps, ToolStatus } from "./registry";
export { getToolRenderer, registerToolRenderer } from "./registry";
