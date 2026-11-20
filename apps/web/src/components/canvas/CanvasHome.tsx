"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, CircleAlertIcon, PaletteIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Spinner } from "@/components/Spinner";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { createDesign, deleteDesign, DESIGN_LIST_MAX, listDesigns, type DesignSummary } from "@/lib/canvas";
import { useBootNone } from "./CanvasBoot";
import { ReviewIndicator } from "./ReviewIndicator";

type Listing = { status: "loading" } | { status: "error" } | { status: "ready"; designs: DesignSummary[] };

const edited = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The design team's Canvas home: their saved designs, newest edit first, and a way to start a new one. */
export function CanvasHome() {
  useBootNone(); // nothing to load for the editor here, so the first-open loader can go
  const router = useRouter();
  const toast = useToast();
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);
  const [doomed, setDoomed] = useState<DesignSummary | null>(null);

  useEffect(() => {
    let live = true;
    listDesigns().then(
      ({ designs }) => live && setListing({ status: "ready", designs }),
      () => live && setListing({ status: "error" }),
    );
    return () => { live = false; };
  }, [attempt]);

  async function create() {
    setCreating(true);
    try {
      const { design } = await createDesign();
      router.push(`/canvas/${design.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The design could not be created.");
      setCreating(false);
    }
  }

  async function remove(design: DesignSummary) {
    try {
      await deleteDesign(design.id);
    } catch (err) {
      if ((err as { status?: number }).status !== 404) {
        toast.error(err instanceof Error ? err.message : "The design could not be deleted.");
        throw err; // keeps the dialog open for another try
      }
      // 404: it was already gone. The list should say so too.
    }
    setListing((l) => (l.status === "ready" ? { status: "ready", designs: l.designs.filter((d) => d.id !== design.id) } : l));
  }

  return (
    <div className="theme-dashboard flex h-dvh flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard">
            <ArrowLeftIcon /> Dashboard
          </Link>
        </Button>
        <h1 className="type-body-sb-m text-fg">Canvas</h1>
        <div className="ml-auto flex items-center gap-2">
          <ReviewIndicator />
          <Button size="sm" onClick={create} disabled={creating}>
            {creating ? <Spinner size="sm" label="Creating" /> : <PlusIcon />} New design
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {listing.status === "loading" && (
          <div className="flex items-center justify-center gap-2 p-12 type-body-r-s text-muted">
            <Spinner label="Loading your designs" className="text-brand-800" /> Loading your designs
          </div>
        )}

        {listing.status === "error" && (
          <div className="flex justify-center p-6">
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
          </div>
        )}

        {listing.status === "ready" && listing.designs.length === 0 && (
          <div className="flex justify-center p-6">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PaletteIcon />
                </EmptyMedia>
                <EmptyTitle>No designs yet</EmptyTitle>
                <EmptyDescription>Start a design here. It saves as you work, and opens again from this list.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={create} disabled={creating}>
                  <PlusIcon /> New design
                </Button>
              </EmptyContent>
            </Empty>
          </div>
        )}

        {listing.status === "ready" && listing.designs.length > 0 && (
          <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
            <ul className="flex flex-col gap-2">
              {listing.designs.map((d) => (
                <li key={d.id} className="card flex items-center gap-2 p-2">
                  <Link href={`/canvas/${d.id}`} className="min-w-0 flex-1 rounded-lg px-2 py-1 outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-ring/40">
                    <p className="truncate type-body-sb-m text-fg">{d.name}</p>
                    <p className="type-body-r-xs text-muted">
                      Edited {edited(d.updatedAt)} · {d.latestRevision ? `Revision ${d.latestRevision.number}` : "No revision yet"} ·{" "}
                      {d.template ? `Template: ${d.template.category} (${d.template.published ? "published" : "draft"})` : "Not attached to a template"}
                    </p>
                  </Link>
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${d.name}`} onClick={() => setDoomed(d)}>
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
            </ul>
            {listing.designs.length >= DESIGN_LIST_MAX && <p className="mt-3 type-body-r-xs text-muted">Showing your {DESIGN_LIST_MAX} most recently edited designs.</p>}
          </div>
        )}
      </main>

      <ConfirmDialog
        open={doomed !== null}
        onOpenChange={(open) => !open && setDoomed(null)}
        title="Delete this design?"
        description={
          doomed
            ? doomed.template
              ? `“${doomed.name}” is attached to the “${doomed.template.category}” template, so it cannot be deleted. Remove the link on the template's page first.`
              : `“${doomed.name}” and everything in it${doomed.latestRevision ? `, including its ${doomed.latestRevision.number} published ${doomed.latestRevision.number === 1 ? "revision" : "revisions"},` : ""} will be deleted. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete design"
        confirmDisabled={doomed?.template != null} // a linked design cannot be deleted: the dialog says why, and offers nothing that would fail
        pendingLabel="Deleting…"
        onConfirm={() => (doomed ? remove(doomed) : undefined)}
      />
    </div>
  );
}
