"use client";

import { useState } from "react";
import { UploadIcon } from "lucide-react";
import type { CanvasDocument, EditableField, HiddenEditable } from "posthive-canvas";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { publishDesign, type DesignSummary, type RevisionInfo } from "@/lib/canvas";

interface PublishActionProps {
  designId: string;
  /** The template this design is made for (null: not attached). */
  template: DesignSummary["template"];
  /** The latest published revision (null: none yet). */
  revision: RevisionInfo | null;
  /** The version the server last confirmed, and whether the editor holds changes it has not confirmed. */
  version: number;
  dirty: boolean;
  doc: CanvasDocument;
  /** The engine's rule for what Marketing may change and what blocks a publish (editableLayers). */
  analyse(doc: CanvasDocument): { fields: EditableField[]; hidden: HiddenEditable[] };
  /** Saves now; true when everything is saved. */
  flush(): Promise<boolean>;
  /** The version the server last confirmed, read when the publish is sent. */
  currentVersion(): number | null;
  onPublished(revision: RevisionInfo): void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const hiddenLine = (h: HiddenEditable) => (h.group === null ? `“${h.name}” is editable but hidden` : `“${h.name}” is editable but hidden because its group “${h.group}” is hidden`);

/**
 * The designer's Publish for a saved design: it freezes the saved design as a new revision, together with the layers
 * Marketing may change. It does not make anything visible to Marketing: that is the template's own Publish, on its page.
 */
export function PublishAction({ designId, template, revision, version, dirty, doc, analyse, flush, currentVersion, onPublished }: PublishActionProps) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const { fields, hidden } = analyse(doc);
  const texts = fields.filter((f) => f.kind === "text").length;
  const images = fields.length - texts;
  const unpublished = revision === null || revision.designVersion !== version || dirty;

  async function publish() {
    if (!(await flush())) {
      toast.error("Your latest changes could not be saved yet, so nothing was published. Try again when saving works.");
      throw new Error("not saved");
    }
    const saved = currentVersion();
    if (saved === null) throw new Error("not saved");
    try {
      const { revision: next } = await publishDesign(designId, saved);
      onPublished(next);
      toast.success(`Revision ${next.number} published.`);
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "The revision could not be published. Try again.");
      throw err;
    }
  }

  return (
    <>
      <span className="hidden type-body-r-xs text-muted xl:inline" aria-live="polite">
        {revision ? `Revision ${revision.number}` : "No revision yet"}
        {revision && unpublished ? " · Unpublished changes" : ""}
      </span>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <UploadIcon /> Publish
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone="default"
        icon={<UploadIcon />}
        title="Publish a revision"
        description={`Revision ${(revision?.number ?? 0) + 1} freezes this design as it is saved now, with the layers Marketing may change.`}
        confirmLabel={`Publish revision ${(revision?.number ?? 0) + 1}`}
        pendingLabel="Publishing…"
        confirmDisabled={hidden.length > 0}
        onConfirm={publish}
      >
        <div className="flex flex-col gap-2 type-body-r-s text-fg">
          {hidden.length > 0 ? (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-600">
              <p className="type-body-sb-s">Show these layers, or set them to Protected, first:</p>
              <ul className="mt-1 list-disc pl-5">
                {hidden.slice(0, 5).map((h) => (
                  <li key={h.nodeId}>{hiddenLine(h)}</li>
                ))}
              </ul>
              {hidden.length > 5 && <p className="mt-1">and {hidden.length - 5} more</p>}
            </div>
          ) : fields.length > 0 ? (
            <p>
              Marketing can change {[texts > 0 && plural(texts, "text field", "text fields"), images > 0 && plural(images, "image", "images")].filter(Boolean).join(" and ")}. Everything else is protected.
            </p>
          ) : (
            <p>No layer is editable, so Marketing could only look at this revision. Set a text or image layer to editable in Marketing access if that is not what you want.</p>
          )}
          <p className="text-muted">
            {template
              ? `Attached to the “${template.category}” template (${template.published ? "published" : "draft"}).`
              : "This design is not attached to a template yet. Attach it on the template's page so Marketing can use it."}{" "}
            Publishing a revision does not make it visible to Marketing: publish the template for that.
          </p>
        </div>
      </ConfirmDialog>
    </>
  );
}
