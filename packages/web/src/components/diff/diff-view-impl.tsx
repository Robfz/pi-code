/**
 * The `@git-diff-view/react` view itself, in its own chunk: the library and its highlighter
 * (highlight.js via lowlight) are loaded on first use by `DiffViewer`.
 */

import "@git-diff-view/react/styles/diff-view-pure.css";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";

export interface DiffViewImplProps {
  oldName: string | null;
  newName: string | null;
  hunks: string[];
  wide: boolean;
  dark: boolean;
}

export default function DiffViewImpl({ oldName, newName, hunks, wide, dark }: DiffViewImplProps) {
  return (
    <DiffView
      data={{ oldFile: { fileName: oldName }, newFile: { fileName: newName }, hunks }}
      diffViewMode={wide ? DiffModeEnum.Split : DiffModeEnum.Unified}
      diffViewTheme={dark ? "dark" : "light"}
      diffViewWrap={!wide}
      diffViewFontSize={12}
      diffViewHighlight
    />
  );
}
