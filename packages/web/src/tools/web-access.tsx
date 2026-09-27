/**
 * pi-web-access tools: `web_search`, `source_check`, `fetch_content`, `get_search_content`.
 * Search results link to their sources; a running search with a curator shows **Review in
 * curator** (the proxied URL from the `curator` event, opened in a new tab).
 */

import { Markdown } from "@/components/markdown";
import { toolResultText } from "@/lib/content";
import {
  asRecord,
  CuratorButton,
  ErrorOutput,
  ExternalLink,
  Images,
  isActive,
  Muted,
  Notice,
  num,
  resultImages,
  str,
  strList,
  truncate,
} from "./common";
import { registerToolRenderer, type ToolRenderer, type ToolRendererProps } from "./registry";

export interface SourceLink {
  title: string;
  url: string;
}

const SOURCE_LINE = /^Source: (.+) \((https?:\/\/[^\s()]+(?:\([^\s()]*\))?[^\s()]*)\)\s*$/gm;

/** "Source: Title (https://…)" lines of a search result text. */
export function sourcesFromText(text: string): SourceLink[] {
  const out: SourceLink[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(SOURCE_LINE)) {
    const url = m[2] as string;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title: (m[1] as string).trim(), url });
  }
  return out;
}

function queriesOf(args: unknown): string[] {
  const list = strList(args, "queries");
  if (list.length > 0) return list;
  const query = str(args, "query");
  return query ? [query] : [];
}

function details(props: ToolRendererProps) {
  return asRecord(props.result?.details) ?? asRecord(asRecord(props.partialResult)?.details);
}

function SourceList({ sources }: { sources: SourceLink[] }) {
  if (sources.length === 0) return null;
  return (
    <ul data-testid="source-list" className="flex flex-col gap-1 text-xs">
      {sources.map((s) => (
        <li key={s.url} className="min-w-0">
          <ExternalLink href={s.url}>{s.title || s.url}</ExternalLink>{" "}
          <Muted>· {hostOf(s.url)}</Muted>
        </li>
      ))}
    </ul>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Progress line of a running search / fetch (`details.phase`, `progress`, `currentQuery`). */
function Progress({ props }: { props: ToolRendererProps }) {
  const d = asRecord(asRecord(props.partialResult)?.details);
  const text = toolResultText(props.partialResult);
  const progress = num(d, "progress");
  const phase = str(d, "phase");
  return (
    <p className="text-xs text-muted-foreground">
      {text || phase || "Working…"}
      {progress !== undefined && !text && ` (${Math.round(progress * 100)}%)`}
    </p>
  );
}

// ---------------------------------------------------------------------------
// web_search

function WebSearchSummary(props: ToolRendererProps) {
  const queries = queriesOf(props.args);
  const d = details(props);
  const total = props.result && !props.isError ? num(d, "totalResults") : undefined;
  return (
    <span className="text-muted-foreground">
      {queries.length === 1 && (
        <span className="text-foreground">"{truncate(queries[0] ?? "", 80)}"</span>
      )}
      {queries.length > 1 && <span className="text-foreground">{queries.length} queries</span>}
      {total !== undefined && ` · ${total} ${total === 1 ? "source" : "sources"}`}
    </span>
  );
}

interface CuratedQuery {
  query: string;
  answer?: string | null;
  error?: string | null;
  sources: SourceLink[];
}

function curatedQueries(d: Record<string, unknown> | undefined): CuratedQuery[] {
  const list = d?.curatedQueries;
  if (!Array.isArray(list)) return [];
  return list.map((q) => {
    const sources = asRecord(q)?.sources;
    return {
      query: str(q, "query") ?? "",
      answer: str(q, "answer") ?? null,
      error: str(q, "error") ?? null,
      sources: Array.isArray(sources)
        ? sources
            .map((s) => ({ title: str(s, "title") ?? "", url: str(s, "url") ?? "" }))
            .filter((s) => s.url !== "")
        : [],
    };
  });
}

function WebSearchBody(props: ToolRendererProps) {
  const queries = queriesOf(props.args);
  const d = details(props);
  const curator = <CuratorButton url={props.curatorUrl} />;
  if (props.result === undefined) {
    return (
      <div className="flex flex-col gap-2">
        {queries.length > 1 && <QueryList queries={queries} />}
        {isActive(props.status) ? <Progress props={props} /> : null}
        {curator}
      </div>
    );
  }
  if (props.isError || str(d, "error")) {
    return (
      <div className="flex flex-col gap-2">
        {curator}
        <ErrorOutput result={props.result} />
      </div>
    );
  }
  const text = toolResultText(props.result);
  const summary = str(asRecord(d?.summary), "text");
  const curated = curatedQueries(d);
  const sources = curated.length > 0 ? [] : sourcesFromText(text);
  return (
    <div className="flex flex-col gap-3">
      {curator}
      {queries.length > 1 && <QueryList queries={queries} />}
      {summary && (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">Summary</h4>
          <Markdown text={summary} className="text-xs" />
        </section>
      )}
      {curated.map((q, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: queries may repeat
        <section key={i} className="flex flex-col gap-1">
          <h4 className="text-xs font-medium">"{q.query}"</h4>
          {q.error ? (
            <p className="text-xs text-destructive">{q.error}</p>
          ) : (
            q.answer && !summary && <Markdown text={q.answer} className="text-xs" />
          )}
          <SourceList sources={q.sources} />
        </section>
      ))}
      {curated.length === 0 && (
        <>
          <SourceList sources={sources} />
          {!summary && (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground select-none">
                Full results
              </summary>
              <div className="max-h-96 overflow-auto">
                <Markdown text={text} className="text-xs" />
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function QueryList({ queries }: { queries: string[] }) {
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {queries.map((q, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: queries may repeat
        <li key={i}>"{q}"</li>
      ))}
    </ul>
  );
}

export const webSearchRenderer: ToolRenderer = {
  Summary: WebSearchSummary,
  Body: WebSearchBody,
  expandWhileRunning: true,
};

// ---------------------------------------------------------------------------
// source_check

function SourceCheckSummary(props: ToolRendererProps) {
  const claim = str(props.args, "claim");
  const count = props.result && !props.isError ? num(details(props), "sourceCount") : undefined;
  return (
    <span className="text-muted-foreground">
      {claim && <span className="text-foreground">{truncate(claim, 80)}</span>}
      {count !== undefined && ` · ${count} ${count === 1 ? "source" : "sources"}`}
    </span>
  );
}

function SourceCheckBody(props: ToolRendererProps) {
  const curator = <CuratorButton url={props.curatorUrl} />;
  if (props.result === undefined) {
    return (
      <div className="flex flex-col gap-2">
        {isActive(props.status) && <Progress props={props} />}
        {curator}
      </div>
    );
  }
  const d = details(props);
  if (props.isError || str(d, "error")) return <ErrorOutput result={props.result} />;
  const artifact = asRecord(d?.artifact);
  const sources = Array.isArray(artifact?.sources)
    ? (artifact.sources as unknown[])
        .map((s) => ({ title: str(s, "title") ?? "", url: str(s, "url") ?? "" }))
        .filter((s) => s.url !== "")
    : [];
  const summary = str(artifact, "summary");
  const passages = num(d, "passageCount");
  const text = toolResultText(props.result);
  return (
    <div className="flex flex-col gap-3">
      {curator}
      {summary && <Markdown text={summary} className="text-xs" />}
      <SourceList sources={sources.length > 0 ? sources : sourcesFromText(text)} />
      {passages !== undefined && (
        <Notice>
          {passages} {passages === 1 ? "passage" : "passages"} extracted
        </Notice>
      )}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground select-none">
          Full artifact
        </summary>
        <div className="max-h-96 overflow-auto">
          <Markdown text={text} className="text-xs" />
        </div>
      </details>
    </div>
  );
}

export const sourceCheckRenderer: ToolRenderer = {
  Summary: SourceCheckSummary,
  Body: SourceCheckBody,
  expandWhileRunning: true,
};

// ---------------------------------------------------------------------------
// fetch_content / get_search_content

function urlsOf(args: unknown): string[] {
  const list = strList(args, "urls");
  if (list.length > 0) return list;
  const url = str(args, "url");
  return url ? [url] : [];
}

function FetchSummary(props: ToolRendererProps) {
  const urls = urlsOf(props.args);
  const title = props.result && !props.isError ? str(details(props), "title") : undefined;
  return (
    <span className="text-muted-foreground">
      {urls.length === 1 && <span className="text-foreground">{truncate(urls[0] ?? "", 80)}</span>}
      {urls.length > 1 && <span className="text-foreground">{urls.length} URLs</span>}
      {title && ` · ${truncate(title, 60)}`}
    </span>
  );
}

function ContentBody({ props, urls }: { props: ToolRendererProps; urls: string[] }) {
  const d = details(props);
  const links = urls.length > 1 || props.result === undefined ? urls : [];
  if (props.result === undefined) {
    return (
      <div className="flex flex-col gap-2">
        <UrlList urls={links} />
        {isActive(props.status) && <Progress props={props} />}
      </div>
    );
  }
  if (props.isError || str(d, "error")) {
    return (
      <div className="flex flex-col gap-2">
        <UrlList urls={urls} />
        <ErrorOutput result={props.result} />
      </div>
    );
  }
  const text = toolResultText(props.result);
  return (
    <div className="flex flex-col gap-2">
      <UrlList urls={urls} />
      <Images images={resultImages(props.result)} />
      {text !== "" && (
        <div className="max-h-[32rem] overflow-auto">
          <Markdown text={text} className="text-xs" />
        </div>
      )}
      {d?.truncated === true && <Notice>Content truncated</Notice>}
    </div>
  );
}

function UrlList({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {urls.map((url) => (
        <li key={url} className="min-w-0">
          {/^https?:\/\//.test(url) ? <ExternalLink href={url}>{url}</ExternalLink> : url}
        </li>
      ))}
    </ul>
  );
}

function FetchBody(props: ToolRendererProps) {
  return <ContentBody props={props} urls={urlsOf(props.args)} />;
}

export const fetchContentRenderer: ToolRenderer = {
  Summary: FetchSummary,
  Body: FetchBody,
};

function selector(args: unknown): string | undefined {
  const url = str(args, "url");
  if (url) return url;
  const query = str(args, "query");
  if (query) return `"${query}"`;
  const urlIndex = num(args, "urlIndex");
  if (urlIndex !== undefined) return `URL #${urlIndex}`;
  const queryIndex = num(args, "queryIndex");
  if (queryIndex !== undefined) return `query #${queryIndex}`;
  return undefined;
}

function GetContentSummary(props: ToolRendererProps) {
  const d = props.result && !props.isError ? details(props) : undefined;
  const what = str(d, "title") ?? str(d, "url") ?? selector(props.args);
  const id = str(props.args, "responseId");
  return (
    <span className="text-muted-foreground">
      {what && <span className="text-foreground">{truncate(what, 80)}</span>}
      {id && ` · ${id}`}
    </span>
  );
}

function GetContentBody(props: ToolRendererProps) {
  const d = details(props);
  const url = str(d, "url") ?? str(props.args, "url");
  return <ContentBody props={props} urls={url ? [url] : []} />;
}

export const getSearchContentRenderer: ToolRenderer = {
  Summary: GetContentSummary,
  Body: GetContentBody,
};

registerToolRenderer("web_search", webSearchRenderer);
registerToolRenderer("source_check", sourceCheckRenderer);
registerToolRenderer("fetch_content", fetchContentRenderer);
registerToolRenderer("get_search_content", getSearchContentRenderer);
