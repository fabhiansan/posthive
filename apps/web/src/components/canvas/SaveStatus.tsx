"use client";

import Link from "next/link";
import { CheckIcon, CircleAlertIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/Spinner";
import type { AutosaveInfo } from "@/lib/autosave";
import { cn } from "@/lib/cn";

// On a narrow screen the words give way to their icon (the text stays for screen readers), so the state never disappears.
const Words = ({ children, className }: { children: React.ReactNode; className?: string }) => <span className={cn("max-sm:sr-only", className)}>{children}</span>;

/** The save state in the top bar: one short phrase, announced politely. */
export function SaveStatus({ info, onRetry }: { info: AutosaveInfo; onRetry(): void }) {
  const { state, message } = info;
  let body: React.ReactNode;
  switch (state) {
    case "saved":
      body = (
        <>
          <CheckIcon className="size-3.5 text-green-700" /> <Words>Saved</Words>
        </>
      );
      break;
    case "dirty":
      body = (
        <>
          <span aria-hidden className="size-2 rounded-full bg-brand-500" /> <Words>Unsaved changes</Words>
        </>
      );
      break;
    case "saving":
      body = (
        <>
          <Spinner size="sm" label="Saving" /> <Words>Saving…</Words>
        </>
      );
      break;
    case "retrying":
      body = (
        <>
          <CircleAlertIcon className="size-3.5 shrink-0 text-red-600" /> <Words className="text-red-600">Couldn&apos;t save, trying again…</Words>
        </>
      );
      break;
    case "failed":
    case "session":
      body = (
        <>
          <CircleAlertIcon className="size-3.5 shrink-0 text-red-600" /> <Words className="text-red-600">Not saved</Words>
          <Button variant="link" size="sm" className="h-auto p-0" onClick={onRetry}>
            Retry
          </Button>
        </>
      );
      break;
    case "rejected":
      body = (
        <>
          <CircleAlertIcon className="size-3.5 shrink-0 text-red-600" /> <Words className="truncate text-red-600">{message ?? "Not saved"}</Words>
        </>
      );
      break;
    default: // conflict, deleted, archived, forbidden: the banner says why
      body = (
        <>
          <CircleAlertIcon className="size-3.5 shrink-0 text-red-600" /> <Words className="text-red-600">Not saved</Words>
        </>
      );
  }
  return (
    <p aria-live="polite" className="flex max-w-64 min-w-0 items-center gap-1.5 type-body-r-xs text-muted">
      {body}
    </p>
  );
}

/** The states where saving has stopped and the person must be told why (and given the way out). */
export const needsBanner = (state: AutosaveInfo["state"]): boolean => state === "conflict" || state === "deleted" || state === "archived" || state === "forbidden" || state === "session";

/** What the person must know when saving has stopped for good: a notice under the top bar, with the way out. */
export function SaveBanner({ state, onReload, onRetry }: { state: AutosaveInfo["state"]; onReload(): void; onRetry(): void }) {
  if (state === "conflict") {
    return (
      <Alert variant="warning">
        <TriangleAlertIcon />
        <AlertTitle>This design was changed somewhere else</AlertTitle>
        <AlertDescription>
          <p>Your changes here are not saved, and saving is paused so that nothing is overwritten. Reload to see the latest version: your unsaved changes here are discarded. You can still export this one.</p>
          <Button size="sm" variant="secondary" onClick={onReload}>
            Reload latest
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (state === "deleted" || state === "forbidden") {
    return (
      <Alert variant="danger">
        <CircleAlertIcon />
        <AlertTitle>{state === "deleted" ? "This design was deleted" : "You can't save designs here"}</AlertTitle>
        <AlertDescription>
          <p>{state === "deleted" ? "It no longer exists, so your latest changes cannot be saved. You can still export it." : "Designs are managed by the design team."}</p>
          <Button asChild size="sm" variant="secondary">
            <Link href="/canvas">Back to Canvas</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (state === "archived") {
    return (
      <Alert variant="warning">
        <TriangleAlertIcon />
        <AlertTitle>This design was archived</AlertTitle>
        <AlertDescription>
          <p>It can no longer be edited or submitted, so your latest changes cannot be saved. You can still export it. What you submitted and the answers stay in its history.</p>
          <Button asChild size="sm" variant="secondary">
            <Link href="/canvas">Back to Canvas</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (state === "session") {
    return (
      <Alert variant="warning">
        <TriangleAlertIcon />
        <AlertTitle>Your session ended</AlertTitle>
        <AlertDescription>
          <p>Your changes are not saved yet. Sign in again (in another tab if you like), then try again.</p>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}
