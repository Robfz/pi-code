import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WrenchIcon } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { useUiPrefs } from "@/store/ui-prefs";
import { genericToolRenderer } from "./generic";
import { getToolRenderer, registerToolRenderer, type ToolRendererProps } from "./index";
import { rowBody, rowParts } from "./testing";
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
    const label = () => ({ icon: WrenchIcon, verb: "Custom" });
    const custom = { label, Body: () => <p>custom body</p> };
    registerToolRenderer("custom_tool", custom);
    expect(getToolRenderer("custom_tool")).toBe(custom);
    const mcp = { label, Body: () => <p>mcp</p> };
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
    expect(rowParts(screen.getByTestId("tool-call"))).toMatchObject({
      icon: "wrench",
      verb: "mystery",
      shimmer: false,
      target: "find things", // the first string argument
      meta: undefined,
    });
    expect(screen.queryByText("3 things found")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("3 things found")).toBeInTheDocument();
    expect(screen.queryByText(/"limit": 3/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Arguments" }));
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
    expect(rowParts(screen.getByTestId("tool-call"))).toMatchObject({
      verb: "mystery",
      shimmer: true,
    });
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
    const row = screen.getByTestId("tool-call");
    expect(rowParts(row)).toMatchObject({
      icon: "circle-alert",
      verb: "mystery failed",
      meta: "Command aborted",
    });
    await userEvent.setup().click(screen.getByRole("button", { expanded: false }));
    expect(within(rowBody(row)).getByText("Command aborted")).toHaveClass("text-destructive");
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
