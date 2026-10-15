import type { RpcSessionState } from "@pi-code/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { stubMatchMedia } from "@/test/dom-stubs";
import { makeAgent } from "@/test/fixtures";
import { type FetchCall, hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { ActionSheets } from "./action-sheets";
import { useConversationUi } from "./conversation-ui";
import { ModelPicker, pickerLabel, thinkingLabel } from "./model-picker";

type Model = NonNullable<RpcSessionState["model"]>;

function model(provider: string, id: string, patch: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider,
    baseUrl: "",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...patch,
  } as Model;
}

const sonnet = model("anthropic", "claude-sonnet-4-5", { name: "Sonnet 4.5" });
const opus = model("anthropic", "claude-opus-4-1", { name: "Opus 4.1" });
const gpt = model("openai", "gpt-5", { name: "GPT-5" });
const plain = model("openai", "gpt-4o", { name: "GPT-4o", reasoning: false });

function state(patch: Partial<RpcSessionState> = {}): RpcSessionState {
  return {
    model: sonnet,
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    sessionId: "s1",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
    ...patch,
  };
}

const rpcBodies = (calls: FetchCall[]) =>
  calls.filter((c) => c.url === "/api/agents/a1/rpc").map((c) => c.body);

/** Answers the picker's queries; other commands succeed with no data. */
function stubRpc() {
  return stubFetch((call) => {
    if (call.url !== "/api/agents/a1/rpc") return undefined;
    const type = (call.body as { type: string }).type;
    if (type === "get_available_models") {
      return [200, { data: { models: [sonnet, gpt, opus, plain] } }];
    }
    if (type === "get_available_thinking_levels") {
      return [200, { data: { levels: ["off", "low", "medium", "high"] } }];
    }
    if (type === "set_model") return [200, { data: gpt }];
    return [200, {}];
  });
}

beforeEach(() => {
  useConversationUi.getState().reset();
  // cmdk scrolls to the selected item; jsdom lacks scrollIntoView.
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

describe("label", () => {
  it("is the name and level, 'No thinking' for off, the name alone without reasoning", () => {
    expect(pickerLabel(sonnet, "high")).toEqual({ name: "Sonnet 4.5", level: "High" });
    expect(pickerLabel(sonnet, "off")).toEqual({ name: "Sonnet 4.5", level: "No thinking" });
    expect(pickerLabel(plain, "off")).toEqual({ name: "GPT-4o" });
    expect(pickerLabel(undefined, "high")).toEqual({ name: "Select model" });
    expect(thinkingLabel("xhigh")).toBe("XHigh");
    expect(thinkingLabel("minimal")).toBe("Minimal");
  });

  it.each([
    [state(), "Sonnet 4.5 · Medium"],
    [state({ thinkingLevel: "off" }), "Sonnet 4.5 · No thinking"],
    [state({ model: plain, thinkingLevel: "off" }), "GPT-4o"],
  ])("renders the button's label", async (s, label) => {
    stubRpc();
    await renderWithStore(<ModelPicker />, hydratedStore({ state: s }));
    const button = screen.getByRole("button", { name: label });
    expect(button).toHaveTextContent(label.replace(" · ", "·"));
    expect(button).toBeEnabled();
  });

  it("is disabled until pi is ready", async () => {
    stubRpc();
    await renderWithStore(
      <ModelPicker />,
      hydratedStore({ agent: makeAgent({ status: "starting" }), state: state() }),
    );
    expect(screen.getByRole("button", { name: "Sonnet 4.5 · Medium" })).toBeDisabled();
  });
});

describe("desktop", () => {
  beforeEach(() => stubMatchMedia((query) => query === DESKTOP_QUERY));

  async function open(s = state()) {
    const { calls } = stubRpc();
    await renderWithStore(<ModelPicker />, hydratedStore({ state: s }));
    const user = userEvent.setup();
    const label = s.model?.reasoning ? "Sonnet 4.5 · Medium" : (s.model?.name ?? "");
    await user.click(screen.getByRole("button", { name: label }));
    const popover = await screen.findByTestId("model-picker");
    await within(popover).findByRole("option", { name: "GPT-5" });
    return { calls, user, popover };
  }

  it("lists the models by provider with the current one checked", async () => {
    const { popover } = await open();
    const names = (provider: string) =>
      within(within(popover).getByRole("group", { name: provider }))
        .getAllByRole("option")
        .map((o) => o.textContent);
    expect(names("anthropic")).toEqual(["Sonnet 4.5", "Opus 4.1"]);
    expect(names("openai")).toEqual(["GPT-5", "GPT-4o"]);
    expect(within(popover).getByRole("option", { name: "Sonnet 4.5" })).toHaveAttribute(
      "data-checked",
      "true",
    );
    expect(within(popover).getByRole("option", { name: "Opus 4.1" })).toHaveAttribute(
      "data-checked",
      "false",
    );
  });

  it("searches the models", async () => {
    const { user, popover } = await open();
    const search = within(popover).getByRole("combobox", { name: "Search models" });
    expect(search).toHaveFocus();
    await user.type(search, "gpt");
    await waitFor(() =>
      expect(within(popover).queryByRole("option", { name: "Opus 4.1" })).toBeNull(),
    );
    expect(within(popover).queryByRole("group", { name: "anthropic" })).toBeNull();
    expect(within(popover).getByRole("option", { name: "GPT-5" })).toBeInTheDocument();
  });

  it("choosing a model sends set_model and closes", async () => {
    const { calls, user, popover } = await open();
    await user.click(within(popover).getByRole("option", { name: "GPT-5" }));
    await waitFor(() =>
      expect(rpcBodies(calls)).toContainEqual({
        type: "set_model",
        provider: "openai",
        modelId: "gpt-5",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("model-picker")).toBeNull());
  });

  it("the thinking control sends set_thinking_level and keeps the popover open", async () => {
    const { calls, user, popover } = await open();
    const control = within(popover).getByRole("group", { name: "Thinking level" });
    const levels = await within(control).findAllByRole("button");
    expect(levels.map((b) => b.textContent)).toEqual(["off", "low", "medium", "high"]);
    expect(within(control).getByRole("button", { name: "medium" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(control).getByRole("button", { name: "high" }));
    await waitFor(() =>
      expect(rpcBodies(calls)).toContainEqual({ type: "set_thinking_level", level: "high" }),
    );
    expect(screen.getByTestId("model-picker")).toBeInTheDocument();
  });

  it("has no thinking control for a model without reasoning", async () => {
    const { calls, popover } = await open(state({ model: plain, thinkingLevel: "off" }));
    expect(within(popover).queryByRole("group", { name: "Thinking level" })).toBeNull();
    expect(rpcBodies(calls)).not.toContainEqual({ type: "get_available_thinking_levels" });
  });

  it("Escape closes", async () => {
    const { user } = await open();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("model-picker")).toBeNull());
  });
});

describe("phone", () => {
  it("opens the model sheet, with the thinking control at its bottom", async () => {
    const { calls } = stubRpc();
    await renderWithStore(
      <>
        <ModelPicker />
        <ActionSheets />
      </>,
      hydratedStore({ state: state() }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sonnet 4.5 · Medium" }));
    expect(screen.queryByTestId("model-picker")).toBeNull();
    const sheet = await screen.findByTestId("model-sheet");
    const control = within(sheet).getByRole("group", { name: "Thinking level" });
    await user.click(await within(control).findByRole("button", { name: "low" }));
    await waitFor(() =>
      expect(rpcBodies(calls)).toContainEqual({ type: "set_thinking_level", level: "low" }),
    );
    expect(screen.getByTestId("model-sheet")).toBeInTheDocument();
  });

  it("the model sheet has no thinking control without reasoning", async () => {
    stubRpc();
    await renderWithStore(
      <>
        <ModelPicker />
        <ActionSheets />
      </>,
      hydratedStore({ state: state({ model: plain, thinkingLevel: "off" }) }),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "GPT-4o" }));
    const sheet = await screen.findByTestId("model-sheet");
    await within(sheet).findByRole("option", { name: /gpt-5/ });
    expect(within(sheet).queryByRole("group", { name: "Thinking level" })).toBeNull();
  });

  it("the model sheet groups models by provider, filters them and calls set_model", async () => {
    const { calls } = stubRpc();
    await renderWithStore(
      <>
        <ModelPicker />
        <ActionSheets />
      </>,
      hydratedStore({ state: state() }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sonnet 4.5 · Medium" }));
    const sheet = await screen.findByTestId("model-sheet");
    const anthropic = await within(sheet).findByRole("region", { name: "anthropic" });
    expect(
      within(anthropic)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["claude-sonnet-4-5Sonnet 4.5img", "claude-opus-4-1Opus 4.1img"]);
    expect(within(anthropic).getByRole("option", { name: /claude-sonnet-4-5/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.type(within(sheet).getByLabelText("Filter models"), "gpt-5");
    expect(within(sheet).queryByRole("region", { name: "anthropic" })).toBeNull();
    const openai = within(sheet).getByRole("region", { name: "openai" });
    await user.click(within(openai).getByRole("option", { name: /gpt-5/ }));
    await waitFor(() =>
      expect(rpcBodies(calls)).toContainEqual({
        type: "set_model",
        provider: "openai",
        modelId: "gpt-5",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("model-sheet")).toBeNull());
  });
});

describe("thinking sheet", () => {
  it("lists get_available_thinking_levels and calls set_thinking_level", async () => {
    const { calls } = stubRpc();
    await renderWithStore(<ActionSheets />, hydratedStore({ state: state() }));
    act(() => useConversationUi.getState().openSheet("a1", "thinking"));
    const sheet = await screen.findByTestId("thinking-sheet");
    const options = await within(sheet).findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["off", "low", "medium", "high"]);
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    await userEvent.setup().click(options[3] as HTMLElement);
    await waitFor(() =>
      expect(rpcBodies(calls)).toContainEqual({ type: "set_thinking_level", level: "high" }),
    );
  });
});
