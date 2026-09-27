import { ArrowUpIcon, ListPlusIcon, NavigationIcon, SquareIcon, UndoIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { errorMessage, rpc } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useConversation } from "@/store/context";
import { selectEditorText, selectIsRunning, selectQueue } from "@/store/selectors";

/** Phones and tablets: Enter inserts a newline, sending is a button tap. */
function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
}

function joinTexts(texts: readonly string[]): string {
  return texts.filter((t) => t.trim() !== "").join("\n\n");
}

/**
 * Prompt composer (`docs/design/03-web-client.md`, "Composer").
 *
 * - Idle: Send → `prompt`.
 * - Running: Steer → `prompt { streamingBehavior: "steer" }`, Queue → `"followUp"`,
 *   Stop → `abort`, Stop & edit → `clear_queue` then `abort`, restoring the queued texts.
 * - Desktop keys: Enter sends (steers while running), Alt+Enter queues, Shift+Enter newline.
 * - `set_editor_text` requests replace the text.
 */
export function Composer() {
  const agentId = useConversation((s) => s.agentId);
  const hydrated = useConversation((s) => s.hydrated);
  const ready = useConversation((s) => s.hydrated && s.agent.status === "ready");
  const running = useConversation(selectIsRunning);
  const queue = useConversation(selectQueue);
  const editorText = useConversation(selectEditorText);
  const [text, setText] = useState("");
  const [stopping, setStopping] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Apply set_editor_text requests that arrive while mounted; the one already in the first
  // snapshot is history, not a request for this screen.
  const seenNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    const nonce = editorText?.nonce ?? 0;
    if (seenNonce.current === null) {
      seenNonce.current = nonce;
      return;
    }
    if (editorText && nonce !== seenNonce.current) {
      seenNonce.current = nonce;
      setText(editorText.text);
      textareaRef.current?.focus();
    }
  }, [editorText, hydrated]);

  // Autosize where `field-sizing: content` is unsupported (Safari, Firefox).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content"))) return;
    void text;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const hasQueue = queue.steering.length + queue.followUp.length > 0;
  const canSend = ready && text.trim() !== "";

  async function send(behavior?: "steer" | "followUp") {
    const message = text.trim();
    if (!ready || message === "") return;
    setText("");
    try {
      await rpc(
        agentId,
        running
          ? { type: "prompt", message, streamingBehavior: behavior ?? "steer" }
          : { type: "prompt", message },
      );
    } catch (error) {
      setText((current) => (current === "" ? message : current));
      toast.error(errorMessage(error));
    }
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

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (isCoarsePointer()) return;
    event.preventDefault();
    void send(running && event.altKey ? "followUp" : "steer");
  }

  return (
    <div className="rounded-2xl border bg-card/60 focus-within:border-ring">
      <textarea
        ref={textareaRef}
        aria-label="Message"
        value={text}
        rows={1}
        disabled={!ready}
        placeholder={
          !ready ? "Waiting for pi…" : running ? "Steer or queue a message…" : "Message pi…"
        }
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="field-sizing-content block max-h-48 min-h-11 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm"
      />
      <div className="flex items-center justify-end gap-1.5 px-2 pb-2">
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
            <Button type="button" size="sm" disabled={!canSend} onClick={() => void send("steer")}>
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
            className={cn("rounded-full")}
            disabled={!canSend}
            onClick={() => void send()}
          >
            <ArrowUpIcon />
          </Button>
        )}
      </div>
    </div>
  );
}
