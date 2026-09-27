/**
 * Compact cards for the custom messages pi-web-access and pi-mcp-adapter send with
 * `display: true`. Unregistered types keep the transcript's generic markdown card.
 */

import {
  CircleAlertIcon,
  GlobeIcon,
  KeyRoundIcon,
  PlugIcon,
  SearchIcon,
  SettingsIcon,
  UserIcon,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Markdown } from "@/components/markdown";
import {
  type CustomMessageRendererProps,
  registerCustomMessageRenderer,
} from "@/features/conversation/transcript/custom-message-registry";
import { contentText } from "@/lib/content";
import { cn } from "@/lib/utils";
import { asRecord, num, str } from "./common";

function Card({
  icon: Icon,
  title,
  tone = "default",
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
  tone?: "default" | "error";
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg border bg-card/30 px-3 py-2 text-xs",
        tone === "error" && "border-destructive/50 text-destructive",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        />
        <span className="min-w-0 break-words">{title}</span>
      </div>
      {children}
    </div>
  );
}

const text = (props: CustomMessageRendererProps) => contentText(props.content).trim();

function ContentReadyCard(props: CustomMessageRendererProps) {
  return <Card icon={GlobeIcon} title={text(props)} />;
}

function WebSearchErrorCard(props: CustomMessageRendererProps) {
  return <Card icon={CircleAlertIcon} title={text(props)} tone="error" />;
}

function WebSearchResultsCard(props: CustomMessageRendererProps) {
  const d = asRecord(props.details);
  const queries = Array.isArray(d?.queries)
    ? (d.queries as unknown[]).filter((q): q is string => typeof q === "string")
    : [];
  const total = num(d, "totalResults");
  const title =
    queries.length === 1
      ? `Search results for "${queries[0]}"`
      : queries.length > 1
        ? `Search results (${queries.length} queries)`
        : "Search results";
  return (
    <Card icon={SearchIcon} title={total !== undefined ? `${title} · ${total} sources` : title}>
      <details>
        <summary className="cursor-pointer text-muted-foreground select-none">Show results</summary>
        <div className="max-h-96 overflow-auto">
          <Markdown text={text(props)} className="text-xs" />
        </div>
      </details>
    </Card>
  );
}

function CuratorConfigCard(props: CustomMessageRendererProps) {
  return <Card icon={SettingsIcon} title={text(props)} />;
}

function GoogleAccountCard(props: CustomMessageRendererProps) {
  const available = asRecord(props.details)?.available;
  return (
    <Card icon={UserIcon} title={text(props)} tone={available === false ? "error" : "default"} />
  );
}

function mcpOrigin(details: unknown): string | undefined {
  const server = str(details, "server");
  const tool = str(details, "tool");
  if (server && tool) return `${server} · ${tool}`;
  return server ?? tool;
}

function McpUiPromptCard(props: CustomMessageRendererProps) {
  const prompt = str(props.details, "prompt") ?? text(props);
  return (
    <Card icon={PlugIcon} title={<>UI prompt{origin(props)}</>}>
      <p className="whitespace-pre-wrap break-words">{prompt}</p>
    </Card>
  );
}

function McpUiIntentCard(props: CustomMessageRendererProps) {
  const intent = str(props.details, "intent");
  const params = asRecord(props.details)?.params;
  return (
    <Card icon={PlugIcon} title={<>UI intent{origin(props)}</>}>
      <p className="break-words font-mono">
        {intent ?? text(props)}
        {intent && params !== undefined && ` ${JSON.stringify(params)}`}
      </p>
    </Card>
  );
}

function McpUiContextCard(props: CustomMessageRendererProps) {
  return (
    <Card icon={PlugIcon} title={<>UI context submitted{origin(props)}</>}>
      <details>
        <summary className="cursor-pointer text-muted-foreground select-none">Show context</summary>
        <p className="whitespace-pre-wrap break-words">{text(props)}</p>
      </details>
    </Card>
  );
}

function McpOauthStatusCard(props: CustomMessageRendererProps) {
  const failed = str(props.details, "status") === "failed";
  return <Card icon={KeyRoundIcon} title={text(props)} tone={failed ? "error" : "default"} />;
}

function origin(props: CustomMessageRendererProps): ReactNode {
  const from = mcpOrigin(props.details);
  return from ? <span className="text-muted-foreground"> · {from}</span> : null;
}

registerCustomMessageRenderer("web-search-content-ready", ContentReadyCard);
registerCustomMessageRenderer("web-search-error", WebSearchErrorCard);
registerCustomMessageRenderer("web-search-results", WebSearchResultsCard);
registerCustomMessageRenderer("curator-config", CuratorConfigCard);
registerCustomMessageRenderer("google-account", GoogleAccountCard);
registerCustomMessageRenderer("mcp-ui-prompt", McpUiPromptCard);
registerCustomMessageRenderer("mcp-ui-intent", McpUiIntentCard);
registerCustomMessageRenderer("mcp-ui-context", McpUiContextCard);
registerCustomMessageRenderer("mcp-oauth-status", McpOauthStatusCard);
