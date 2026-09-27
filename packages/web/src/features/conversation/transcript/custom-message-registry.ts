/**
 * Card renderers for extension custom messages, keyed by `customType`
 * (`docs/design/03-web-client.md`, "Transcript rendering"). Types without a renderer show as
 * generic markdown.
 */

import type { ImageContent, TextContent } from "@pi-code/protocol";
import type { ComponentType } from "react";

export interface CustomMessageRendererProps {
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
}

const renderers = new Map<string, ComponentType<CustomMessageRendererProps>>();

export function registerCustomMessageRenderer(
  customType: string,
  component: ComponentType<CustomMessageRendererProps>,
): void {
  renderers.set(customType, component);
}

export function getCustomMessageRenderer(
  customType: string,
): ComponentType<CustomMessageRendererProps> | undefined {
  return renderers.get(customType);
}
