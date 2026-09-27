/**
 * Registers every tool renderer. Import once (the conversation screen does) before rendering
 * tool calls. Add built-in renderers (W10–W12) here: `import "./bash";` etc.
 */

import { genericToolRenderer } from "./generic";
import { setFallbackToolRenderer } from "./registry";

setFallbackToolRenderer(genericToolRenderer);

export type { ToolRenderer, ToolRendererProps, ToolStatus } from "./registry";
export { getToolRenderer, registerToolRenderer } from "./registry";
