import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileTextIcon } from "lucide-react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CollapsibleRow } from "./collapsible-row";

const tail = (root: HTMLElement) => root.querySelector('[data-slot="row-tail"]') as HTMLElement;

describe("CollapsibleRow", () => {
  it("toggles by click, Enter and Space, reflected in aria-expanded", async () => {
    const user = userEvent.setup();
    render(
      <CollapsibleRow icon={<FileTextIcon />} label="Read notes.txt">
        <p>the body</p>
      </CollapsibleRow>,
    );
    const trigger = screen.getByRole("button", { name: /Read notes\.txt/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("the body")).toBeNull();

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("the body")).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("the body")).toBeNull();

    await user.keyboard(" ");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("follows a controlled open state and reports toggles", async () => {
    const onOpenChange = vi.fn();
    function Controlled() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(false)}>
            close
          </button>
          <CollapsibleRow
            label="Row"
            open={open}
            onOpenChange={(next) => {
              onOpenChange(next);
              setOpen(next);
            }}
          >
            <p>the body</p>
          </CollapsibleRow>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Controlled />);
    const trigger = screen.getByRole("button", { name: "Row" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "close" }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the tail while open, else only on hover or focus", async () => {
    const { container } = render(
      <CollapsibleRow label="Row" tail="1.2s">
        <p>the body</p>
      </CollapsibleRow>,
    );
    expect(tail(container)).toHaveTextContent("1.2s");
    expect(tail(container)).toHaveClass("opacity-0", "group-hover/row:opacity-100");
    await userEvent.setup().click(screen.getByRole("button", { name: /Row/ }));
    expect(tail(container)).toHaveClass("opacity-100");
    expect(tail(container)).not.toHaveClass("opacity-0");
    expect(tail(container).querySelector("svg")).not.toBeNull(); // the chevron
  });

  it("a row without a body has no chevron and doesn't toggle", async () => {
    const { container } = render(
      <CollapsibleRow icon={<FileTextIcon />} label="Read" tail="3ms" />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("[aria-expanded]")).toBeNull();
    expect(tail(container)).toHaveTextContent("3ms");
    expect(tail(container).querySelector("svg")).toBeNull();
    await userEvent.setup().click(screen.getByText("Read"));
    expect(container.querySelector('[data-state="open"]')).toBeNull();
  });

  it("shows `collapsed` content only while collapsed", async () => {
    render(
      <CollapsibleRow label="Row" collapsed={<p>preview</p>}>
        <p>the body</p>
      </CollapsibleRow>,
    );
    expect(screen.getByText("preview")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Row" }));
    expect(screen.queryByText("preview")).toBeNull();
  });
});
