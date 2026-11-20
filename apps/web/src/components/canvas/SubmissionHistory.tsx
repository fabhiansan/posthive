"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, ArchiveIcon, CircleAlertIcon } from "lucide-react";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/ui/button";
import { formatWhen as when, getSubmission, listSubmissions, type SubmissionDetail, type SubmissionEntry } from "@/lib/canvas";
import { useBootNone } from "./CanvasBoot";
import { StatusChip } from "./ReviewChips";
import { ReadOnlyStage } from "./ReadOnlyStage";
import { assetIdsOf, useOpenedDesign, type DesignSource, type Openable } from "./useCanvasBootstrap";

type Listing =
  | { status: "loading" }
  | { status: "error"; missing: boolean }
  | { status: "ready"; items: SubmissionEntry[]; next: string | null; more: "idle" | "loading" | "error"; archived: boolean };

/**
 * What I submitted for one of my designs, newest first, and each submission as it was submitted (read-only), with the design
 * team's answer and the reviewer's NAME ("Former team member" when that account no longer exists). It reads the snapshots, not
 * the design, so it works for an archived design too, and the server says whether it is archived.
 */
export function SubmissionHistory({ designId }: { designId: string }) {
  useBootNone(); // this page opens no editor, so the first-open loader must not wait for one (it can be the first page opened)
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const generation = useRef(0); // which load the list on screen belongs to: a late "Load more" from an older one is dropped

  useEffect(() => {
    let live = true;
    generation.current++;
    listSubmissions(designId).then(
      ({ submissions, nextCursor, archived }) => {
        if (!live) return;
        setListing({ status: "ready", items: submissions, next: nextCursor, more: "idle", archived });
        setSelected((s) => s ?? submissions[0]?.number ?? null); // the newest, until the person picks another
      },
      (err: unknown) => live && setListing({ status: "error", missing: (err as { status?: number } | null)?.status === 404 }),
    );
    return () => {
      live = false;
    };
  }, [designId, attempt]);

  const loadMore = useCallback(async () => {
    if (listing.status !== "ready" || !listing.next || listing.more === "loading") return;
    const cursor = listing.next;
    const mine = generation.current;
    setListing({ ...listing, more: "loading" });
    try {
      const page = await listSubmissions(designId, cursor);
      if (mine !== generation.current) return;
      setListing((l) => {
        if (l.status !== "ready") return l;
        const shown = new Set(l.items.map((i) => i.number));
        return { ...l, items: [...l.items, ...page.submissions.filter((s) => !shown.has(s.number))], next: page.nextCursor, more: "idle" };
      });
    } catch {
      if (mine === generation.current) setListing((l) => (l.status === "ready" ? { ...l, more: "error" } : l));
    }
  }, [designId, listing]);

  const archived = listing.status === "ready" && listing.archived;

  return (
    <div className="theme-dashboard flex h-dvh flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/canvas">
            <ArrowLeftIcon /> Canvas
          </Link>
        </Button>
        <h1 className="type-body-sb-m text-fg">Submission history</h1>
      </header>

      {archived && (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-4 py-2 type-body-r-s text-muted">
          <ArchiveIcon aria-hidden className="size-4 shrink-0" />
          This design was archived. It can no longer be edited or submitted; what you submitted and the answers stay here.
        </div>
      )}

      {listing.status === "loading" && (
        <div className="flex flex-1 items-center justify-center gap-2 type-body-r-s text-muted">
          <Spinner label="Loading the history" className="text-brand-800" /> Loading the history
        </div>
      )}
      {listing.status === "error" && listing.missing && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <CircleAlertIcon aria-hidden className="size-6 text-muted" />
          <p className="type-body-r-s text-muted">This design doesn&apos;t exist, or it isn&apos;t yours.</p>
          <Button asChild variant="secondary">
            <Link href="/canvas">Back to Canvas</Link>
          </Button>
        </div>
      )}
      {listing.status === "error" && !listing.missing && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <CircleAlertIcon aria-hidden className="size-6 text-red-600" />
          <p className="type-body-r-s text-muted">The history didn&apos;t load. Check your connection and try again.</p>
          <Button
            variant="secondary"
            onClick={() => {
              setListing({ status: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      )}

      {listing.status === "ready" && listing.items.length === 0 && <p className="p-6 type-body-r-s text-muted">Nothing was submitted for this design yet.</p>}

      {listing.status === "ready" && listing.items.length > 0 && (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <aside className="max-h-64 shrink-0 overflow-y-auto border-b border-border bg-surface lg:max-h-none lg:w-80 lg:border-r lg:border-b-0">
            <ul aria-label="Submissions" className="flex flex-col gap-1 p-2">
              {listing.items.map((s) => (
                <li key={s.number}>
                  <button
                    type="button"
                    aria-current={selected === s.number ? "true" : undefined}
                    onClick={() => setSelected(s.number)}
                    className="flex w-full cursor-pointer flex-col items-start gap-1 rounded-lg px-2 py-2 text-left outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-ring/40 aria-[current=true]:bg-brand-100"
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="type-body-sb-s text-fg">Submission {s.number}</span>
                      {s.status && <StatusChip status={s.status} />}
                    </span>
                    <span className="type-body-r-xs text-muted">{when(s.createdAt)}</span>
                    {s.reviewer && <span className="type-body-r-xs text-muted">Answered by {s.reviewer}</span>}
                  </button>
                </li>
              ))}
            </ul>
            {listing.next && (
              <div className="flex flex-col items-center gap-2 p-2">
                {listing.more === "error" && <p className="type-body-r-xs text-red-600">More could not be loaded.</p>}
                <Button variant="secondary" size="sm" disabled={listing.more === "loading"} onClick={() => void loadMore()}>
                  {listing.more === "error" ? "Try again" : "Load more"}
                </Button>
              </div>
            )}
          </aside>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
            {selected !== null && <SubmissionPane key={selected} designId={designId} number={selected} entry={listing.items.find((s) => s.number === selected) ?? null} />}
          </main>
        </div>
      )}
    </div>
  );
}

type Opened = Openable & SubmissionDetail;

/** One submission, drawn read-only, with the note it carried and the designer's answer. Keyed by the number: it loads once per submission. */
function SubmissionPane({ designId, number, entry }: { designId: string; number: number; entry: SubmissionEntry | null }) {
  const source = useMemo<DesignSource<Opened>>(
    () => ({
      load: async () => ({ ...(await getSubmission(designId, number)).submission, id: designId, version: number }),
      imageIds: (s) => assetIdsOf(s.document),
    }),
    [designId, number],
  );
  const { engine, design, problem, failure } = useOpenedDesign<Opened>(designId, source);
  return (
    <>
      {entry?.note && (
        <p className="type-body-r-s text-fg">
          <span className="type-body-sb-s">Your note:</span> {entry.note}
        </p>
      )}
      {entry?.status === "changes_requested" && entry.comment && (
        <p className="rounded-xl border border-brand-400 bg-brand-100 p-3 type-body-r-s text-brand-800">
          <span className="type-body-sb-s">Changes requested{entry.reviewer ? ` by ${entry.reviewer}` : ""}:</span> {entry.comment}
        </p>
      )}
      {entry?.status === "approved" && entry.comment && (
        <p className="rounded-xl border border-green-200 bg-green-50 p-3 type-body-r-s text-green-700">
          <span className="type-body-sb-s">Approved{entry.reviewer ? ` by ${entry.reviewer}` : ""}:</span> {entry.comment}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {problem ? (
          <p className="type-body-r-s text-muted">This submission can&apos;t be shown.</p>
        ) : failure ? (
          <p className="type-body-r-s text-red-600">
            {failure.message}{" "}
            <button type="button" className="cursor-pointer underline underline-offset-2" onClick={failure.retry}>
              Try again
            </button>
          </p>
        ) : !engine || !design ? (
          <div className="flex h-full items-center justify-center">
            <Spinner label="Loading the submission" className="text-brand-800" />
          </div>
        ) : (
          <ReadOnlyStage engine={engine} doc={design.document} images={design.images} />
        )}
      </div>
    </>
  );
}
