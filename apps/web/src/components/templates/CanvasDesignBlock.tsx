"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLinkIcon, LinkIcon, PaletteIcon, PlusIcon, Unlink2Icon } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { attachDesign, canvasProblem, createDesignForTemplate, detachDesign, listDesigns, type DesignSummary } from "@/lib/canvas";
import { attachBlockedReason, attachNotice } from "@/lib/template-library";
import type { DesignTemplate } from "@/lib/templates";

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

/**
 * The Canvas design of a template, on the template's own page (the design team only). The page creates or links the
 * design; the Canvas editor only publishes revisions; the template's own Publish stays a separate action on the page.
 * The API decides every case (this only says it first), and its message is shown when it refuses; a lost connection or a server
 * fault gets a plain sentence from canvasProblem instead.
 */
export function CanvasDesignBlock({ template, onChanged }: { template: DesignTemplate; onChanged(): void }) {
  const toast = useToast("top-right");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [designs, setDesigns] = useState<DesignSummary[] | null>(null);
  const [removing, setRemoving] = useState(false);
  const [linked, setLinked] = useState<DesignSummary | null>(null);

  // The linked design's name and revision date (the template row carries only its id and revision number).
  // shortcut: found in the list of the 200 most recently edited designs; an older one shows as "Linked design" without a date.
  useEffect(() => {
    if (!template.designId) {
      setLinked(null);
      return;
    }
    let live = true;
    listDesigns().then(({ designs: all }) => live && setLinked(all.find((d) => d.id === template.designId) ?? null), () => {});
    return () => {
      live = false;
    };
  }, [template.designId, template.canvasRevision]);

  const fail = (err: unknown, fallback: string) => toast.error(canvasProblem(err, fallback));

  async function createAndOpen() {
    setBusy(true);
    try {
      // One request: the server creates the design and links it in a single transaction, so a refusal leaves no design behind.
      const { design } = await createDesignForTemplate(template.id);
      router.push(`/canvas/${design.id}`);
    } catch (err) {
      fail(err, "The Canvas design could not be created. Nothing was changed.");
      onChanged(); // another tab may have linked a design first: the page shows what the server has now
      setBusy(false);
    }
  }

  async function openPicker() {
    setPicking(true);
    setDesigns(null);
    try {
      setDesigns((await listDesigns()).designs.filter((d) => d.template === null));
    } catch (err) {
      fail(err, "Your designs could not be loaded.");
      setPicking(false);
    }
  }

  async function link(design: DesignSummary) {
    setBusy(true);
    try {
      await attachDesign(template.id, design.id);
      toast.success(`“${design.name}” is now this template's Canvas design.`);
      setPicking(false);
      onChanged();
    } catch (err) {
      fail(err, "The design could not be linked.");
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    try {
      await detachDesign(template.id);
      toast.danger("The Canvas design was unlinked. It is still in your Canvas designs.");
      onChanged();
    } catch (err) {
      fail(err, "The design could not be unlinked.");
      throw err;
    }
  }

  const createBlocked = attachBlockedReason(template, null);
  const notice = attachNotice(template);

  return (
    <section aria-labelledby="canvas-design-heading" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <PaletteIcon aria-hidden className="size-4 text-muted" />
        <h2 id="canvas-design-heading" className="type-body-sb-s text-fg">Canvas design</h2>
      </div>

      {template.designId ? (
        <>
          <p className="type-body-r-s text-neutral-900">
            {linked ? linked.name : "Linked design"} ·{" "}
            {template.canvasRevision != null ? `Revision ${template.canvasRevision}${linked?.latestRevision ? ` · ${day(linked.latestRevision.createdAt)}` : ""}` : "No revision yet"}
          </p>
          {template.canvasRevision == null && <p className="type-body-r-xs text-muted">Publish a revision in the Canvas editor. Marketing needs one before this template can be published without a Figma link.</p>}
          {/* Not revocation: a design Marketing made pins the revision it started from, so nothing done here reaches it. */}
          <p className="type-body-r-xs text-muted">Unpublishing stops new Marketing designs from this template. Designs Marketing already made from it keep working.</p>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary" size="sm">
              <Link href={`/canvas/${template.designId}`}>
                <ExternalLinkIcon /> Open in Canvas
              </Link>
            </Button>
            <Button variant="destructive-outline" size="sm" onClick={() => setRemoving(true)}>
              <Unlink2Icon /> Remove link
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="type-body-r-xs text-muted">Design this template in Canvas instead of (or as well as) Figma. The design is attached here; publishing a revision happens in the editor.</p>
          {createBlocked && <p role="status" className="type-body-r-xs text-brand-800">{createBlocked}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || createBlocked !== null} onClick={() => void createAndOpen()}>
              <PlusIcon /> Create Canvas design
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void openPicker()}>
              <LinkIcon /> Link existing design
            </Button>
          </div>
        </>
      )}

      {picking && (
        <div role="group" aria-label="Choose a design to link" className="flex flex-col gap-2 rounded-xl bg-neutral-50 p-3">
          {notice && <p className="type-body-r-xs text-brand-800">{notice}</p>}
          {designs === null ? (
            <p className="type-body-r-xs text-muted">Loading your designs…</p>
          ) : designs.length === 0 ? (
            <p className="type-body-r-xs text-muted">No unlinked designs. Create one above, or in Canvas.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {designs.map((d) => {
                const blocked = attachBlockedReason(template, d);
                return (
                  <li key={d.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate type-body-r-s text-neutral-900">
                      {d.name} <span className="text-muted">· {d.latestRevision ? `Revision ${d.latestRevision.number}` : "No revision yet"}</span>
                    </span>
                    <Button size="sm" variant="secondary" disabled={busy || blocked !== null} title={blocked ?? undefined} onClick={() => void link(d)}>
                      Link
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <Button variant="ghost" size="sm" className="self-start" onClick={() => setPicking(false)}>
            Cancel
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        tone="danger"
        icon={<Unlink2Icon />}
        title="Remove the Canvas design?"
        description="The design, its revisions and its images are kept in your Canvas designs. The template just stops using it."
        confirmLabel="Remove link"
        pendingLabel="Removing…"
        onConfirm={unlink}
      />
    </section>
  );
}
