/**
 * The Guide tab (`docs/design/11-pr-guide.md`, "Web client"): the attached PR's guide under the PR
 * header. While the server writes it, a loading state; when that failed, the error and Retry;
 * once ready, its sections and "Other changes" in one column under a sticky bar naming the
 * current one, each with its explanation, a Reviewed mark and file cards holding its hunks.
 */

import type { PrAttachment } from "@pi-code/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  LoaderIcon,
  UnfoldVerticalIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { isLargePatch } from "@/components/diff";
import { EmptyState } from "@/components/empty-state";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, getPrGuide, retryPrGuide } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";
import { changeReference, FileCard, FilePath, LineCounts, NoHunks, StatusBadge } from "./file-card";
import { useFileContent } from "./file-content";
import {
  currentItem,
  expandCards,
  type GuideCard,
  type GuideItem,
  guideItems,
  type ReadyGuide,
} from "./guide-model";
import { useReviewedItems, useReviewedStore } from "./guide-reviewed";
import { useConversationPr } from "./pr";
import { PrHeader } from "./pr-header";
import { LoadError, retryServerErrors } from "./query-states";
import { SelectableDiff } from "./selectable-diff";

/** `7` → `07`. */
const twoDigits = (n: number) => String(n).padStart(2, "0");

export function GuideView({ agentId, onAdded }: { agentId: string; onAdded?(): void }) {
  const pr = useConversationPr();
  if (pr === undefined) return null;
  return (
    <div className="flex flex-col pb-6">
      <PrHeader agentId={agentId} pr={pr} />
      <GuideBody agentId={agentId} pr={pr} {...(onAdded && { onAdded })} />
    </div>
  );
}

function GuideBody({
  agentId,
  pr,
  onAdded,
}: {
  agentId: string;
  pr: PrAttachment;
  onAdded?(): void;
}) {
  const queryKey = queryKeys.prGuide(agentId, pr.baseSha, pr.headSha);
  const guide = useQuery({
    queryKey,
    queryFn: () => getPrGuide(agentId),
    // `guide` frames refetch it.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: retryServerErrors,
  });
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => retryPrGuide(agentId),
    onSuccess: (response) => queryClient.setQueryData(queryKey, response),
    onError: (error) => toast.error(`Couldn't retry the guide: ${errorMessage(error)}`),
  });

  if (guide.isPending) {
    return (
      <div data-testid="guide-loading" className="flex flex-col gap-2 p-3">
        <Skeleton className="h-7" />
        <Skeleton className="h-7" />
      </div>
    );
  }
  if (guide.isError) {
    return (
      <div className="p-3">
        <LoadError what="the guide" error={guide.error} onRetry={() => void guide.refetch()} />
      </div>
    );
  }
  const { data } = guide;
  switch (data.state) {
    case "generating":
      return (
        <EmptyState
          icon={<LoaderIcon className="animate-spin" />}
          title="Writing the review guide…"
          description="It appears here once ready."
        />
      );
    case "failed":
      return (
        <EmptyState
          icon={<CircleAlertIcon />}
          title="Couldn't write the review guide"
          description={data.error}
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={retry.isPending}
              onClick={() => retry.mutate()}
            >
              {retry.isPending && <LoaderIcon className="animate-spin" />}
              Retry
            </Button>
          }
        />
      );
    case "ready":
      return <Guide key={data.id} agentId={agentId} guide={data} {...(onAdded && { onAdded })} />;
  }
}

function Guide({
  agentId,
  guide,
  onAdded,
}: {
  agentId: string;
  guide: ReadyGuide;
  onAdded?(): void;
}) {
  const items = useMemo(() => guideItems(guide), [guide]);
  const expand = useMemo(() => expandCards(guide.units), [guide.units]);
  const reviewed = useReviewedItems(guide.key, guide.id);
  useEffect(() => useReviewedStore.getState().prune(guide.key, guide.id), [guide.key, guide.id]);
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  const [current, setCurrent] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const sections = useRef<(HTMLElement | null)[]>([]);
  // Prev/next name their item at once and skip reading the scroll they cause: near the end the
  // item can't reach the bar, and the scroll position would name another. That scroll's event
  // comes before the next animation frame, which ends the skip in case there was none.
  const skipScroll = useRef(false);

  useEffect(() => {
    // Captured on the document: the scroll area is the host's, the panel's or the page's.
    const onScroll = (event: Event) => {
      const area = event.target;
      if (!(area instanceof HTMLElement) || !root.current || !area.contains(root.current)) return;
      if (skipScroll.current) {
        skipScroll.current = false;
        return;
      }
      const areaTop = area.getBoundingClientRect().top;
      const tops = sections.current.map(
        (section) => (section?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY) - areaTop,
      );
      const barBottom = (bar.current?.getBoundingClientRect().bottom ?? areaTop) - areaTop;
      const atEnd =
        area.scrollTop > 0 && area.scrollTop + area.clientHeight >= area.scrollHeight - 1;
      setCurrent(currentItem(tops, barBottom + 1, atEnd));
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  const go = (index: number) => {
    setCurrent(index);
    skipScroll.current = true;
    sections.current[index]?.scrollIntoView({ block: "start" });
    requestAnimationFrame(() => {
      skipScroll.current = false;
    });
  };

  return (
    <div ref={root} className="flex flex-col">
      <div
        ref={bar}
        data-testid="guide-bar"
        className="sticky top-0 z-30 flex h-9 items-center gap-2 border-b bg-background pr-1.5 pl-3 text-xs in-data-[region=side]:bg-surface-side"
      >
        <p className="min-w-0 flex-1 truncate font-medium" title={items[current]?.title}>
          {items[current]?.title}
        </p>
        <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
          {twoDigits(current + 1)} / {twoDigits(items.length)}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Previous section"
          disabled={current === 0}
          onClick={() => go(current - 1)}
        >
          <ChevronUpIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Next section"
          disabled={current >= items.length - 1}
          onClick={() => go(current + 1)}
        >
          <ChevronDownIcon />
        </Button>
      </div>
      {items.map((item, index) => (
        <GuideSection
          // biome-ignore lint/suspicious/noArrayIndexKey: a generation's items never change
          key={index}
          index={index}
          item={item}
          sectionRef={(element) => {
            sections.current[index] = element;
          }}
          reviewed={reviewed.includes(index)}
          onReviewedChange={(value) =>
            useReviewedStore.getState().setReviewed(guide.key, guide.id, index, value)
          }
        >
          {item.cards.map((card) => {
            const key = `${index}:${card.key}`;
            return card.patch === undefined ? (
              <FileRow key={key} card={card} />
            ) : (
              <GuideFileCard
                key={key}
                agentId={agentId}
                guide={guide}
                card={card}
                patch={card.patch}
                open={opened[key] ?? expand}
                onOpenChange={(open) => setOpened((state) => ({ ...state, [key]: open }))}
                {...(onAdded && { onAdded })}
              />
            );
          })}
        </GuideSection>
      ))}
    </div>
  );
}

function GuideSection({
  index,
  item,
  sectionRef,
  reviewed,
  onReviewedChange,
  children,
}: {
  index: number;
  item: GuideItem;
  sectionRef(element: HTMLElement | null): void;
  reviewed: boolean;
  onReviewedChange(reviewed: boolean): void;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      ref={sectionRef}
      data-testid="guide-section"
      aria-labelledby={titleId}
      className="scroll-mt-9 border-b"
    >
      <div className="flex items-start gap-3 px-3 py-3">
        <h3 id={titleId} className="min-w-0 flex-1 text-sm font-semibold">
          <span className="mr-2 font-mono font-normal text-muted-foreground tabular-nums">
            {twoDigits(index + 1)}
          </span>
          {item.title}
        </h3>
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(event) => onReviewedChange(event.target.checked)}
            className="size-3.5 accent-primary"
          />
          Reviewed
        </label>
      </div>
      {!reviewed && (
        <div className="flex flex-col gap-3 px-3 pb-4">
          {item.explanation !== undefined && <Markdown text={item.explanation} />}
          {children}
        </div>
      )}
    </section>
  );
}

/** A file without hunks: its path, status and why it has none. */
function FileRow({ card }: { card: GuideCard }) {
  return (
    <div
      data-testid="diff-file"
      data-path={card.path}
      className="flex h-9 items-center gap-2 rounded-md border pr-3 pl-2"
    >
      <StatusBadge status={card.status} />
      <FilePath file={card} />
      {card.noHunks && <NoHunks reason={card.noHunks} />}
    </div>
  );
}

/**
 * A card's hunks, whose lines send references to the PR's commits as PR mode's do. An expandable
 * card (`GuideCard.expandable`) whose patch the viewer doesn't hold back as large offers "Expand
 * unchanged lines" in its header: it reads the file at the base (under its old path) and at the
 * head, and the viewer then expands the lines around the hunks. Read only on request, as passing
 * the text lays the view out again.
 */
function GuideFileCard({
  agentId,
  guide,
  card,
  patch,
  open,
  onOpenChange,
  onAdded,
}: {
  agentId: string;
  guide: ReadyGuide;
  card: GuideCard;
  patch: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onAdded?(): void;
}) {
  const offered = useMemo(() => card.expandable && !isLargePatch(patch), [card.expandable, patch]);
  const [requested, setRequested] = useState(false);
  const { baseSha, headSha } = guide.guide;
  const oldFile = useFileContent(agentId, card.oldPath ?? card.path, baseSha, requested);
  const newFile = useFileContent(agentId, card.path, headSha, requested);
  // Before the request, ignore what another card or the Files tab loaded.
  const oldText = requested ? oldFile.data?.content : undefined;
  const newText = requested ? newFile.data?.content : undefined;
  const fullText = useMemo(
    () =>
      oldText === undefined || newText === undefined ? undefined : { old: oldText, new: newText },
    [oldText, newText],
  );
  const error = oldFile.error ?? newFile.error;
  // Both read, yet without text: a version is binary or too large.
  const unreadable = oldFile.data !== undefined && newFile.data !== undefined && !fullText;

  let expandControl: ReactNode = null;
  if (open && offered && !fullText) {
    expandControl =
      requested && (error || unreadable) ? (
        <span
          title={error ? errorMessage(error) : "A version is binary or too large."}
          className="shrink-0 text-xs text-muted-foreground"
        >
          Can't expand
        </span>
      ) : (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Expand unchanged lines"
          disabled={requested}
          onClick={() => setRequested(true)}
        >
          {requested ? <LoaderIcon className="animate-spin" /> : <UnfoldVerticalIcon />}
        </Button>
      );
  }

  return (
    <FileCard
      file={card}
      aside={
        <>
          {expandControl}
          <LineCounts additions={card.additions} deletions={card.deletions} />
        </>
      }
      open={open}
      onOpenChange={onOpenChange}
      className="scroll-mt-9 overflow-clip rounded-md border"
      headerClassName="top-9"
    >
      <SelectableDiff
        patch={patch}
        fileName={card.path}
        flush
        toReference={(selection) => changeReference(card, guide, selection, true)}
        {...(fullText && { fullText })}
        {...(onAdded && { onAdded })}
      />
    </FileCard>
  );
}
