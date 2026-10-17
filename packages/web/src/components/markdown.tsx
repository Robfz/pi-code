import type { Element, Root } from "hast";
import { ImageIcon, ImageOffIcon } from "lucide-react";
import {
  type ComponentProps,
  cloneElement,
  isValidElement,
  memo,
  useContext,
  useMemo,
  useState,
} from "react";
import {
  type Components,
  type ControlsConfig,
  defaultRehypePlugins,
  parseMarkdownIntoBlocks,
  Streamdown,
  StreamdownContext,
  type StreamdownProps,
  useIsCodeFenceIncomplete,
} from "streamdown";
import { lazyCodePlugin, PLAIN_THEMES } from "@/lib/code-highlighter";
import { rehypeCodeRefs } from "@/lib/code-refs-rehype";
import { cn } from "@/lib/utils";

/** How an image URL from untrusted markdown may be shown. */
export type ImagePolicy =
  | { kind: "inline" }
  | { kind: "click"; host: string }
  | { kind: "blocked"; reason: string };

/**
 * Images in markdown come from untrusted text (model output, fetched pages, extension
 * messages), and loading one leaks the viewer's IP and timing to its host. Inline `data:image/`
 * URLs render right away; `https:` images load only when tapped; anything else never loads.
 */
export function imagePolicy(src: unknown): ImagePolicy {
  if (typeof src !== "string" || src.trim() === "") return { kind: "blocked", reason: "no URL" };
  if (/^data:image\//i.test(src.trim())) return { kind: "inline" };
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return { kind: "blocked", reason: "invalid URL" };
  }
  if (url.protocol === "https:") return { kind: "click", host: url.host };
  return { kind: "blocked", reason: `${url.protocol.replace(/:$/, "")} not allowed` };
}

/** Click-to-load image (markdown `![]()` and raw HTML `<img>` both land here). */
function MarkdownImage({ src, alt }: Pick<ComponentProps<"img">, "src" | "alt">) {
  const [loaded, setLoaded] = useState(false);
  const policy = imagePolicy(src);
  const label = alt?.trim() || "Image";
  if (policy.kind === "inline" || (policy.kind === "click" && loaded)) {
    return (
      <img
        src={src as string}
        alt={alt ?? ""}
        referrerPolicy="no-referrer"
        className="inline-block max-h-96 max-w-full rounded-md border object-contain"
      />
    );
  }
  if (policy.kind === "blocked") {
    return (
      <span
        data-testid="markdown-image-blocked"
        title={policy.reason}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed px-2 py-1 align-middle text-xs text-muted-foreground"
      >
        <ImageOffIcon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="markdown-image-placeholder"
      aria-label={`Load image “${label}” from ${policy.host}`}
      onClick={(event) => {
        // Inside a link, load the image instead of following it.
        event.preventDefault();
        event.stopPropagation();
        setLoaded(true);
      }}
      className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-dashed px-2 py-1 align-middle text-xs text-muted-foreground hover:bg-muted/60"
    >
      <ImageIcon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
      <span className="shrink-0 opacity-70">· {policy.host} · tap to load</span>
    </button>
  );
}

/**
 * Streamdown's `pre` (it marks its `code` child as a block), showing a code fence still streaming
 * unhighlighted (`PLAIN_THEMES`): Shiki would tokenise the growing block again on every delta. The
 * block highlights once its fence closes or the message finishes. The provider stays in place
 * either way, so the block isn't remounted when it switches.
 */
function CodeBlockPre({ children }: ComponentProps<"pre">) {
  const context = useContext(StreamdownContext);
  const incomplete = useIsCodeFenceIncomplete();
  const plain = useMemo(() => ({ ...context, shikiTheme: PLAIN_THEMES }), [context]);
  return (
    <StreamdownContext.Provider value={incomplete ? plain : context}>
      {isValidElement<Record<string, unknown>>(children)
        ? cloneElement(children, { "data-block": "true" })
        : children}
    </StreamdownContext.Provider>
  );
}

const COMPONENTS: Components = {
  img: MarkdownImage as Components["img"],
  pre: CodeBlockPre as Components["pre"],
};

/**
 * A line starting a link reference or footnote definition (`[1]: https://…`, `[^1]: …`), inside
 * blockquotes and list items too. A false match (in a code block, say) only costs keeping the text
 * whole.
 */
const DEFINITION = /^(?:[ \t]*(?:>|[-+*][ \t]|\d{1,9}[.)][ \t]))*[ \t]*\[[^\]]+\]:/m;

/**
 * Streamdown's split into separately rendered blocks, keeping a finished text with link reference
 * or footnote definitions whole: a reference resolves only against the definitions in its own
 * block. Streaming text stays split (its references show as written until it finishes), so a
 * definition doesn't turn every later delta into a parse of the whole text.
 */
function parseFinishedBlocks(markdown: string): string[] {
  return DEFINITION.test(markdown) ? [markdown] : parseMarkdownIntoBlocks(markdown);
}

type RehypePlugins = NonNullable<StreamdownProps["rehypePlugins"]>;
interface SanitizeSchema {
  tagNames?: string[];
  protocols?: Record<string, string[]>;
}

/**
 * Streamdown's pipeline (raw HTML → sanitize → harden) with a stricter sanitize schema. GitHub's
 * schema lets through two resource-loading elements: `<img>` (rendered by `MarkdownImage`, so
 * nothing loads without a tap; `data:` sources are allowed through for inline images) and
 * `<picture><source srcset>` (dropped here; its fallback `<img>` stays).
 */
function rehypePlugins(): RehypePlugins {
  const { raw, sanitize, harden } = defaultRehypePlugins;
  const [plugin, schema] = sanitize as unknown as [RehypePlugins[number], SanitizeSchema];
  const strict: SanitizeSchema = {
    ...schema,
    tagNames: (schema.tagNames ?? []).filter((tag) => tag !== "picture" && tag !== "source"),
    protocols: { ...schema.protocols, src: [...(schema.protocols?.src ?? []), "data"] },
  };
  return [raw, [plugin, strict], harden] as RehypePlugins;
}

/** Streamdown merges an element's classes into its own, so links take these over its defaults. */
const LINK_CLASS = [
  "font-normal",
  "text-link",
  "no-underline",
  "underline-offset-3",
  "hover:underline",
];

function addLinkClass(node: Root | Element) {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.tagName === "a") child.properties.className = LINK_CLASS;
    addLinkClass(child);
  }
}

function rehypeLinks() {
  return (tree: Root) => addLinkClass(tree);
}

const REHYPE_PLUGINS: RehypePlugins = [...rehypePlugins(), rehypeLinks];
const REHYPE_PLUGINS_WITH_CODE_REFS: RehypePlugins = [...REHYPE_PLUGINS, rehypeCodeRefs];

const PLUGINS = { code: lazyCodePlugin };

/** Code blocks show their language and a copy button, not Streamdown's download button. */
const CONTROLS: ControlsConfig = { code: { copy: true, download: false } };

/**
 * Markdown via Streamdown; `streaming` enables incomplete-markdown handling for live text.
 * Single newlines inside a paragraph render as line breaks (`pre-line`), like pi's TUI.
 * Code blocks are highlighted by Shiki (`lazyCodePlugin`, languages loaded on demand); their
 * chrome and the prose styles live in `index.css` (`.markdown`).
 * `codeRefs` marks line references as `span[data-code-ref]` (`rehypeCodeRefs`); the caller
 * handles their clicks.
 *
 * Text that mounts streaming keeps Streamdown's streaming mode once it finishes: static mode
 * renders it as one tree, so switching would replace its DOM and highlight its code blocks again.
 * Streaming mode renders it block by block, and only the blocks that change re-render, as long as
 * the rehype plugins stay the same (a caller keeps `codeRefs` fixed). A finished text with
 * definitions is the exception: it becomes one block (`parseFinishedBlocks`), rendered again once.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  codeRefs = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  codeRefs?: boolean;
  className?: string;
}) {
  const [mode] = useState<StreamdownProps["mode"]>(streaming ? "streaming" : "static");
  return (
    <Streamdown
      className={cn(
        "markdown min-w-0 space-y-[0.8em] break-words text-prose [&_p]:whitespace-pre-line",
        className,
      )}
      mode={mode}
      isAnimating={streaming}
      parseIncompleteMarkdown={streaming}
      parseMarkdownIntoBlocksFn={streaming ? parseMarkdownIntoBlocks : parseFinishedBlocks}
      components={COMPONENTS}
      rehypePlugins={codeRefs ? REHYPE_PLUGINS_WITH_CODE_REFS : REHYPE_PLUGINS}
      plugins={PLUGINS}
      controls={CONTROLS}
      lineNumbers={false}
    >
      {text}
    </Streamdown>
  );
});
