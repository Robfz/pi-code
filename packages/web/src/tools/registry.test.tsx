import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { useUiPrefs } from "@/store/ui-prefs";
import { genericToolRenderer } from "./generic";
import { getToolRenderer, registerToolRenderer, type ToolRendererProps } from "./index";
import { ToolCallView } from "./tool-call-view";

const base: Omit<ToolRendererProps, "expanded" | "status" | "isError"> = {
  toolCallId: "t1",
  toolName: "mystery",
  args: { query: "find things", limit: 3 },
};

afterEach(() => {
  useUiPrefs.setState({ toolsExpanded: false });
});

describe("tool renderers", () => {
  it("falls back to the generic renderer and honours registrations", () => {
    expect(getToolRenderer("nope")).toBe(genericToolRenderer);
    const custom = { Body: () => <p>custom body</p> };
    registerToolRenderer("custom_tool", custom);
    expect(getToolRenderer("custom_tool")).toBe(custom);
    const mcp = { Body: () => <p>mcp</p> };
    registerToolRenderer((name) => name.startsWith("srv_"), mcp);
    expect(getToolRenderer("srv_list")).toBe(mcp);
  });

  it("generic: collapsed when done, expands to arguments and result", async () => {
    render(
      <ToolCallView
        {...base}
        status="done"
        isError={false}
        result={{ content: [{ type: "text", text: "3 things found" }] }}
      />,
    );
    expect(screen.getByText("mystery")).toBeInTheDocument();
    expect(screen.getByText("find things")).toBeInTheDocument(); // summary hint
    expect(screen.queryByText("3 things found")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("3 things found")).toBeInTheDocument();
    expect(screen.getByText("Arguments")).toBeInTheDocument();
    expect(screen.getByText(/"limit": 3/)).toBeInTheDocument();
  });

  it("generic: shows streaming partial output while running", () => {
    render(
      <ToolCallView
        {...base}
        status="running"
        isError={false}
        partialResult={{ content: [{ type: "text", text: "tick\ntock" }] }}
      />,
    );
    expect(screen.getByTestId("tool-call")).toHaveAttribute("data-status", "running");
    expect(screen.getByLabelText("Running")).toBeInTheDocument();
    expect(screen.getByText(/tick\s+tock/)).toBeInTheDocument();
  });

  it("generic: error state", async () => {
    render(
      <ToolCallView
        {...base}
        status="error"
        isError
        result={{ content: [{ type: "text", text: "Command aborted" }] }}
      />,
    );
    expect(screen.getByLabelText("Failed")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Command aborted")).toHaveClass("text-destructive");
  });

  it("the global toggle expands every tool", () => {
    useUiPrefs.setState({ toolsExpanded: true });
    render(
      <ToolCallView
        {...base}
        status="done"
        isError={false}
        result={{ content: [{ type: "text", text: "out" }] }}
      />,
    );
    expect(screen.getByText("out")).toBeInTheDocument();
  });
});
