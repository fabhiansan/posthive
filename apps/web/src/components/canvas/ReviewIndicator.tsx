"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";
import { reviewSummaryCount } from "@/lib/canvas";

/** How often the design team's indicator asks while the tab is visible. */
export const POLL_MS = 60_000;
const SEEN_KEY = "canvas-reviews-seen";

// A per-viewer convenience only: where this browser last looked at the queue. Every access is in try/catch because storage can
// be blocked or throw (a private window, cleared site data); the indicator works without it, it just never shows the dot.
const readSeen = (): string | null => {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
};
/** Records that the queue was looked at, up to the newest submission seen. Called by the reviews page. */
export function markReviewsSeen(latestSubmittedAt: string | null): void {
  if (!latestSubmittedAt) return;
  try {
    window.localStorage.setItem(SEEN_KEY, latestSubmittedAt);
  } catch {
    /* a convenience only */
  }
}

/** Something newer than the last look. (ISO timestamps compare as text.) */
export const hasUnseen = (latest: string | null, seen: string | null): boolean => latest !== null && (seen === null || latest > seen);

/**
 * The design team's way into the review queue, with how many designs wait. Polls the summary every minute while the tab is
 * visible and again when it is focused; when the count goes UP it says so once. A failed poll changes nothing.
 * In an editor, pass `beforeLeave` (the editor's save-first guard, the one its back link uses): a plain click then waits for the
 * save, and asks before throwing unsaved changes away, like leaving to the dashboard does. A click that opens a new tab does not.
 */
export function ReviewIndicator({ beforeLeave }: { beforeLeave?: () => Promise<boolean> } = {}) {
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<{ pending: number; latest: string | null } | null>(null);
  const last = useRef<number | null>(null);

  const poll = useCallback(async () => {
    try {
      const { pending, latestSubmittedAt } = await reviewSummaryCount();
      if (last.current !== null && pending > last.current) toast.success("New design submitted for review");
      last.current = pending;
      setState({ pending, latest: latestSubmittedAt });
    } catch {
      /* keep what is shown: the next poll tries again */
    }
  }, [toast]);

  useEffect(() => {
    void poll();
    const tick = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, POLL_MS);
    const wake = () => {
      if (document.visibilityState === "visible") void poll();
    };
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(tick);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [poll]);

  const pending = state?.pending ?? 0;
  const dot = state ? hasUnseen(state.latest, readSeen()) : false;
  return (
    <Button asChild variant="ghost" size="sm">
      <Link
        href="/canvas/reviews"
        aria-label={pending > 0 ? `Reviews, ${pending} waiting` : "Reviews"}
        onClick={async (e) => {
          if (!beforeLeave || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          if (await beforeLeave()) router.push("/canvas/reviews");
        }}
      >
        <ClipboardCheckIcon />
        <span className="hidden sm:inline">Reviews</span>
        {pending > 0 && (
          <span className="relative inline-flex min-w-5 items-center justify-center rounded-full bg-brand-100 px-1.5 type-body-sb-xs text-brand-800">
            {pending}
            {dot && <span aria-hidden data-testid="unseen-dot" className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-red-600" />}
          </span>
        )}
      </Link>
    </Button>
  );
}
