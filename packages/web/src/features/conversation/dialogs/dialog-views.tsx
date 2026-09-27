import type { DialogRequest } from "@pi-code/protocol";
import { type ReactNode, useState } from "react";
import { LinkifiedText } from "@/components/linkified-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CountdownBadge } from "./countdown";

export type DialogAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

interface ViewProps<M extends DialogRequest["method"]> {
  request: Extract<DialogRequest, { method: M }>;
  /** Server-side expiry (ms since epoch), for the countdown. */
  expiresAt: number | undefined;
  busy: boolean;
  onAnswer(answer: DialogAnswer): void;
}

function Header({
  title,
  expiresAt,
  children,
}: {
  title: string;
  expiresAt: number | undefined;
  children?: ReactNode;
}) {
  return (
    <SheetHeader className="pr-12">
      <div className="flex items-start justify-between gap-2">
        <SheetTitle className="min-w-0">
          <LinkifiedText text={title} />
        </SheetTitle>
        <CountdownBadge expiresAt={expiresAt} />
      </div>
      {children}
    </SheetHeader>
  );
}

export function SelectDialogView({ request, expiresAt, busy, onAnswer }: ViewProps<"select">) {
  return (
    <>
      <Header title={request.title} expiresAt={expiresAt}>
        <SheetDescription className="sr-only">Choose an option</SheetDescription>
      </Header>
      <div className="flex max-h-[50dvh] flex-col gap-1 overflow-y-auto px-4" role="listbox">
        {request.options.map((option) => (
          <Button
            key={option}
            role="option"
            aria-selected={false}
            variant="outline"
            disabled={busy}
            className="h-auto min-h-10 justify-start py-2 text-left whitespace-normal"
            onClick={() => onAnswer({ value: option })}
          >
            {option}
          </Button>
        ))}
      </div>
      <SheetFooter>
        <Button variant="ghost" disabled={busy} onClick={() => onAnswer({ cancelled: true })}>
          Cancel
        </Button>
      </SheetFooter>
    </>
  );
}

export function ConfirmDialogView({ request, expiresAt, busy, onAnswer }: ViewProps<"confirm">) {
  return (
    <>
      <Header title={request.title} expiresAt={expiresAt}>
        <SheetDescription asChild>
          <div className="text-sm text-muted-foreground">
            <LinkifiedText text={request.message} />
          </div>
        </SheetDescription>
      </Header>
      <SheetFooter className="flex-row justify-end">
        <Button variant="outline" disabled={busy} onClick={() => onAnswer({ confirmed: false })}>
          No
        </Button>
        <Button disabled={busy} onClick={() => onAnswer({ confirmed: true })}>
          Yes
        </Button>
      </SheetFooter>
    </>
  );
}

export function InputDialogView({ request, expiresAt, busy, onAnswer }: ViewProps<"input">) {
  const [value, setValue] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer({ value });
      }}
    >
      <Header title={request.title} expiresAt={expiresAt}>
        <SheetDescription className="sr-only">Enter a value</SheetDescription>
      </Header>
      <div className="px-4">
        <Input
          aria-label={request.title}
          autoFocus
          value={value}
          placeholder={request.placeholder}
          onChange={(event) => setValue(event.target.value)}
          className="h-10 text-base"
        />
      </div>
      <SheetFooter className="flex-row justify-end">
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => onAnswer({ cancelled: true })}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          Submit
        </Button>
      </SheetFooter>
    </form>
  );
}

export function EditorDialogView({ request, expiresAt, busy, onAnswer }: ViewProps<"editor">) {
  const [value, setValue] = useState(request.prefill ?? "");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header title={request.title} expiresAt={expiresAt}>
        <SheetDescription className="sr-only">Edit the text</SheetDescription>
      </Header>
      <div className="flex min-h-0 flex-1 px-4">
        <textarea
          aria-label={request.title}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="min-h-0 flex-1 resize-none rounded-lg border bg-transparent p-3 font-mono text-sm outline-none focus-visible:border-ring"
        />
      </div>
      <SheetFooter className="flex-row justify-end">
        <Button variant="ghost" disabled={busy} onClick={() => onAnswer({ cancelled: true })}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={() => onAnswer({ value })}>
          Submit
        </Button>
      </SheetFooter>
    </div>
  );
}
