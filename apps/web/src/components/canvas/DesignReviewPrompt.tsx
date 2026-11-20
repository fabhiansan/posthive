"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { Textarea } from "@/components/ui/textarea";
import { canSubmitReview, getInstance, submitInstance, type ReviewSummary } from "@/lib/canvas";

/** Mirrors the API's limit on a note. */
export const NOTE_MAX = 500;

const PARAM = "design";

type Phase = "confirm" | "done" | null;
interface Target {
  id: string;
  name: string;
  version: number;
  review: ReviewSummary;
}
type Load = { status: "loading" } | { status: "ready"; target: Target } | { status: "problem"; message: string };

/** What the person is told for each way a submission can be refused. Anything else is the server's own sentence. */
export function submitProblem(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  const code = (err as { data?: { code?: string } } | null)?.data?.code;
  const sent = (err as { data?: { error?: string } } | null)?.data?.error;
  if (code === "NO_CHANGES") return "Nothing has changed since you last submitted this design.";
  if (code === "NO_REVIEWER") return "This workspace has no designer to review designs yet. Ask an admin to invite one.";
  if (code === "VERSION_CONFLICT") return "This design was changed somewhere else. Open it again and try again.";
  if (code === "DESIGN_ARCHIVED") return "This design was archived, so it can't be submitted.";
  if (code === "UNKNOWN_ASSET") return "An image in this design is no longer available. Replace it and try again.";
  if (status === 429) return "You are submitting too fast. Wait a moment and try again.";
  if (status === 404) return "This design doesn't exist any more.";
  return sent ?? (err instanceof Error ? err.message : "The design could not be submitted.");
}

/** The same address without the review parameter, and everything else (a template, a hash) left exactly as it was. */
function withoutParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The hand-off from the Canvas editor: /compose?design=<id>. It asks the person to confirm ("Submit for design Review"), with
 * an optional note, then submits the SAVED design and says so. Nothing else on the page is touched: it reads one address
 * parameter, leaves every other one alone (Compose's own ?template= handling), and renders nothing at all without it.
 */
export function DesignReviewPrompt() {
  const router = useRouter();
  const toast = useToast();
  const [id, setId] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [phase, setPhase] = useState<Phase>(null);
  const [note, setNote] = useState("");
  const submitted = useRef(false);

  // Read the address once, when the page opens: this is a hand-off, not state to keep in sync.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get(PARAM);
    if (requested) {
      setId(requested);
      setPhase("confirm");
    }
  }, []);

  useEffect(() => {
    if (!id) return;
    let live = true;
    getInstance(id).then(
      ({ instance }) => live && setLoad({ status: "ready", target: { id: instance.id, name: instance.name, version: instance.version, review: instance.review } }),
      (err: unknown) => live && setLoad({ status: "problem", message: submitProblem(err) }),
    );
    return () => {
      live = false;
    };
  }, [id]);

  const clearAddress = () => window.history.replaceState(null, "", withoutParam(window.location.href));
  const finish = () => {
    clearAddress();
    setPhase(null);
  };

  if (!id) return null;
  const ready = load.status === "ready" ? load.target : null;
  const can = ready ? canSubmitReview(ready.review) : false;
  const replaces = ready?.review.latestReviewStatus === "pending" && can;

  async function confirm() {
    if (!ready) return;
    try {
      await submitInstance(ready.id, ready.version, note.trim() || undefined);
    } catch (err) {
      toast.error(submitProblem(err));
      throw err; // keeps the dialog open: the person can fix it and try again
    }
    toast.success("Submitted to Design Team");
    submitted.current = true;
    setPhase("done");
  }

  return (
    <>
      <ConfirmDialog
        open={phase === "confirm"}
        onOpenChange={(open) => {
          if (open || submitted.current) return; // a successful submit closes this dialog too, but has already moved on to "done"
          finish(); // Cancel or Esc
        }}
        tone="default"
        title="Submit for design Review"
        description={
          load.status === "loading"
            ? "Loading your design…"
            : load.status === "problem"
              ? load.message
              : `“${load.target.name}” (saved version ${load.target.version}) goes to the design team to approve or send back with comments.`
        }
        confirmLabel="Submit"
        pendingLabel="Submitting…"
        confirmDisabled={!ready || !can}
        onConfirm={confirm}
      >
        {ready && !can && <p className="type-body-r-s text-muted">Nothing has changed since you last submitted this design.</p>}
        {replaces && <p className="type-body-r-s text-muted">This replaces your pending submission.</p>}
        {ready && can && (
          <div className="flex flex-col gap-1">
            <label htmlFor="review-note" className="type-body-sb-s text-fg">
              Note for the designer (optional)
            </label>
            <Textarea id="review-note" rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should they look at?" />
            <span className="type-body-r-xs text-muted">
              {note.length} / {NOTE_MAX}
            </span>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={phase === "done"}
        onOpenChange={(open) => {
          if (!open) finish();
        }}
        tone="default"
        title="Submitted to Design Team"
        description="The designers will approve it or send it back with comments. You can keep editing: the answer stays on this submission, and new changes need their own review."
        confirmLabel="Back to my design"
        cancelLabel="Stay in Compose"
        onConfirm={() => {
          clearAddress();
          if (ready) router.push(`/canvas/${encodeURIComponent(ready.id)}`);
        }}
      />
    </>
  );
}
