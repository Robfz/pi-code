/** Shared pieces for tool renderers: argument access, code blocks, notices, error output. */

import type { ImageContent } from "@pi-code/protocol";
import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { contentImages, imageSrc, toolResultText } from "@/lib/content";
import { asRecord, str } from "@/lib/record";
import { cn } from "@/lib/utils";
import { OutputBlock } from "./generic";
import type { ToolRendererProps } from "./registry";

export { asRecord, num, type Rec, str } from "@/lib/record";

export function strList(value: unknown, key: string): string[] {
  const v = asRecord(value)?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export { truncate } from "@/lib/content";

/** Tool arguments' file path (`path`, or `file_path` as some models send). */
export function argPath(args: unknown): string | undefined {
  return str(args, "path") ?? str(args, "file_path");
}

const LANGS: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonl: "json",
  md: "markdown",
  mdx: "mdx",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  vue: "vue",
  svelte: "svelte",
  lua: "lua",
  dockerfile: "docker",
};

/** Shiki language id for a file path, from its extension ("text" when unknown). */
export function langFromPath(path: string | undefined): string {
  if (!path) return "text";
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "dockerfile") return "docker";
  if (name === "makefile") return "make";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "text";
  return LANGS[name.slice(dot + 1)] ?? "text";
}

/** Highlighted code through Streamdown's code block. */
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  // A fence longer than any backtick run inside the code.
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return (
    <div className="max-h-96 overflow-auto" data-testid="code-block" data-lang={lang}>
      <Markdown text={`${fence}${lang}\n${code.replace(/\n$/, "")}\n${fence}`} />
    </div>
  );
}

/**
 * Split pi's trailing notice (`\n\n[Showing lines 1-50 of 200. …]`, `[100 matches limit
 * reached…]`) off a tool's text output.
 */
export function splitNotice(text: string): { body: string; notice?: string } {
  const match = /\n\n\[([^\n]*)\]\s*$/.exec(text);
  if (!match || match.index === undefined) return { body: text };
  return { body: text.slice(0, match.index), notice: match[1] };
}

export function Notice({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-muted-foreground", className)}>{children}</span>;
}

/** Error text of a failed call. */
export function ErrorOutput({ result }: Pick<ToolRendererProps, "result">) {
  const text = toolResultText(result);
  return <OutputBlock text={text || "Failed (no output)"} error />;
}

export function resultImages(result: unknown): ImageContent[] {
  const content = asRecord(result)?.content;
  return Array.isArray(content) ? contentImages(content as ImageContent[]) : [];
}

export function Images({ images }: { images: ImageContent[] }) {
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((image, i) => (
        <img
          // biome-ignore lint/suspicious/noArrayIndexKey: images of one result, in order
          key={i}
          src={imageSrc(image)}
          alt=""
          className="max-h-64 max-w-full rounded-md border object-contain"
        />
      ))}
    </div>
  );
}

/** "Running…" placeholder while there's nothing else to show. */
export function Pending({ label = "Running…" }: { label?: string }) {
  return <p className="text-xs text-muted-foreground">{label}</p>;
}

/** Whether the call is still going (arguments streaming or executing). */
export function isActive(status: ToolRendererProps["status"]): boolean {
  return status === "running" || status === "streaming";
}

/** An `http(s)://` URL: the only kind tool / extension data may turn into a link. */
export function isWebUrl(url: string | undefined): url is string {
  return url !== undefined && /^https?:\/\//i.test(url);
}

/**
 * External link that opens in a new tab. `href` comes from tool or extension data, so anything
 * but an `http(s)://` URL (`javascript:`, `data:`, relative paths, …) stays plain text.
 */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  if (!isWebUrl(href)) return <span className="break-all">{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all text-link underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

/**
 * "Review in curator": the proxied curator URL from the `curator` event, in a new tab (plain
 * text unless it is an `http(s)://` URL).
 */
export function CuratorButton({ url }: { url?: string | undefined }) {
  if (!url) return null;
  if (!isWebUrl(url)) {
    return <p className="text-xs break-all text-muted-foreground">Curator: {url}</p>;
  }
  return (
    <Button asChild size="sm" variant="outline" className="self-start">
      <a href={url} target="_blank" rel="noopener noreferrer">
        <ExternalLinkIcon />
        Review in curator
      </a>
    </Button>
  );
}
