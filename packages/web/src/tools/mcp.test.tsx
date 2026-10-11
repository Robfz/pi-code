import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { genericToolRenderer } from "./generic";
import { getToolRenderer } from "./index";
import { describeMcpCall, isMcpNamespaceTool, mcpRenderer } from "./mcp";
import { rowBody, rowParts } from "./testing";
import { ToolCallView } from "./tool-call-view";

const row = () => screen.getByTestId("tool-call");
const header = () => row().firstElementChild as HTMLElement;
const expand = () => userEvent.setup().click(header());
const showArguments = () =>
  userEvent.setup().click(screen.getByRole("button", { name: "Arguments" }));

describe("mcp renderers", () => {
  it("routes mcp and mcp__<server> tools to the MCP renderer", () => {
    expect(getToolRenderer("mcp")).toBe(mcpRenderer);
    expect(getToolRenderer("mcp__linear")).toBe(mcpRenderer);
    expect(isMcpNamespaceTool("mcp__")).toBe(false);
    // Direct MCP tools have server-chosen names: generic renderer.
    expect(getToolRenderer("linear_list_issues")).toBe(genericToolRenderer);
  });

  it("namespace tool: running row, then server · tool, arguments and JSON result", async () => {
    const { rerender } = render(
      <ToolCallView
        toolCallId="m1"
        toolName="mcp__linear"
        args={{ tool: "list_issues", args: { team: "ENG", limit: 5 } }}
        status="running"
        isError={false}
      />,
    );
    expect(rowParts(row())).toMatchObject({
      icon: "plug",
      verb: "Calling",
      shimmer: true,
      target: "linear · list_issues",
    });
    rerender(
      <ToolCallView
        toolCallId="m1"
        toolName="mcp__linear"
        args={{ tool: "list_issues", args: { team: "ENG", limit: 5 } }}
        status="done"
        isError={false}
        result={{
          content: [{ type: "text", text: '{"issues":[{"id":"ENG-1"}]}' }],
          details: { mode: "call", server: "linear", tool: "list_issues" },
        }}
      />,
    );
    expect(rowParts(row())).toMatchObject({
      verb: "Called",
      shimmer: false,
      target: "linear · list_issues",
      meta: undefined,
    });
    await expand();
    await showArguments();
    expect(screen.getByText(/"team": "ENG"/)).toBeInTheDocument();
    expect(screen.getByText(/"id": "ENG-1"/)).toBeInTheDocument();
  });

  it("gateway call with JSON-string args, gateway actions", () => {
    expect(
      describeMcpCall({
        toolName: "mcp",
        args: { tool: "search_docs", server: "figma", args: '{"q":"button"}' },
      }),
    ).toEqual({ server: "figma", label: "search_docs", toolArgs: { q: "button" }, isCall: true });
    expect(describeMcpCall({ toolName: "mcp", args: { search: "issues" } })?.label).toBe(
      'search "issues"',
    );
    expect(describeMcpCall({ toolName: "mcp", args: { connect: "linear" } })).toMatchObject({
      server: "linear",
      label: "connect",
    });
    expect(describeMcpCall({ toolName: "mcp", args: {} })?.label).toBe("status");
  });

  it("error result", async () => {
    render(
      <ToolCallView
        toolCallId="m2"
        toolName="mcp"
        args={{ tool: "nope" }}
        status="error"
        isError
        result={{
          content: [{ type: "text", text: 'Tool "nope" not found.' }],
          details: { mode: "call", error: "tool_not_found", requestedTool: "nope" },
        }}
      />,
    );
    expect(rowParts(row())).toMatchObject({
      icon: "circle-alert",
      verb: "Call failed",
      target: "nope",
      meta: 'Tool "nope" not found.',
    });
    await expand();
    expect(within(rowBody(row())).getByText('Tool "nope" not found.')).toHaveClass(
      "text-destructive",
    );
  });

  it("unrecognised namespace call falls back to the generic rendering", async () => {
    render(
      <ToolCallView
        toolCallId="m3"
        toolName="mcp__weird"
        args={{ query: "something odd" }}
        status="done"
        isError={false}
        result={{ content: [{ type: "text", text: "mcp__weird requires a `tool` parameter" }] }}
      />,
    );
    expect(rowParts(row())).toMatchObject({
      icon: "wrench",
      verb: "mcp__weird",
      target: "something odd", // the generic label
    });
    await expand();
    expect(screen.getByText("Arguments")).toBeInTheDocument();
    expect(screen.getByText("mcp__weird requires a `tool` parameter")).toBeInTheDocument();
  });

  it("unknown direct MCP tool renders with the generic renderer", async () => {
    render(
      <ToolCallView
        toolCallId="m4"
        toolName="figma_get_node"
        args={{ nodeId: "1:2" }}
        status="done"
        isError={false}
        result={{
          content: [{ type: "text", text: "node data" }],
          details: { server: "figma", tool: "get_node" },
        }}
      />,
    );
    await expand();
    await showArguments();
    expect(screen.getByText(/"nodeId": "1:2"/)).toBeInTheDocument();
    expect(screen.getByText("node data")).toBeInTheDocument();
  });
});
