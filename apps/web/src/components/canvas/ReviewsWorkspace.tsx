"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArchiveIcon, CheckIcon, CircleAlertIcon, MessageSquareWarningIcon } from "lucide-react";
import { Spinner } from "@/components/Spinner";
import { useToast } from "@/components/Toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { decideReview, formatWhen as when, getReview, listReviews, reviewSummaryCount, type ReviewDetail, type ReviewQueueEntry } from "@/lib/canvas";
import { ReadOnlyStage } from "./ReadOnlyStage";
import { StatusChip } from "./ReviewChips";
import { markReviewsSeen } from "./ReviewIndicator";
import { assetIdsOf, useOpenedDesign, type DesignSource, type Openable } from "./useCanvasBootstrap";

/** Mirrors the API's limit on a comment. */
export const COMMENT_MAX = 2000;

type View = "pending" | "decided";
type Listing = { status: "loading" } | { status: "error" } | { status: "ready"; items: ReviewQueueEntry[]; next: string | null; more: "idle" | "loading" | "error" };

/** Words for a decision that could not be made. */
export function decisionProblem(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  const code = (err as { data?: { code?: string } } | null)?.data?.code;
  const sent = (err as { data?: { error?: string } } | null)?.data?.error;
  if (code === "NOT_PENDING") return "This review was already answered, or a newer submission replaced it. The list was refreshed.";
  if (status === 404) return "This review no longer exists.";
  if (status === 429) return "You are answering too fast. Wait a moment and try again.";
  return sent ?? (err instanceof Error ? err.message : "The answer could not be saved.");
}

/**
 * The design team's review page: the queue on one side (waiting, or already answered), one submission on the other, drawn
 * read-only exactly as it was submitted, with what changed and the way to approve it or send it back. The selected review is
 * in the address (?review=<id>), so a link opens it. Needs a Suspense boundary above it (it reads the address).
 */
export function ReviewsWorkspace() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const selected = params.get("review");
  const [view, setView] = useState<View>("pending");
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [revision, setRevision] = useState(0); // bumped after an answer: the detail loads again
  const generation = useRef(0); // which load the list on screen belongs to: a late "Load more" from an older one (another tab, a refresh) is dropped

  useEffect(() => {
    reviewSummaryCount().then((s) => markReviewsSeen(s.latestSubmittedAt), () => {});
  }, []);

  useEffect(() => {
    let live = true;
    generation.current++;
    setListing({ status: "loading" });
    listReviews(view).then(
      ({ reviews, nextCursor }) => live && setListing({ status: "ready", items: reviews, next: nextCursor, more: "idle" }),
      () => live && setListing({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, [view, attempt]);

  const open = useCallback((id: string | null) => router.replace(id ? `/canvas/reviews?review=${encodeURIComponent(id)}` : "/canvas/reviews"), [router]);

  async function more() {
    if (listing.status !== "ready" || !listing.next || listing.more === "loading") return;
    const cursor = listing.next;
    const mine = generation.current;
    setListing({ ...listing, more: "loading" });
    try {
      const page = await listReviews(view, cursor);
      if (mine !== generation.current) return; // the view changed or the list was read again meanwhile: this page belongs to another list
      setListing((l) => {
        if (l.status !== "ready") return l;
        const shown = new Set(l.items.map((i) => i.id));
        return { status: "ready", items: [...l.items, ...page.reviews.filter((r) => !shown.has(r.id))], next: page.nextCursor, more: "idle" };
      });
    } catch {
      if (mine === generation.current) setListing((l) => (l.status === "ready" ? { ...l, more: "error" } : l));
    }
  }

  /** Called after an answer, or after the server said it was not pending: both lists and the open detail read again. */
  const refresh = useCallback(() => {
    setAttempt((n) => n + 1);
    setRevision((n) => n + 1);
  }, []);

  /** The open review is not there (another workspace's, or never existed): drop it from the address and read the list again. Only the LIST: the pane is gone, so it must not remount. */
  const gone = useCallback(() => {
    toast.warning("That review is no longer there.");
    open(null);
    setAttempt((n) => n + 1);
  }, [toast, open]);

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <aside className="flex max-h-72 shrink-0 flex-col border-b border-border bg-surface lg:max-h-none lg:w-96 lg:border-r lg:border-b-0">
        <div role="tablist" aria-label="Reviews" className="flex gap-1 border-b border-border p-2">
          {(["pending", "decided"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              type="button"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className="cursor-pointer rounded-lg px-3 py-1.5 type-body-sb-s text-muted outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-ring/40 aria-selected:bg-brand-100 aria-selected:text-brand-800"
            >
              {v === "pending" ? "Waiting" : "Answered"}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {listing.status === "loading" && (
            <p className="flex items-center gap-2 p-4 type-body-r-s text-muted">
              <Spinner label="Loading the reviews" className="text-brand-800" /> Loading
            </p>
          )}
          {listing.status === "error" && (
            <div className="flex flex-col items-start gap-2 p-4">
              <p className="flex items-center gap-2 type-body-r-s text-red-600">
                <CircleAlertIcon aria-hidden className="size-4" /> The reviews didn&apos;t load.
              </p>
              <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </div>
          )}
          {listing.status === "ready" && listing.items.length === 0 && (
            <p className="p-4 type-body-r-s text-muted">{view === "pending" ? "No designs are waiting for review. When Marketing submits one, it appears here." : "Nothing has been answered yet."}</p>
          )}
          {listing.status === "ready" && listing.items.length > 0 && (
            <ul aria-label={view === "pending" ? "Waiting for review" : "Answered"} className="flex flex-col gap-1 p-2">
              {listing.items.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-current={selected === r.id ? "true" : undefined}
                    onClick={() => open(r.id)}
                    className="flex w-full cursor-pointer flex-col items-start gap-1 rounded-lg px-2 py-2 text-left outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-ring/40 aria-[current=true]:bg-brand-100"
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="truncate type-body-sb-s text-fg">{r.name}</span>
                      <StatusChip status={r.status} />
                    </span>
                    <span className="type-body-r-xs text-muted">
                      Submission {r.number} · {r.submitter ?? "Someone"} · {when(r.createdAt)}
                    </span>
                    {r.archivedBySubmitter && (
                      <Badge variant="default">
                        <ArchiveIcon /> Archived by submitter
                      </Badge>
                    )}
                  </button>
                </li>
              ))}
              {listing.next && (
                <li className="flex flex-col items-center gap-2 p-2">
                  {listing.more === "error" && <p className="type-body-r-xs text-red-600">More could not be loaded.</p>}
                  <Button variant="secondary" size="sm" disabled={listing.more === "loading"} onClick={() => void more()}>
                    {listing.more === "error" ? "Try again" : "Load more"}
                  </Button>
                </li>
              )}
            </ul>
          )}
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected ? <ReviewPane key={`${selected}:${revision}`} id={selected} onAnswered={refresh} onGone={gone} /> : <p className="p-6 type-body-r-s text-muted">Choose a design from the list to review it.</p>}
      </main>
    </div>
  );
}

type Opened = Openable & ReviewDetail;

function ReviewPane({ id, onAnswered, onGone }: { id: string; onAnswered(): void; onGone(): void }) {
  const source = useMemo<DesignSource<Opened>>(
    () => ({
      load: async () => {
        const detail = await getReview(id);
        return { ...detail, id, version: 1, name: detail.submission.name, document: detail.submission.document };
      },
      imageIds: (d) => assetIdsOf(d.submission.document),
    }),
    [id],
  );
  const { engine, design, problem, failure } = useOpenedDesign<Opened>(id, source);

  // A review that is not there (another workspace's, or never existed) is the list's cue to forget it: once per pane, however
  // often the parent re-renders (the address change that follows is asynchronous).
  const told = useRef(false);
  useEffect(() => {
    if (problem === "not-found" && !told.current) {
      told.current = true;
      onGone();
    }
  }, [problem, onGone]);

  if (problem) return <p className="p-6 type-body-r-s text-muted">{problem === "forbidden" ? "Reviews are for the design team." : "This submission can't be shown."}</p>;
  if (failure) {
    return (
      <p className="p-6 type-body-r-s text-red-600">
        {failure.message}{" "}
        <button type="button" className="cursor-pointer underline underline-offset-2" onClick={failure.retry}>
          Try again
        </button>
      </p>
    );
  }
  if (!engine || !design) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label="Loading the submission" className="text-brand-800" />
      </div>
    );
  }
  const { review, submission, changes, rename, history, archivedBySubmitter } = design;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 xl:flex-row xl:overflow-hidden">
      <div className="flex min-h-80 min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="type-body-sb-m text-fg">{submission.name}</h2>
          <StatusChip status={review.status} />
          {archivedBySubmitter && (
            <Badge variant="default">
              <ArchiveIcon /> Archived by submitter
            </Badge>
          )}
        </div>
        <p className="type-body-r-xs text-muted">
          Submission {submission.number} by {submission.submitter ?? "someone"} · {when(submission.createdAt)} · Based on revision {submission.baseRevision.number}
        </p>
        <div className="min-h-0 flex-1">
          <ReadOnlyStage engine={engine} doc={submission.document} images={design.images} />
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-4 xl:w-80 xl:overflow-y-auto">
        {submission.note && (
          <section aria-label="Note from the submitter" className="rounded-xl border border-border bg-surface p-3">
            <p className="type-body-sb-xs text-muted">Note</p>
            <p className="type-body-r-s whitespace-pre-wrap text-fg">{submission.note}</p>
          </section>
        )}

        <section aria-labelledby="changes-heading" className="flex flex-col gap-2">
          <h3 id="changes-heading" className="type-body-sb-s text-fg">
            What changed
          </h3>
          {changes.length === 0 && !rename ? (
            <p className="type-body-r-s text-muted">{submission.number === 1 ? "Nothing was changed from the published revision." : "Nothing differs from the previous submission."}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rename && (
                <li className="rounded-xl border border-border bg-surface p-3 type-body-r-s">
                  <p className="type-body-sb-s text-fg">Design name</p>
                  <p className="text-muted line-through">{rename.before}</p>
                  <p className="text-fg">{rename.after}</p>
                </li>
              )}
              {changes.map((c) => (
                <li key={c.nodeId} className="rounded-xl border border-border bg-surface p-3 type-body-r-s">
                  <p className="type-body-sb-s text-fg">{c.name}</p>
                  {c.kind === "text" ? (
                    <>
                      <p className="text-muted line-through">{c.before || "(empty)"}</p>
                      <p className="whitespace-pre-wrap text-fg">{c.after || "(empty)"}</p>
                    </>
                  ) : (
                    <p className="text-muted">Image replaced</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <DecisionPanel key={review.status} review={review} onAnswered={onAnswered} />

        {history.length > 1 && (
          <section aria-labelledby="history-heading" className="flex flex-col gap-1">
            <h3 id="history-heading" className="type-body-sb-s text-fg">
              Earlier submissions
            </h3>
            <ul className="flex flex-col gap-1">
              {history.map((h) => (
                <li key={h.number} className="flex items-center justify-between gap-2 type-body-r-xs text-muted">
                  <span>
                    Submission {h.number} · {when(h.createdAt)}
                  </span>
                  {h.status && <StatusChip status={h.status} />}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function DecisionPanel({ review, onAnswered }: { review: ReviewDetail["review"]; onAnswered(): void }) {
  const toast = useToast();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"approve" | "request_changes" | null>(null);

  if (review.status !== "pending") {
    return (
      <section aria-label="Answer" className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-3">
        <p className="type-body-sb-s text-fg">
          {review.status === "approved" ? "Approved" : review.status === "changes_requested" ? "Changes requested" : "Replaced by a newer submission"}
          {review.reviewer ? ` by ${review.reviewer}` : ""}
        </p>
        {review.decidedAt && <p className="type-body-r-xs text-muted">{when(review.decidedAt)}</p>}
        {review.comment && <p className="type-body-r-s whitespace-pre-wrap text-fg">{review.comment}</p>}
      </section>
    );
  }

  async function answer(decision: "approve" | "request_changes") {
    setBusy(decision);
    try {
      await decideReview(review.id, decision, comment.trim() || undefined);
      toast.success(decision === "approve" ? "Approved" : "Sent back with your comment");
      onAnswered();
    } catch (err) {
      toast.error(decisionProblem(err));
      // The review is no longer pending (answered elsewhere, or replaced): show what is true now.
      if ((err as { data?: { code?: string } } | null)?.data?.code === "NOT_PENDING") onAnswered();
    } finally {
      setBusy(null);
    }
  }

  const blank = comment.trim() === "";
  return (
    <section aria-label="Answer" className="flex flex-col gap-2">
      <label htmlFor="review-comment" className="type-body-sb-s text-fg">
        Comment
      </label>
      <Textarea id="review-comment" rows={4} maxLength={COMMENT_MAX} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Required to ask for changes" />
      <span className="type-body-r-xs text-muted">
        {comment.length} / {COMMENT_MAX}
      </span>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void answer("approve")} disabled={busy !== null}>
          {busy === "approve" ? <Spinner size="sm" label="Approving" /> : <CheckIcon />} Approve
        </Button>
        <Button variant="secondary" onClick={() => void answer("request_changes")} disabled={busy !== null || blank} title={blank ? "Say what needs to change." : undefined}>
          {busy === "request_changes" ? <Spinner size="sm" label="Sending" /> : <MessageSquareWarningIcon />} Request changes
        </Button>
      </div>
    </section>
  );
}
