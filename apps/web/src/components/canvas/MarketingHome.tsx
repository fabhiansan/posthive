"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArchiveIcon, ArrowLeftIcon, CircleAlertIcon, HistoryIcon, LayoutTemplateIcon, PaletteIcon, Trash2Icon } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Spinner } from "@/components/Spinner";
import { useToast } from "@/components/Toast";
import { CustomizeButton } from "@/components/templates/CustomizeButton";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { deleteInstance, formatWhen as when, listInstances, type InstanceSummary } from "@/lib/canvas";
import { useTemplates } from "@/lib/useTemplates";
import { useBootNone } from "./CanvasBoot";
import { ReviewChips, ReviewComment } from "./ReviewChips";

type Listing =
  | { status: "loading" }
  | { status: "error" }
  // `next` is the cursor of the page after the ones shown (null: that was the last page); `more` is the state of "Load more".
  | { status: "ready"; items: InstanceSummary[]; next: string | null; more: "idle" | "loading" | "error" };

/** A design that was submitted at least once is never deleted for good: removing it archives it. */
export const hasSubmissions = (d: Pick<InstanceSummary, "review">): boolean => d.review.submissionNumber !== null;

/**
 * Marketing's Canvas home: the templates the design team has published in Canvas (customize one), and the person's own
 * designs, newest first, in pages. The templates come from the Template Library's own list, which already hides drafts.
 */
export function MarketingHome() {
  useBootNone(); // nothing to load for the editor here, so the first-open loader can go
  const toast = useToast();
  const templates = useTemplates();
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [doomed, setDoomed] = useState<InstanceSummary | null>(null);
  const [archivedVersion, setArchivedVersion] = useState(0);

  useEffect(() => {
    let live = true;
    listInstances().then(
      ({ instances, nextCursor }) => live && setListing({ status: "ready", items: instances, next: nextCursor, more: "idle" }),
      () => live && setListing({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const loadMore = useCallback(async () => {
    if (listing.status !== "ready" || !listing.next || listing.more === "loading") return;
    const cursor = listing.next;
    setListing({ ...listing, more: "loading" });
    try {
      const page = await listInstances(cursor);
      // Appended, and a design already shown is not shown twice (the cursor is a value, so a page never repeats, but be exact).
      setListing((l) => {
        if (l.status !== "ready") return l;
        const shown = new Set(l.items.map((i) => i.id));
        return { status: "ready", items: [...l.items, ...page.instances.filter((i) => !shown.has(i.id))], next: page.nextCursor, more: "idle" };
      });
    } catch {
      setListing((l) => (l.status === "ready" ? { ...l, more: "error" } : l));
    }
  }, [listing]);

  async function remove(design: InstanceSummary) {
    let archived = false;
    try {
      archived = (await deleteInstance(design.id)).archived === true;
    } catch (err) {
      if ((err as { status?: number }).status !== 404) {
        toast.error(err instanceof Error ? err.message : hasSubmissions(design) ? "The design could not be archived." : "The design could not be deleted.");
        throw err; // keeps the dialog open for another try
      }
      // 404: it was already gone. The list should say so too.
    }
    // The server decides: a design submitted from another tab since this list loaded is archived even if the button said Delete.
    if (archived && !hasSubmissions(design)) toast.success("This design had been submitted, so it was archived instead of deleted.");
    setListing((l) => (l.status === "ready" ? { ...l, items: l.items.filter((d) => d.id !== design.id) } : l));
    setArchivedVersion((n) => n + 1); // the Archived section (if open) reads the list again
  }

  // Published, and made in Canvas. (A Figma-only template has nothing to customize here.)
  const customizable = (templates.data?.templates ?? []).filter((t) => t.published && t.canvasRevision != null);

  return (
    <div className="theme-dashboard flex h-dvh flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard">
            <ArrowLeftIcon /> Dashboard
          </Link>
        </Button>
        <h1 className="type-body-sb-m text-fg">Canvas</h1>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-4 sm:p-6">
          <section aria-labelledby="customize-heading" className="flex flex-col gap-3">
            <h2 id="customize-heading" className="type-body-sb-m text-fg">
              Templates you can customize
            </h2>
            {templates.loading && !templates.data ? (
              <p className="flex items-center gap-2 type-body-r-s text-muted">
                <Spinner label="Loading templates" className="text-brand-800" /> Loading templates
              </p>
            ) : templates.error && !templates.data ? (
              <p className="type-body-r-s text-red-600">
                The templates didn&apos;t load.{" "}
                <button type="button" onClick={templates.reload} className="cursor-pointer underline underline-offset-2">
                  Try again
                </button>
              </p>
            ) : customizable.length === 0 ? (
              <p className="type-body-r-s text-muted">
                No template is ready to customize yet. The design team publishes them in the{" "}
                <Link href="/templates" className="underline underline-offset-2">
                  Template Library
                </Link>
                .
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {customizable.map((t) => (
                  <li key={t.id} className="card flex items-center gap-3 p-3">
                    <LayoutTemplateIcon aria-hidden className="size-5 shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate type-body-sb-m text-fg">{t.category}</p>
                      <p className="type-body-r-xs text-muted">Revision {t.canvasRevision}</p>
                    </div>
                    <CustomizeButton template={t} label="Customize" />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="mine-heading" className="flex flex-col gap-3">
            <h2 id="mine-heading" className="type-body-sb-m text-fg">
              My designs
            </h2>

            {listing.status === "loading" && (
              <p className="flex items-center gap-2 type-body-r-s text-muted">
                <Spinner label="Loading your designs" className="text-brand-800" /> Loading your designs
              </p>
            )}

            {listing.status === "error" && (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CircleAlertIcon />
                  </EmptyMedia>
                  <EmptyTitle>Your designs didn&apos;t load</EmptyTitle>
                  <EmptyDescription>Check your connection and try again.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setListing({ status: "loading" });
                      setAttempt((n) => n + 1);
                    }}
                  >
                    Try again
                  </Button>
                </EmptyContent>
              </Empty>
            )}

            {listing.status === "ready" && listing.items.length === 0 && (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <PaletteIcon />
                  </EmptyMedia>
                  <EmptyTitle>No designs yet</EmptyTitle>
                  <EmptyDescription>Customize a template above. Your design saves as you work and opens again from this list.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}

            {listing.status === "ready" && listing.items.length > 0 && (
              <>
                <ul className="flex flex-col gap-2">
                  {listing.items.map((d) => (
                    <li key={d.id} className="card flex items-center gap-2 p-2">
                      <Link href={`/canvas/${d.id}`} className="min-w-0 flex-1 rounded-lg px-2 py-1 outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-ring/40">
                        <p className="truncate type-body-sb-m text-fg">{d.name}</p>
                        <p className="type-body-r-xs text-muted">
                          Revision {d.baseRevision.number} · Created {when(d.createdAt)} · Edited {when(d.updatedAt)}
                        </p>
                        <ReviewChips review={d.review} />
                        <ReviewComment review={d.review} />
                      </Link>
                      {hasSubmissions(d) && (
                        <Button asChild variant="ghost" size="icon-sm">
                          <Link href={`/canvas/${d.id}?view=history`} aria-label={`Submission history of ${d.name}`}>
                            <HistoryIcon />
                          </Link>
                        </Button>
                      )}
                      {hasSubmissions(d) ? (
                        <Button variant="ghost" size="icon-sm" aria-label={`Archive ${d.name}`} onClick={() => setDoomed(d)}>
                          <ArchiveIcon />
                        </Button>
                      ) : (
                        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${d.name}`} onClick={() => setDoomed(d)}>
                          <Trash2Icon />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                {listing.next && (
                  <div className="flex flex-col items-center gap-2">
                    {listing.more === "error" && <p className="type-body-r-xs text-red-600">More designs could not be loaded.</p>}
                    <Button variant="secondary" disabled={listing.more === "loading"} aria-busy={listing.more === "loading"} onClick={() => void loadMore()}>
                      {listing.more === "loading" && <Spinner size="sm" label="Loading" />}
                      {listing.more === "error" ? "Try again" : "Load more"}
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>

          <ArchivedSection reload={archivedVersion} />
        </div>
      </main>

      <ConfirmDialog
        open={doomed !== null}
        onOpenChange={(open) => !open && setDoomed(null)}
        title={doomed && hasSubmissions(doomed) ? "Archive this design?" : "Delete this design?"}
        description={
          doomed
            ? hasSubmissions(doomed)
              ? `“${doomed.name}” was submitted for review. Archiving it means you can no longer edit it, submit it again or restore it. The design team keeps what you submitted, and the history stays available to you. The template it was made from is not affected.`
              : `“${doomed.name}” and your changes to it will be deleted. The template it was made from is not affected. This cannot be undone.`
            : undefined
        }
        confirmLabel={doomed && hasSubmissions(doomed) ? "Archive design" : "Delete design"}
        pendingLabel={doomed && hasSubmissions(doomed) ? "Archiving…" : "Deleting…"}
        onConfirm={() => (doomed ? remove(doomed) : undefined)}
      />
    </div>
  );
}

type ArchivedListing = { status: "closed" } | { status: "loading" } | { status: "error" } | { status: "ready"; items: InstanceSummary[]; next: string | null; more: "idle" | "loading" | "error" };

/**
 * Designs the person archived: collapsed until asked for, read-only (their history stays readable; nothing can be edited,
 * submitted or restored). `reload` changes when a design was just archived, so an open section reads the list again.
 */
function ArchivedSection({ reload }: { reload: number }) {
  const [listing, setListing] = useState<ArchivedListing>({ status: "closed" });
  const open = listing.status !== "closed";
  const generation = useRef(0); // which load the list on screen belongs to: a late "Load more" from an older one is dropped

  useEffect(() => {
    if (listing.status === "closed") return;
    let live = true;
    generation.current++;
    listInstances(null, undefined, true).then(
      ({ instances, nextCursor }) => live && setListing({ status: "ready", items: instances, next: nextCursor, more: "idle" }),
      () => live && setListing({ status: "error" }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on open and when a design was just archived, not on every state change
  }, [open, reload]);

  async function more() {
    if (listing.status !== "ready" || !listing.next || listing.more === "loading") return;
    const cursor = listing.next;
    const mine = generation.current;
    setListing({ ...listing, more: "loading" });
    try {
      const page = await listInstances(cursor, undefined, true);
      if (mine !== generation.current) return; // the section was closed, reopened or read again meanwhile
      setListing((l) => {
        if (l.status !== "ready") return l;
        const shown = new Set(l.items.map((i) => i.id));
        return { status: "ready", items: [...l.items, ...page.instances.filter((i) => !shown.has(i.id))], next: page.nextCursor, more: "idle" };
      });
    } catch {
      if (mine === generation.current) setListing((l) => (l.status === "ready" ? { ...l, more: "error" } : l));
    }
  }

  return (
    <section aria-labelledby="archived-heading" className="flex flex-col gap-3">
      <h2 id="archived-heading" className="type-body-sb-m text-fg">
        <button type="button" aria-expanded={open} onClick={() => setListing((l) => (l.status === "closed" ? { status: "loading" } : { status: "closed" }))} className="flex cursor-pointer items-center gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
          <ArchiveIcon aria-hidden className="size-4 text-muted" /> Archived designs
        </button>
      </h2>
      {listing.status === "loading" && (
        <p className="flex items-center gap-2 type-body-r-s text-muted">
          <Spinner label="Loading archived designs" className="text-brand-800" /> Loading
        </p>
      )}
      {listing.status === "error" && <p className="type-body-r-s text-red-600">Archived designs didn&apos;t load. Close this section and open it again to retry.</p>}
      {listing.status === "ready" && listing.items.length === 0 && <p className="type-body-r-s text-muted">You have not archived any design.</p>}
      {listing.status === "ready" && listing.items.length > 0 && (
        <>
          <ul className="flex flex-col gap-2">
            {listing.items.map((d) => (
              <li key={d.id} className="card flex items-center gap-2 p-2">
                <Link href={`/canvas/${d.id}?view=history`} className="min-w-0 flex-1 rounded-lg px-2 py-1 outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-ring/40">
                  <p className="truncate type-body-sb-m text-fg">{d.name}</p>
                  <p className="type-body-r-xs text-muted">Archived · {d.archivedAt ? when(d.archivedAt) : ""} · See what you submitted</p>
                  <ReviewChips review={d.review} archived />
                </Link>
              </li>
            ))}
          </ul>
          {listing.next && (
            <div className="flex flex-col items-center gap-2">
              {listing.more === "error" && <p className="type-body-r-xs text-red-600">More could not be loaded.</p>}
              <Button variant="secondary" disabled={listing.more === "loading"} onClick={() => void more()}>
                {listing.more === "error" ? "Try again" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
