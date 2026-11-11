import { formatFileBlock, formatPrBlock, formatPrGuideBlock } from "@pi-code/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { hydratedStore, renderWithStore } from "@/test/render";
import { UserMessageView } from "./user-message";

const skillBlock = (name: string) =>
  `<skill name="${name}" location="/skills/${name}/SKILL.md">\nReferences are relative to /skills/${name}.\n\n# Steps\nRead the diff.\n</skill>`;

describe("UserMessageView", () => {
  it("is a full-width box, not a right-aligned bubble", async () => {
    await renderWithStore(<UserMessageView message={{ content: "hello" }} />, hydratedStore());
    const box = screen.getByTestId("user-message");
    expect(box).toHaveClass("w-full", "bg-user-message", "border", "rounded-[10px]", "text-prose");
    expect(box).not.toHaveClass("ml-auto");
    expect(box.className).not.toMatch(/max-w-/);
    expect(box).not.toHaveClass("opacity-70");
  });

  it("shows a pending message at 70% opacity", async () => {
    await renderWithStore(
      <UserMessageView message={{ content: "on its way" }} pending />,
      hydratedStore(),
    );
    expect(screen.getByTestId("user-message")).toHaveClass("opacity-70");
  });

  it("renders leading file blocks as collapsed rows above the typed text", async () => {
    const content = [
      {
        type: "text" as const,
        text: '<file name="/repo/src/a.ts">\nconst a = 1;\n</file>\n<file name="b.md">\n# B\n</file>\nreview these',
      },
      { type: "image" as const, data: "iVBORw==", mimeType: "image/png" },
    ];
    await renderWithStore(<UserMessageView message={{ content }} />, hydratedStore());
    const box = screen.getByTestId("user-message");
    const rows = within(box).getAllByTestId("file-attachment");
    const triggers = rows.map((row) => within(row).getByRole("button"));
    expect(triggers.map((t) => t.textContent)).toEqual(["a.ts", "b.md"]);
    expect(triggers.every((t) => t.getAttribute("aria-expanded") === "false")).toBe(true);
    expect(screen.queryByText("const a = 1;")).toBeNull();
    expect(within(box).getByText("review these")).toBeInTheDocument();
    expect(within(box).getByRole("img")).toBeInTheDocument();

    await userEvent.setup().click(triggers[0] as HTMLElement);
    expect(triggers[0]).toHaveAttribute("aria-expanded", "true");
    expect(within(rows[0] as HTMLElement).getByText("const a = 1;")).toBeInTheDocument();
  });

  it("renders plain text as is", async () => {
    await renderWithStore(
      <UserMessageView message={{ content: "see <file> later" }} />,
      hydratedStore(),
    );
    expect(screen.queryByTestId("file-attachment")).toBeNull();
    expect(screen.getByText("see <file> later")).toBeInTheDocument();
  });

  it("renders a leading PR block as a card that expands to the PR context", async () => {
    const block = formatPrBlock({
      number: 12,
      title: "Speed up the parser",
      state: "merged",
      url: "https://github.com/o/r/pull/12",
      update: false,
      text: "Pull request o/r#12: Speed up the parser\nBase: main @ abc",
    });
    await renderWithStore(
      <UserMessageView message={{ content: `${block}Give me an overview` }} />,
      hydratedStore(),
    );
    const card = screen.getByTestId("pr-card");
    const trigger = within(card).getByRole("button");
    expect(trigger).toHaveTextContent("#12Speed up the parsermerged");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Base: main/)).toBeNull();
    expect(screen.getByText("Give me an overview")).toBeInTheDocument();
    await userEvent.setup().click(trigger);
    expect(within(card).getByText(/Base: main @ abc/)).toBeInTheDocument();
  });

  it("marks a PR update", async () => {
    const block = formatPrBlock({
      number: 12,
      title: "Speed up the parser",
      state: "open",
      url: "https://github.com/o/r/pull/12",
      update: true,
      text: "updated",
    });
    await renderWithStore(<UserMessageView message={{ content: block }} />, hydratedStore());
    expect(screen.getByTestId("pr-card")).toHaveTextContent("updated · open");
  });

  it("renders a leading PR guide block as a card that expands to the guide", async () => {
    const block = formatPrGuideBlock({
      number: 12,
      title: "Speed up the parser",
      url: "https://github.com/o/r/pull/12",
      text: "Review guide for pull request o/r#12: Speed up the parser\n1. Core change",
    });
    await renderWithStore(
      <UserMessageView message={{ content: `${block}Use it as a map` }} />,
      hydratedStore(),
    );
    const card = screen.getByTestId("pr-guide-card");
    const trigger = within(card).getByRole("button");
    expect(trigger).toHaveTextContent("Review guide ·#12Speed up the parser");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Core change/)).toBeNull();
    expect(screen.queryByText(/<pr-guide/)).toBeNull();
    expect(screen.getByText("Use it as a map")).toBeInTheDocument();
    await userEvent.setup().click(trigger);
    expect(within(card).getByText(/1\. Core change/)).toBeInTheDocument();
  });

  it("renders an expanded skill as a collapsed card, its args as the text", async () => {
    await renderWithStore(
      <UserMessageView message={{ content: `${skillBlock("review")}\n\nfocus on tests` }} />,
      hydratedStore(),
    );
    const card = screen.getByTestId("skill-invocation");
    const trigger = within(card).getByRole("button");
    expect(trigger).toHaveTextContent("/skill:review");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(card.querySelector(".text-ultraspawn")).toBeNull();
    expect(screen.queryByText("Read the diff.")).toBeNull();
    expect(screen.queryByText(/<skill/)).toBeNull();
    expect(screen.getByText("focus on tests")).toBeInTheDocument();

    await userEvent.setup().click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(await within(card).findByText("Read the diff.")).toBeInTheDocument();
  });

  it("colors ultraspawn's skill like ultraspawn tool rows", async () => {
    await renderWithStore(
      <UserMessageView message={{ content: skillBlock("ultraspawn") }} />,
      hydratedStore(),
    );
    const card = screen.getByTestId("skill-invocation");
    expect(within(card).getByText("/skill:ultraspawn")).toHaveClass("text-ultraspawn");
    expect(card.querySelector("svg.lucide-bot")).toHaveClass("text-ultraspawn");
  });

  it("shows an expanded skill above its attached files", async () => {
    const file = formatFileBlock({ name: "/repo/a.ts", text: "const a = 1;" });
    await renderWithStore(
      <UserMessageView message={{ content: `${skillBlock("review")}\n\n${file}check a.ts` }} />,
      hydratedStore(),
    );
    const skill = screen.getByTestId("skill-invocation");
    const row = screen.getByTestId("file-attachment");
    expect(within(row).getByRole("button")).toHaveTextContent("a.ts");
    expect(skill.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("check a.ts")).toBeInTheDocument();
  });
});
