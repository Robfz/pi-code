import { ImageIcon, ImageOffIcon } from "lucide-react";
import { type ComponentProps, memo, useState } from "react";
import {
  type Components,
  defaultRehypePlugins,
  Streamdown,
  type StreamdownProps,
} from "streamdown";
import { lazyCodePlugin } from "@/lib/code-highlighter";
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

const COMPONENTS: Components = { img: MarkdownImage as Components["img"] };

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

const REHYPE_PLUGINS = rehypePlugins();
const REHYPE_PLUGINS_WITH_CODE_REFS: RehypePlugins = [...REHYPE_PLUGINS, rehypeCodeRefs];

const PLUGINS = { code: lazyCodePlugin };

/**
 * Markdown via Streamdown; `streaming` enables incomplete-markdown handling for live text.
 * Single newlines inside a paragraph render as line breaks (`pre-line`), like pi's TUI.
 * Code blocks are highlighted by `@streamdown/code` (Shiki, languages loaded on demand).
 * `codeRefs` marks line references as `span[data-code-ref]` (`rehypeCodeRefs`); the caller
 * handles their clicks.
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
  return (
    <Streamdown
      className={cn(
        "markdown min-w-0 break-words text-sm leading-relaxed [&_p]:whitespace-pre-line",
        className,
      )}
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      parseIncompleteMarkdown={streaming}
      components={COMPONENTS}
      rehypePlugins={codeRefs ? REHYPE_PLUGINS_WITH_CODE_REFS : REHYPE_PLUGINS}
      plugins={PLUGINS}
    >
      {text}
    </Streamdown>
  );
});
