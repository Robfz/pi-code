import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { hydratedStore, renderWithStore } from "@/test/render";
import { UserMessageView } from "./user-message";

describe("UserMessageView", () => {
  it("renders leading file blocks as collapsed chips above the typed text", async () => {
    const content = [
      {
        type: "text" as const,
        text: '<file name="/repo/src/a.ts">\nconst a = 1;\n</file>\n<file name="b.md">\n# B\n</file>\nreview these',
      },
      { type: "image" as const, data: "iVBORw==", mimeType: "image/png" },
    ];
    await renderWithStore(<UserMessageView message={{ content }} />, hydratedStore());
    const chips = screen.getAllByTestId("file-attachment");
    expect(chips.map((c) => c.querySelector("summary")?.textContent)).toEqual(["a.ts", "b.md"]);
    expect(chips.every((c) => !(c as HTMLDetailsElement).open)).toBe(true);
    expect(screen.getByText("review these")).toBeInTheDocument();
    expect(screen.getByRole("img")).toBeInTheDocument();

    await userEvent.setup().click(within(chips[0] as HTMLElement).getByText("a.ts"));
    expect((chips[0] as HTMLDetailsElement).open).toBe(true);
    expect(within(chips[0] as HTMLElement).getByText("const a = 1;")).toBeInTheDocument();
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
