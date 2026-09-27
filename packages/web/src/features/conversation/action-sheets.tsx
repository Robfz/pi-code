import type { RpcSessionState, ThinkingLevel } from "@pi-code/protocol";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, LoaderIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, rpc } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";
import { formatCost, formatTokens } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useConversation } from "@/store/context";
import { selectSessionName } from "@/store/selectors";
import { type ActionSheet, useConversationUi } from "./conversation-ui";
import { useSessionActions } from "./session-actions";

function BottomSheet({
  title,
  description,
  testId,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  testId: string;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        data-testid={testId}
        className="max-h-[85dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader className="pr-12">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className={cn(!description && "sr-only")}>
            {description ?? title}
          </SheetDescription>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}

function Loading() {
  return (
    <p className="flex items-center gap-2 px-4 pb-4 text-sm text-muted-foreground">
      <LoaderIcon className="size-4 animate-spin" /> Loading…
    </p>
  );
}

function QueryError({ error }: { error: unknown }) {
  return (
    <p role="alert" className="px-4 pb-4 text-sm text-destructive">
      {errorMessage(error)}
    </p>
  );
}

function ForkSheet({ onClose }: { onClose(): void }) {
  const agentId = useConversation((s) => s.agentId);
  const actions = useSessionActions();
  const [busy, setBusy] = useState(false);
  const messages = useQuery({
    queryKey: queryKeys.forkMessages(agentId),
    queryFn: () => rpc(agentId, { type: "get_fork_messages" }),
    staleTime: 0,
  });
  const list = [...(messages.data?.messages ?? [])].reverse();
  return (
    <BottomSheet
      title="Fork from a message"
      description="Starts a new session from before the chosen message; its text goes into the composer."
      testId="fork-sheet"
      onClose={onClose}
    >
      {messages.isPending && <Loading />}
      {messages.isError && <QueryError error={messages.error} />}
      {messages.data && list.length === 0 && (
        <p className="px-4 pb-4 text-sm text-muted-foreground">No messages to fork from.</p>
      )}
      {list.length > 0 && (
        <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto px-4 pb-4" aria-label="Messages">
          {list.map((message) => (
            <li key={message.entryId}>
              <Button
                variant="outline"
                disabled={busy}
                className="h-auto min-h-10 w-full justify-start py-2 text-left whitespace-normal"
                onClick={async () => {
                  setBusy(true);
                  const ok = await actions.fork(message.entryId);
                  setBusy(false);
                  if (ok) onClose();
                }}
              >
                <span className="line-clamp-3 break-words">{message.text}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </BottomSheet>
  );
}

function CompactSheet({ onClose }: { onClose(): void }) {
  const actions = useSessionActions();
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <BottomSheet
      title="Compact context"
      description="Summarizes the conversation so far to free up context."
      testId="compact-sheet"
      onClose={onClose}
    >
      <div className="px-4">
        <Textarea
          aria-label="Instructions (optional)"
          placeholder="Instructions for the summary (optional)"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          className="min-h-20 text-base md:text-sm"
        />
      </div>
      <SheetFooter className="flex-row justify-end">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const ok = await actions.compact(instructions);
            setBusy(false);
            if (ok) onClose();
          }}
        >
          {busy && <LoaderIcon className="animate-spin" />} Compact
        </Button>
      </SheetFooter>
    </BottomSheet>
  );
}

function RenameSheet({ onClose }: { onClose(): void }) {
  const actions = useSessionActions();
  const current = useConversation((s) => selectSessionName(s) ?? "");
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    const ok = await actions.rename(name);
    setBusy(false);
    if (ok) onClose();
  }
  return (
    <BottomSheet title="Rename session" testId="rename-sheet" onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="px-4">
          <Input
            aria-label="Session name"
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            className="h-10 text-base md:text-sm"
          />
        </div>
        <SheetFooter className="flex-row justify-end">
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || name.trim() === ""}>
            Save
          </Button>
        </SheetFooter>
      </form>
    </BottomSheet>
  );
}

type AnyModel = NonNullable<RpcSessionState["model"]>;

/** Models grouped by provider, providers in first-seen order. */
export function groupModels(models: readonly AnyModel[]): [string, AnyModel[]][] {
  const groups = new Map<string, AnyModel[]>();
  for (const model of models) {
    const list = groups.get(model.provider) ?? [];
    list.push(model);
    groups.set(model.provider, list);
  }
  return [...groups.entries()];
}

function ModelSheet({ onClose }: { onClose(): void }) {
  const agentId = useConversation((s) => s.agentId);
  const current = useConversation((s) => s.state?.model);
  const actions = useSessionActions();
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const models = useQuery({
    queryKey: queryKeys.models(agentId),
    queryFn: () => rpc(agentId, { type: "get_available_models" }),
    staleTime: 60_000,
  });
  const needle = filter.trim().toLowerCase();
  const filtered = (models.data?.models ?? []).filter(
    (m) => needle === "" || `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(needle),
  );
  return (
    <BottomSheet title="Model" testId="model-sheet" onClose={onClose}>
      <div className="px-4">
        <Input
          aria-label="Filter models"
          placeholder="Filter…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="h-10 text-base md:text-sm"
        />
      </div>
      {models.isPending && <Loading />}
      {models.isError && <QueryError error={models.error} />}
      {models.data && filtered.length === 0 && (
        <p className="px-4 pb-4 text-sm text-muted-foreground">No models.</p>
      )}
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pb-4">
        {groupModels(filtered).map(([provider, list]) => (
          <section key={provider} aria-label={provider} className="flex flex-col gap-0.5">
            <h3 className="text-xs font-medium text-muted-foreground">{provider}</h3>
            {list.map((model) => {
              const selected = current?.provider === model.provider && current.id === model.id;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const ok = await actions.setModel(model.provider, model.id);
                    setBusy(false);
                    if (ok) onClose();
                  }}
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60",
                    selected && "bg-muted",
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-sm">{model.id}</span>
                    {model.name !== model.id && (
                      <span className="truncate text-xs text-muted-foreground">{model.name}</span>
                    )}
                  </span>
                  {model.input.includes("image") && (
                    <span className="text-xs text-muted-foreground">img</span>
                  )}
                  {selected && <CheckIcon className="size-4 shrink-0" />}
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </BottomSheet>
  );
}

function ThinkingSheet({ onClose }: { onClose(): void }) {
  const agentId = useConversation((s) => s.agentId);
  const current = useConversation((s) => s.state?.thinkingLevel);
  const modelKey = useConversation((s) =>
    s.state?.model ? `${s.state.model.provider}/${s.state.model.id}` : "",
  );
  const actions = useSessionActions();
  const [busy, setBusy] = useState(false);
  const levels = useQuery({
    queryKey: queryKeys.thinkingLevels(agentId, modelKey),
    queryFn: () => rpc(agentId, { type: "get_available_thinking_levels" }),
  });
  return (
    <BottomSheet title="Thinking level" testId="thinking-sheet" onClose={onClose}>
      {levels.isPending && <Loading />}
      {levels.isError && <QueryError error={levels.error} />}
      <div className="flex flex-col gap-1 px-4 pb-4">
        {(levels.data?.levels ?? []).map((level: ThinkingLevel) => (
          <button
            key={level}
            type="button"
            role="option"
            aria-selected={level === current}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const ok = await actions.setThinkingLevel(level);
              setBusy(false);
              if (ok) onClose();
            }}
            className={cn(
              "flex items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-muted/60",
              level === current && "bg-muted",
            )}
          >
            {level}
            {level === current && <CheckIcon className="size-4" />}
          </button>
        ))}
      </div>
    </BottomSheet>
  );
}

function StatRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-mono text-xs break-all">{value}</dd>
    </div>
  );
}

function StatsSheet({ onClose }: { onClose(): void }) {
  const agentId = useConversation((s) => s.agentId);
  const cached = useConversation((s) => s.stats);
  const stats = useQuery({
    queryKey: queryKeys.stats(agentId),
    queryFn: () => rpc(agentId, { type: "get_session_stats" }),
    staleTime: 0,
  });
  const data = stats.data ?? cached;
  const usage = data?.contextUsage;
  return (
    <BottomSheet title="Session" testId="stats-sheet" onClose={onClose}>
      {!data && stats.isPending && <Loading />}
      {!data && stats.isError && <QueryError error={stats.error} />}
      {data && (
        <dl className="overflow-y-auto px-4 pb-4 text-sm">
          {data.sessionFile && <StatRow label="File" value={data.sessionFile} />}
          <StatRow label="Session id" value={data.sessionId} />
          <StatRow
            label="Messages"
            value={`${data.userMessages} user · ${data.assistantMessages} assistant · ${data.totalMessages} total`}
          />
          <StatRow label="Tool calls" value={`${data.toolCalls} (${data.toolResults} results)`} />
          <StatRow
            label="Tokens"
            value={`${formatTokens(data.tokens.input)} in · ${formatTokens(data.tokens.output)} out`}
          />
          <StatRow
            label="Cache"
            value={`${formatTokens(data.tokens.cacheRead)} read · ${formatTokens(data.tokens.cacheWrite)} write`}
          />
          <StatRow label="Total tokens" value={formatTokens(data.tokens.total)} />
          <StatRow label="Cost" value={formatCost(data.cost)} />
          {usage && (
            <StatRow
              label="Context"
              value={
                usage.percent === null || usage.tokens === null
                  ? `? / ${formatTokens(usage.contextWindow)}`
                  : `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} (${Math.round(usage.percent)}%)`
              }
            />
          )}
        </dl>
      )}
    </BottomSheet>
  );
}

const SHEETS: Record<ActionSheet, (props: { onClose(): void }) => ReactNode> = {
  fork: ForkSheet,
  compact: CompactSheet,
  rename: RenameSheet,
  model: ModelSheet,
  thinking: ThinkingSheet,
  stats: StatsSheet,
};

/** Renders the action sheet opened from the header, status bar or a slash command. */
export function ActionSheets() {
  const agentId = useConversation((s) => s.agentId);
  const sheet = useConversationUi((s) => s.sheet);
  const closeSheet = useConversationUi((s) => s.closeSheet);
  useEffect(() => () => useConversationUi.getState().closeSheet(), []);
  if (sheet === null || sheet.agentId !== agentId) return null;
  const View = SHEETS[sheet.kind];
  return <View key={sheet.kind} onClose={closeSheet} />;
}

/** Opener bound to the current agent. */
export function useOpenSheet(): (kind: ActionSheet) => void {
  const agentId = useConversation((s) => s.agentId);
  const openSheet = useConversationUi((s) => s.openSheet);
  return useCallback((kind: ActionSheet) => openSheet(agentId, kind), [agentId, openSheet]);
}
