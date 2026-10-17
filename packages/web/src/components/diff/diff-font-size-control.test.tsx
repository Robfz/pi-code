import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useUiPrefs } from "@/store/ui-prefs";
import { DiffFontSizeControl } from "./diff-font-size-control";

beforeEach(() => useUiPrefs.setState({ diffFontSize: 12 }));

describe("DiffFontSizeControl", () => {
  it("steps through the sizes, disabled at either end", async () => {
    render(<DiffFontSizeControl />);
    const user = userEvent.setup();
    const smaller = screen.getByRole("button", { name: "Smaller diff text" });
    const larger = screen.getByRole("button", { name: "Larger diff text" });
    await user.click(smaller);
    expect(useUiPrefs.getState().diffFontSize).toBe(11);
    expect(smaller).toBeDisabled();
    for (const size of [12, 13, 14, 16]) {
      await user.click(larger);
      expect(useUiPrefs.getState().diffFontSize).toBe(size);
    }
    expect(larger).toBeDisabled();
    expect(screen.getByRole("group")).toHaveAccessibleName("Diff text size, 16px");
  });
});
