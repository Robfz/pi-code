import { initialLiveState, type LiveState } from "@pi-code/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Step } from "@/store/turns";
import { useUiPrefs } from "@/store/ui-prefs";
import { hydratedStore, renderWithStore } from "@/test/render";
import { fixtureToolCall, rowBody, rowParts } from "@/tools/testing";
import { ExplorationGroupRow } from "./exploration-group";
import type { ExplorationGroup } from "./grouping";
import { ToolCallSlot } from "./tool-call-slot";

type ToolStep = Extract<Step, { kind: "tool" }>;

const tool = (id: string, toolName: string, args: unknown): ToolStep => ({
  kind: "tool",
  key: id,
  toolCallId: id,
  toolName,
  args,
});

async function renderGroup(steps: ToolStep[], live: Partial<LiveState> = {}) {
  const group: ExplorationGroup = { kind: "group", key: steps[0]?.key ?? "", steps };
  await renderWithStore(
    <ExplorationGroupRow group={group}>
      {steps.map((step) => (
        <ToolCallSlot
          key={step.key}
          toolCallId={step.toolCallId}
          toolName={step.toolName}
          args={step.args}
        />
      ))}
    </ExplorationGroupRow>,
    hydratedStore({ live: { ...initialLiveState(), ...live } }),
  );
  return screen.getByTestId("exploration-group");
}

const reads = [
  tool("r1", "read", { path: "src/bar.ts" }),
  tool("r2", "read", { path: "src/foo.ts" }),
  tool("g1", "grep", { pattern: "TODO" }),
];

beforeEach(() => {
  useUiPrefs.setState({ density: "balanced" });
});

describe("ExplorationGroupRow", () => {
  it("reads 'Exploring · Reading foo.ts' with shimmer while a child runs", async () => {
    const group = await renderGroup(reads, {
      run: { active: true },
      tools: {
        r1: { toolName: "read", args: { path: "src/bar.ts" }, status: "done" },
        r2: { toolName: "read", args: { path: "src/foo.ts" }, status: "running" },
      },
    });
    expect(rowParts(group)).toMatchObject({
      icon: "telescope",
      verb: "Exploring · Reading foo.ts",
      shimmer: true,
    });
    expect(group).toHaveAttribute("data-status", "running");
  });

  it("reads 'Explored' with the counts once done, the children in its body", async () => {
    const group = await renderGroup(reads);
    expect(rowParts(group)).toMatchObject({
      icon: "telescope",
      verb: "Explored",
      meta: "2 files, 1 search",
      shimmer: false,
    });
    expect(within(group).queryAllByTestId("tool-call")).toHaveLength(0);
    const trigger = within(group).getAllByRole("button")[0] as HTMLElement;
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const children = within(rowBody(group)).getAllByTestId("tool-call");
    expect(children.map((row) => rowParts(row).verb)).toEqual(["Read", "Read", "Searched"]);
  });

  it("shows a child's Review button under the collapsed group (web-search)", async () => {
    const search = fixtureToolCall("web-search", "web_search");
    const url = "https://mac.tailnet.ts.net:8443/?session=tok";
    const group = await renderGroup(
      [tool(search.toolCallId, "web_search", search.args), tool("r1", "read", { path: "a.ts" })],
      { curator: { [search.toolCallId]: url } },
    );
    expect(rowParts(group).meta).toBe("1 file, 1 web search");
    expect(within(group).getByRole("link", { name: /Review in curator/ })).toHaveAttribute(
      "href",
      url,
    );
    // Expanded, the button sits under the child's own (collapsed) row instead.
    await userEvent.setup().click(within(group).getAllByRole("button")[0] as HTMLElement);
    const child = within(rowBody(group)).getAllByTestId("tool-call")[0] as HTMLElement;
    expect(within(child).getByRole("link", { name: /Review in curator/ })).toBeInTheDocument();
    expect(within(group).getAllByRole("link", { name: /Review in curator/ })).toHaveLength(1);
  });
});
