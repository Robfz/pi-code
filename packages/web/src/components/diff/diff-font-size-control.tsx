import { AArrowDownIcon, AArrowUpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DIFF_FONT_SIZES, useUiPrefs } from "@/store/ui-prefs";

/** Smaller / Larger buttons stepping the diff font size through `DIFF_FONT_SIZES`. */
export function DiffFontSizeControl() {
  const size = useUiPrefs((s) => s.diffFontSize);
  const setSize = useUiPrefs((s) => s.setDiffFontSize);
  const index = DIFF_FONT_SIZES.indexOf(size);
  const smaller = DIFF_FONT_SIZES[index - 1];
  const larger = DIFF_FONT_SIZES[index + 1];
  return (
    <fieldset aria-label={`Diff text size, ${size}px`} className="flex items-center">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Smaller diff text"
        title={`Smaller diff text (${size}px)`}
        disabled={smaller === undefined}
        onClick={() => smaller !== undefined && setSize(smaller)}
      >
        <AArrowDownIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Larger diff text"
        title={`Larger diff text (${size}px)`}
        disabled={larger === undefined}
        onClick={() => larger !== undefined && setSize(larger)}
      >
        <AArrowUpIcon />
      </Button>
    </fieldset>
  );
}
