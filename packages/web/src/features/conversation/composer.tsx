import type { ImageContent } from "@pi-code/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpIcon,
  ImagePlusIcon,
  ListPlusIcon,
  NavigationIcon,
  SquareIcon,
  UndoIcon,
  XIcon,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { errorMessage, rpc } from "@/lib/api";
import { imageSrc } from "@/lib/content";
import { queryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { useConversation, useConversationStore } from "@/store/context";
import type { ConversationStore } from "@/store/conversation-store";
import { selectEditorText, selectIsRunning, selectQueue } from "@/store/selectors";
import { useConversationUi } from "./conversation-ui";
import {
  BUILTIN_COMMANDS,
  commandItems,
  filterSlashItems,
  findBuiltin,
  parseBash,
  parseSlash,
  type SlashItem,
  SOURCE_LABEL,
  slashQuery,
} from "./slash-commands";
import { useBuiltinCommands } from "./use-builtin-commands";

/** Phones and tablets: Enter inserts a newline, sending is a button tap. */
function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
}

function joinTexts(texts: readonly string[]): string {
  return texts.filter((t) => t.trim() !== "").join("\n\n");
}

interface Attachment {
  key: string;
  name: string;
  image: ImageContent;
}

let attachmentKey = 0;

/** Last `set_editor_text` nonce applied per conversation store (outlives remounts). */
const seenEditorNonce = new WeakMap<ConversationStore, number>();

/** Read an image file as base64 `ImageContent`. */
export function readImageFile(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Couldn't read ${file.name}`));
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(",");
      const header = url.slice(0, comma);
      const mimeType = /^data:([^;]+)/.exec(header)?.[1] || file.type || "image/png";
      resolve({
        key: `img-${++attachmentKey}`,
        name: file.name,
        image: { type: "image", data: url.slice(comma + 1), mimeType },
      });
    };
    reader.readAsDataURL(file);
  });
}

/** Slash-command suggestions above the composer. */
function SlashMenu({
  id,
  items,
  active,
  onPick,
  onHover,
}: {
  id: string;
  items: SlashItem[];
  active: number;
  onPick(item: SlashItem): void;
  onHover(index: number): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <div
      ref={listRef}
      id={id}
      role="listbox"
      aria-label="Commands"
      className="absolute inset-x-0 bottom-full z-20 mb-1 flex max-h-64 flex-col overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg"
    >
      {items.map((item, index) => (
        <button
          key={`${item.source}:${item.name}`}
          id={`${id}-${index}`}
          data-index={index}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={index === active}
          // Keep focus in the textarea.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(item)}
          className={cn(
            "flex min-w-0 cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm",
            index === active && "bg-muted",
          )}
        >
          <span className="shrink-0 font-mono">/{item.name}</span>
          {item.argumentHint && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {item.argumentHint}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {item.description}
          </span>
          <Badge variant="outline" className="shrink-0 font-normal">
            {SOURCE_LABEL[item.source]}
          </Badge>
        </button>
      ))}
    </div>
  );
}

/**
 * Prompt composer (`docs/design/03-web-client.md`, "Composer").
 *
 * - Idle: Send → `prompt`.
 * - Running: Steer → `prompt { streamingBehavior: "steer" }`, Queue → `"followUp"`,
 *   Stop → `abort`, Stop & edit → `clear_queue` then `abort`, restoring the queued texts.
 * - Desktop keys: Enter sends (steers while running), Alt+Enter queues, Shift+Enter newline.
 * - `/` autocompletes built-in and pi commands; built-ins run in the client.
 * - `!cmd` → `bash`; `!!cmd` → `bash { excludeFromContext: true }`.
 * - Images (camera or gallery) go into `prompt.images` when the model accepts images.
 * - `set_editor_text` requests and fork drafts replace the text.
 */
export function Composer() {
  const store = useConversationStore();
  const agentId = useConversation((s) => s.agentId);
  const hydrated = useConversation((s) => s.hydrated);
  const ready = useConversation((s) => s.hydrated && s.agent.status === "ready");
  const running = useConversation(selectIsRunning);
  const queue = useConversation(selectQueue);
  const editorText = useConversation(selectEditorText);
  const supportsImages = useConversation((s) => s.state?.model?.input.includes("image") === true);
  const draft = useConversationUi((s) => s.draft);
  const runBuiltin = useBuiltinCommands();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [stopping, setStopping] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuId = useId();

  // Apply set_editor_text requests that arrive after the first snapshot (including while the
  // tree screen replaced this one, e.g. "Go here" on a user message); the one already in the
  // first snapshot is history, not a request for this screen.
  useEffect(() => {
    if (!hydrated) return;
    const nonce = editorText?.nonce ?? 0;
    const seen = seenEditorNonce.get(store);
    if (seen === undefined) {
      seenEditorNonce.set(store, nonce);
      return;
    }
    if (editorText && nonce !== seen) {
      seenEditorNonce.set(store, nonce);
      setText(editorText.text);
      textareaRef.current?.focus();
    }
  }, [editorText, hydrated, store]);

  // A draft handed over by a fork (possibly from the tree screen, before this mounted).
  useEffect(() => {
    if (draft === null || draft.agentId !== agentId) return;
    const value = useConversationUi.getState().takeDraft(agentId);
    if (value !== null) {
      setText(value);
      textareaRef.current?.focus();
    }
  }, [draft, agentId]);

  // Attachments can't be sent to a model without image input.
  useEffect(() => {
    if (!supportsImages) setAttachments((current) => (current.length === 0 ? current : []));
  }, [supportsImages]);

  // Autosize where `field-sizing: content` is unsupported (Safari, Firefox).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content"))) return;
    void text;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // Slash autocomplete.
  const query = slashQuery(text);
  const commands = useQuery({
    queryKey: queryKeys.commands(agentId),
    queryFn: () => rpc(agentId, { type: "get_commands" }),
    enabled: ready && query !== null,
    staleTime: 60_000,
  });
  const menuItems = useMemo(
    () =>
      query === null
        ? []
        : filterSlashItems(
            [...BUILTIN_COMMANDS, ...commandItems(commands.data?.commands ?? [])],
            query,
          ),
    [query, commands.data],
  );
  const menuOpen = ready && query !== null && !menuDismissed && menuItems.length > 0;
  const activeIndex = Math.min(menuIndex, Math.max(0, menuItems.length - 1));

  function updateText(value: string) {
    setText(value);
    setMenuIndex(0);
    if (slashQuery(value) === null) setMenuDismissed(false);
  }

  const hasQueue = queue.steering.length + queue.followUp.length > 0;
  const canSend = ready && (text.trim() !== "" || attachments.length > 0);

  async function runBash(message: string, command: string, excludeFromContext: boolean) {
    setText("");
    try {
      const data = await rpc(
        agentId,
        excludeFromContext
          ? { type: "bash", command, excludeFromContext }
          : { type: "bash", command },
      );
      if (excludeFromContext && data?.id) useConversationUi.getState().markBashExcluded(data.id);
    } catch (error) {
      setText((current) => (current === "" ? message : current));
      toast.error(errorMessage(error));
    }
  }

  async function send(behavior?: "steer" | "followUp") {
    const message = text.trim();
    if (!ready || (message === "" && attachments.length === 0)) return;

    if (attachments.length === 0) {
      const bash = parseBash(message);
      if (bash) {
        await runBash(message, bash.command, bash.excludeFromContext);
        return;
      }
      // Other slash commands (extension, skill, template) go to pi as a prompt.
      const slash = parseSlash(message);
      if (slash && findBuiltin(slash.name)) {
        setText("");
        await runBuiltin(slash.name, slash.args);
        return;
      }
    }

    const images = attachments.map((a) => a.image);
    setText("");
    setAttachments([]);
    const base = images.length > 0 ? { message, images } : { message };
    try {
      await rpc(
        agentId,
        running
          ? { type: "prompt", ...base, streamingBehavior: behavior ?? "steer" }
          : { type: "prompt", ...base },
      );
    } catch (error) {
      setText((current) => (current === "" ? message : current));
      setAttachments((current) => (current.length === 0 ? attachments : current));
      toast.error(errorMessage(error));
    }
  }

  async function pick(item: SlashItem) {
    setMenuIndex(0);
    if (item.source === "builtin" && item.argumentHint === undefined) {
      setText("");
      await runBuiltin(item.name, "");
      return;
    }
    setText(`/${item.name} `);
    textareaRef.current?.focus();
  }

  async function stop() {
    setStopping(true);
    try {
      await rpc(agentId, { type: "abort" });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setStopping(false);
    }
  }

  async function stopAndEdit() {
    setStopping(true);
    try {
      const queued = await rpc(agentId, { type: "clear_queue" });
      const restored = [...(queued?.steering ?? []), ...(queued?.followUp ?? [])];
      setText((current) => joinTexts([...restored, current]));
      textareaRef.current?.focus();
      await rpc(agentId, { type: "abort" });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setStopping(false);
    }
  }

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const images = [...files].filter((f) => f.type === "" || f.type.startsWith("image/"));
    try {
      const read = await Promise.all(images.map(readImageFile));
      setAttachments((current) => [...current, ...read]);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setMenuIndex((activeIndex + delta + menuItems.length) % menuItems.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        const item = menuItems[activeIndex];
        if (item) void pick(item);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (isCoarsePointer()) return;
    event.preventDefault();
    void send(running && event.altKey ? "followUp" : "steer");
  }

  return (
    <div className="relative">
      {menuOpen && (
        <SlashMenu
          id={menuId}
          items={menuItems}
          active={activeIndex}
          onPick={(item) => void pick(item)}
          onHover={setMenuIndex}
        />
      )}
      <div className="rounded-2xl border bg-card/60 focus-within:border-ring">
        {attachments.length > 0 && (
          <ul aria-label="Attached images" className="flex gap-2 overflow-x-auto px-3 pt-3">
            {attachments.map((attachment, index) => (
              <li key={attachment.key} className="relative shrink-0">
                <img
                  src={imageSrc(attachment.image)}
                  alt={attachment.name || `Image ${index + 1}`}
                  className="size-16 rounded-lg border object-cover"
                />
                <button
                  type="button"
                  aria-label={`Remove image ${index + 1}`}
                  onClick={() =>
                    setAttachments((current) => current.filter((a) => a.key !== attachment.key))
                  }
                  className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background shadow"
                >
                  <XIcon className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          aria-label="Message"
          aria-autocomplete="list"
          aria-controls={menuOpen ? menuId : undefined}
          aria-activedescendant={menuOpen ? `${menuId}-${activeIndex}` : undefined}
          value={text}
          rows={1}
          disabled={!ready}
          placeholder={
            !ready ? "Waiting for pi…" : running ? "Steer or queue a message…" : "Message pi…"
          }
          onChange={(event) => updateText(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => setMenuDismissed(false)}
          className="field-sizing-content block max-h-48 min-h-11 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm"
        />
        <div className="flex items-center justify-end gap-1.5 px-2 pb-2">
          {supportsImages && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                data-testid="image-input"
                onChange={(event) => {
                  void addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Attach image"
                className="mr-auto"
                disabled={!ready}
                onClick={() => fileRef.current?.click()}
              >
                <ImagePlusIcon />
              </Button>
            </>
          )}
          {running ? (
            <>
              {hasQueue && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={stopping}
                  onClick={() => void stopAndEdit()}
                >
                  <UndoIcon /> Stop &amp; edit
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canSend}
                onClick={() => void send("followUp")}
              >
                <ListPlusIcon /> Queue
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canSend}
                onClick={() => void send("steer")}
              >
                <NavigationIcon /> Steer
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="icon"
                aria-label="Stop"
                disabled={stopping}
                onClick={() => void stop()}
              >
                <SquareIcon className="fill-current" />
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="icon"
              aria-label="Send"
              className="rounded-full"
              disabled={!canSend}
              onClick={() => void send()}
            >
              <ArrowUpIcon />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
