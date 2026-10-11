import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { hydratedStore, renderWithStore } from "@/test/render";
import { UserMessageView } from "./user-message";

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
});
