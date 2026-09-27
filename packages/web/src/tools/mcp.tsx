/**
 * pi-mcp-adapter tools: the `mcp` gateway and `mcp__<server>` namespace proxies
 * (`{ tool, args }`). Header shows `server · tool`; the body shows the MCP arguments and the
 * result content. Calls whose shape isn't recognised render with the generic renderer.
 */

import { prettyJson, toolResultText } from "@/lib/content";
import { asRecord, Images, isActive, Muted, Pending, resultImages, str } from "./common";
import { genericToolRenderer, OutputBlock } from "./generic";
import { registerToolRenderer, type ToolRenderer, type ToolRendererProps } from "./registry";

export const MCP_NAMESPACE_PREFIX = "mcp__";

export function isMcpNamespaceTool(toolName: string): boolean {
  return toolName.startsWith(MCP_NAMESPACE_PREFIX) && toolName.length > MCP_NAMESPACE_PREFIX.length;
}

export interface McpCall {
  server?: string;
  /** Underlying tool for calls; the gateway action otherwise ("search x", "status", …). */
  label: string;
  /** Underlying tool arguments (calls only). */
  toolArgs?: unknown;
  isCall: boolean;
}

function parseArgsValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** What an `mcp` / `mcp__server` call does, or undefined when its shape is unknown. */
export function describeMcpCall(
  props: Pick<ToolRendererProps, "toolName" | "args" | "result" | "partialResult">,
): McpCall | undefined {
  const args = asRecord(props.args) ?? {};
  const details =
    asRecord(props.result?.details) ?? asRecord(asRecord(props.partialResult)?.details);
  const detailServer = str(details, "server");
  const detailTool = str(details, "tool") ?? str(details, "requestedTool");

  if (isMcpNamespaceTool(props.toolName)) {
    const server = detailServer ?? props.toolName.slice(MCP_NAMESPACE_PREFIX.length);
    const tool = str(args, "tool") ?? detailTool;
    if (!tool) return undefined;
    return { server, label: tool, toolArgs: parseArgsValue(args.args), isCall: true };
  }

  // `mcp` gateway
  const server = detailServer ?? str(args, "server");
  const tool = str(args, "tool");
  if (tool) {
    return { server, label: detailTool ?? tool, toolArgs: parseArgsValue(args.args), isCall: true };
  }
  const action = str(args, "action");
  if (action) return { server, label: action, isCall: false };
  const connect = str(args, "connect");
  if (connect) return { server: connect, label: "connect", isCall: false };
  const describe = str(args, "describe");
  if (describe) return { server, label: `describe ${describe}`, isCall: false };
  const search = str(args, "search");
  if (search) return { server, label: `search "${search}"`, isCall: false };
  const instructions = str(args, "instructions");
  if (instructions) return { server: instructions, label: "instructions", isCall: false };
  if (server) return { server, label: "list tools", isCall: false };
  return { label: "status", isCall: false };
}

function McpSummary(props: ToolRendererProps) {
  const call = describeMcpCall(props);
  if (!call) return genericToolRenderer.Summary ? <genericToolRenderer.Summary {...props} /> : null;
  return (
    <span className="font-mono">
      {call.server && (
        <>
          {call.server}
          <Muted> · </Muted>
        </>
      )}
      {call.label}
    </span>
  );
}

function hasContent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return value !== "";
}

/** Pretty-print JSON text results; other text passes through. */
function formatResultText(text: string): string {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

function McpBody(props: ToolRendererProps) {
  const call = describeMcpCall(props);
  if (!call) return <genericToolRenderer.Body {...props} />;
  const text = toolResultText(props.result);
  const partial = toolResultText(props.partialResult);
  const showArgs = call.isCall ? hasContent(call.toolArgs) : false;
  return (
    <div className="flex flex-col gap-2">
      {showArgs && (
        <details open={props.result === undefined}>
          <summary className="cursor-pointer text-xs text-muted-foreground select-none">
            Arguments
          </summary>
          <OutputBlock text={prettyJson(call.toolArgs)} />
        </details>
      )}
      {props.result === undefined ? (
        partial !== "" ? (
          <OutputBlock text={partial} />
        ) : (
          isActive(props.status) && <Pending />
        )
      ) : (
        <>
          <Images images={resultImages(props.result)} />
          {text !== "" ? (
            <OutputBlock text={formatResultText(text)} error={props.isError} />
          ) : (
            resultImages(props.result).length === 0 && (
              <p className="text-xs text-muted-foreground">
                {props.isError ? "Failed (no output)" : "No output"}
              </p>
            )
          )}
        </>
      )}
    </div>
  );
}

export const mcpRenderer: ToolRenderer = { Summary: McpSummary, Body: McpBody };

registerToolRenderer("mcp", mcpRenderer);
registerToolRenderer(isMcpNamespaceTool, mcpRenderer);
