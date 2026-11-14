import { KeyboardIcon } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { COMMANDS, type Command, type CommandId } from "./commands";
import {
  chordLabel,
  detectContext,
  detectPlatform,
  hasModifierOnly,
  hasSafariRules,
  isBareModifier,
  isComposing,
  isLeader,
  isPlainOrModified,
  type Keymap,
  keyLabel,
  keymapFor,
  keyOf,
  leaderLabel,
  modifierLabel,
  type Platform,
  shortcutsFor,
} from "./keymap";

/** How long the unbound-key and off-state notices show. */
export const NOTICE_MS = 1500;

/** `conversation.goTo`'s handler takes the position (1–9); the others take nothing. */
export type CommandHandler<Id extends CommandId> = Id extends "conversation.goTo"
  ? (position: number) => void
  : () => void;

type AnyHandler = (position?: number) => void;

interface Keyboard {
  register(id: CommandId, handler: AnyHandler): () => void;
  openHelp(): void;
}

const KeyboardContext = createContext<Keyboard | null>(null);

function useKeyboard(): Keyboard {
  const keyboard = useContext(KeyboardContext);
  if (keyboard === null) throw new Error("useKeyboard outside KeyboardProvider");
  return keyboard;
}

/** Runs `handler` for command `id` while the component is mounted. */
export function useCommand<Id extends CommandId>(id: Id, handler: CommandHandler<Id>): void {
  const { register } = useKeyboard();
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(
    () => register(id, (position) => (latest.current as AnyHandler)(position)),
    [register, id],
  );
}

/** Radix sets these on every open dialog, sheet, popover and dropdown menu. */
const OPEN_OVERLAY = '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]';

const overlayOpen = () => document.querySelector(OPEN_OVERLAY) !== null;

type Pill = { kind: "pending" } | { kind: "unbound" | "off"; key: string };

/**
 * The shortcut layer (`docs/design/10-keyboard.md`): the command handlers, the ⌘K leader, the
 * status pill and the help dialog. Its one `keydown` listener is on `window` in the capture phase,
 * ahead of Radix's document-level Escape listener and React's root listener, so a swallowed key
 * reaches neither the composer nor an open dialog.
 */
export function KeyboardProvider({ children }: { children: ReactNode }) {
  const handlers = useRef(new Map<CommandId, AnyHandler>());
  const [pill, setPill] = useState<Pill | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const register = useCallback((id: CommandId, handler: AnyHandler) => {
    handlers.current.set(id, handler);
    return () => {
      if (handlers.current.get(id) === handler) handlers.current.delete(id);
    };
  }, []);
  const keyboard = useMemo(() => ({ register, openHelp: () => setHelpOpen(true) }), [register]);

  useEffect(() => register("help.toggle", () => setHelpOpen((open) => !open)), [register]);

  useEffect(() => {
    if (pill === null || pill.kind === "pending") return;
    const timer = setTimeout(() => setPill(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [pill]);

  useEffect(() => {
    let pending = false;
    /** The `code` of the second key last taken, whose auto-repeats are swallowed too. */
    let taken: string | undefined;
    const cancel = () => {
      taken = undefined;
      if (!pending) return;
      pending = false;
      setPill(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Chrome's autofill dispatches keydowns with no `key`.
      if (typeof event.key !== "string") return;
      if (isComposing(event)) {
        cancel();
        return;
      }
      const swallow = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (taken !== undefined) {
        if (event.repeat && event.code === taken) {
          swallow();
          return;
        }
        taken = undefined;
      }
      const platform = detectPlatform();
      const keymap = keymapFor(detectContext(), hasSafariRules());
      const key = keyOf(event);
      if (!pending) {
        if (isLeader(event, platform)) {
          swallow();
          pending = true;
          setPill({ kind: "pending" });
          return;
        }
        if (key === undefined || !hasModifierOnly(event, platform) || overlayOpen()) return;
        const binding = keymap.direct.get(key);
        const handler = binding && handlers.current.get(binding.command);
        if (!binding || !handler) return;
        swallow();
        handler(binding.position);
        return;
      }
      if (isBareModifier(event)) return;
      // A held leader's repeats are swallowed too: Chrome binds Ctrl+K on Windows.
      swallow();
      if (event.repeat && isLeader(event, platform)) return;
      pending = false;
      taken = event.code;
      if (event.key === "Escape") {
        setPill(null);
        return;
      }
      const binding =
        key !== undefined && isPlainOrModified(event, platform)
          ? keymap.leader.get(key)
          : undefined;
      const handler = binding && handlers.current.get(binding.command);
      if (!binding || !handler) {
        setPill({ kind: "unbound", key: keyLabel(event, platform) });
      } else if (binding.command !== "help.toggle" && overlayOpen()) {
        setPill({ kind: "off", key: keyLabel(event, platform) });
      } else {
        setPill(null);
        handler(binding.position);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  return (
    <KeyboardContext.Provider value={keyboard}>
      {children}
      {pill && createPortal(<StatusPill pill={pill} />, document.body)}
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </KeyboardContext.Provider>
  );
}

/**
 * The pending leader, or a brief notice: bottom-right, clear of the composer, above dialogs.
 * Mounted only while shown. The explicit `aria-live` keeps it out of a modal's `hideOthers`, which
 * spares live regions, when the modal opens while it shows.
 */
function StatusPill({ pill }: { pill: Pill }) {
  const leader = leaderLabel(detectPlatform());
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-[100] flex items-center gap-1.5 rounded-lg border border-input bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
    >
      {pill.kind === "pending" ? (
        <>
          <Kbd>{leader}</Kbd> … <Kbd>Esc</Kbd> to cancel
        </>
      ) : (
        <>
          <Kbd>{leader}</Kbd> <Kbd>{pill.key}</Kbd>
          {pill.kind === "unbound" ? ": not a command" : " is off while a dialog is open"}
        </>
      )}
    </div>
  );
}

/** One section's commands, each with its keys. */
function ShortcutTable({
  section,
  keymap,
  platform,
}: {
  section: Command["section"];
  keymap: Keymap;
  platform: Platform;
}) {
  const labelId = useId();
  return (
    <section className="flex flex-col gap-1">
      <h3 id={labelId} className="text-xs font-medium text-muted-foreground">
        {section}
      </h3>
      <table aria-labelledby={labelId} className="w-full">
        <tbody>
          {COMMANDS.filter((command) => command.section === section).map((command) => (
            <tr key={command.id}>
              <td className="py-1 pr-4">{command.title}</td>
              <td className="py-1 text-right">
                {shortcutsFor(command.id, keymap, platform).map((keys, index) => (
                  <span
                    key={keys.join(" ")}
                    className={cn("whitespace-nowrap", index > 0 && "ml-3")}
                  >
                    {keys.map((key, at) => (
                      <span key={key}>
                        {at > 0 && " "}
                        <Kbd>{key}</Kbd>
                      </span>
                    ))}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The commands by section, with the current platform's and context's keys. */
function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const platform = detectPlatform();
  const safariRules = hasSafariRules();
  const keymap = keymapFor(detectContext(), safariRules);
  const leader = leaderLabel(platform);
  const modifier = modifierLabel(platform);
  const sections = [...new Set(COMMANDS.map((command) => command.section))];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press <Kbd>{leader}</Kbd>, then a key, with or without {modifier} held. <Kbd>Esc</Kbd>{" "}
            cancels.
          </DialogDescription>
        </DialogHeader>
        {sections.map((section) => (
          <ShortcutTable key={section} section={section} keymap={keymap} platform={platform} />
        ))}
        {safariRules && (
          <p className="text-xs text-muted-foreground">
            After {leader}, press the digit without {modifier}: this browser keeps{" "}
            {chordLabel(platform, "1–9")} for itself.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Opens the help dialog. */
export function ShortcutsButton({ className }: { className?: string }) {
  const { openHelp } = useKeyboard();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Keyboard shortcuts"
      title="Keyboard shortcuts"
      className={className}
      onClick={openHelp}
    >
      <KeyboardIcon />
    </Button>
  );
}
