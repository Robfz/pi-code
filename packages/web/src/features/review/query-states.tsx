/** Query options and states shared by the review panel's views. */

import { FileIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiRequestError, errorMessage } from "@/lib/api";

/** Client errors (an unknown base, not a repo) won't change on a retry. */
export const retryServerErrors = (count: number, error: unknown) =>
  !(error instanceof ApiRequestError && error.status < 500) && count < 1;

export function NotARepo() {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
      <FileIcon className="size-6" />
      <p>This project isn't a git repository.</p>
    </div>
  );
}

/** "Couldn't load `what`" with the error and a Retry button. */
export function LoadError({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: unknown;
  onRetry(): void;
}) {
  return (
    <div className="flex flex-col items-start gap-2 text-sm">
      <p className="text-destructive">
        Couldn't load {what}: {errorMessage(error)}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
