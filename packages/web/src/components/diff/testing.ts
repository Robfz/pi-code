/**
 * Test helpers for the diff viewer. jsdom has no canvas; `@git-diff-view/react` measures line
 * number widths with one, so tests that render diffs install a minimal 2D context.
 */

export function stubCanvas(): void {
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: "",
    measureText: (text: string) => ({ width: text.length * 7 }),
  })) as unknown as HTMLCanvasElement["getContext"];
}

/**
 * The first `DiffViewer` under `root`, once its lazily loaded view has rendered.
 */
export async function loadedDiff(root: HTMLElement = document.body): Promise<HTMLElement> {
  const { waitFor } = await import("@testing-library/react");
  return waitFor(
    () => {
      const viewer = root.querySelector<HTMLElement>('[data-testid="diff-viewer"]');
      if (!viewer?.querySelector('[data-component="git-diff-view"]')) {
        throw new Error("diff view not rendered yet");
      }
      return viewer;
    },
    { timeout: 3000 },
  );
}
