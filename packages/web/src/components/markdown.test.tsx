import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

describe("Markdown", () => {
  it("keeps single newlines inside a paragraph as line breaks (like pi's TUI)", () => {
    const { container } = render(<Markdown text={"1\n2\n3"} />);
    const root = container.querySelector(".markdown");
    expect(root?.className).toContain("[&_p]:whitespace-pre-line");
    const p = container.querySelector("p");
    expect(p?.textContent).toBe("1\n2\n3");
  });
});
