"use client";

import type { ReactNode } from "react";
import { EyeOffIcon, TriangleAlertIcon } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { BRAND } from "@/lib/brand";
import { shortName } from "@/lib/dashboard-format";
import { dateLine, formatText } from "@/lib/template-library";
import type { DesignTemplate } from "@/lib/templates";
import { useTemplateUsage } from "@/lib/useTemplateUsage";
import { cn } from "@/lib/cn";
import { TemplateCover } from "./TemplateCover";
import { TemplateStatus } from "./TemplateStatus";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The template the dialog is about: its picture, what kind it is, its name and its status, as in the design. */
function Summary({ template: t }: { template: DesignTemplate }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-neutral-50 p-3">
      <TemplateCover template={t} className="aspect-4/5 w-16 shrink-0 rounded-md p-0" />
      <div className="flex min-w-0 flex-col items-start gap-1">
        <p className="truncate type-body-m-xxs text-muted">{[formatText(t), t.pillar].filter(Boolean).join(" · ") || "Template"}</p>
        <p className="max-w-full truncate type-body-sb-s text-fg">{t.category}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <TemplateStatus published={t.published} />
          {t.canvasRevision != null && <span className="rounded-full bg-neutral-800 px-2 py-0.5 type-body-sb-xxs text-white">Revision {t.canvasRevision}</span>}
        </div>
      </div>
    </div>
  );
}

/** A box that says what the action does to the posts: shown only when there is a number to say. */
function Callout({ tone, icon, title, children }: { tone: "warning" | "danger"; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div role="note" className={cn("flex gap-3 rounded-xl p-3", tone === "warning" ? "bg-brand-100 text-brand-800" : "bg-red-50 text-red-600")}>
      <span aria-hidden="true" className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>
      <div className="min-w-0">
        <p className="type-body-sb-s">{title}</p>
        <p className="mt-0.5 type-body-r-xs text-fg">{children}</p>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 type-body-r-xs">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-fg">{children}</dd>
    </div>
  );
}

type Props = {
  /** The template the dialog is about; null while none is chosen (the dialog is closed). */
  template: DesignTemplate | null;
  onOpenChange: (open: boolean) => void;
  /** Does it. When it throws the dialog stays open (ConfirmDialog); the caller has already told the person why. */
  onConfirm: () => Promise<void>;
};

/** "Unpublish {category}?": the template goes back to a draft and leaves Marketing's list. Says how many posts in review are of its category. */
export function UnpublishTemplateDialog({ template, onOpenChange, onConfirm }: Props) {
  const usage = useTemplateUsage(template?.id, template !== null);
  const inReview = usage?.inReview ?? 0;
  return (
    <ConfirmDialog
      open={template !== null}
      onOpenChange={onOpenChange}
      tone="warning"
      layout="stacked"
      icon={<EyeOffIcon />}
      title={template ? `Unpublish ${template.category}?` : ""}
      description="The template goes back to Draft and disappears from Marketing's Pick from templates list. You can publish it again anytime."
      confirmLabel="Unpublish template"
      pendingLabel="Unpublishing…"
      onConfirm={onConfirm}
    >
      {template && (
        <div className="mt-2 flex flex-col gap-3">
          {inReview > 0 && (
            <Callout tone="warning" icon={<TriangleAlertIcon />} title={`${plural(inReview, "post", "posts")} in review ${inReview === 1 ? "uses" : "use"} this template`}>
              {inReview === 1 ? "It keeps" : "They keep"} the current design. Marketing just can&apos;t start new posts from it until you publish again.
            </Callout>
          )}
          <Summary template={template} />
          <dl>
            <Fact label="New status">Draft · hidden from Marketing</Fact>
          </dl>
        </div>
      )}
    </ConfirmDialog>
  );
}

/** "Delete {category}?": the template, its preview, its slides and its Figma link are removed for good. Says how many posts are of its category. */
export function DeleteTemplateDialog({ template, onOpenChange, onConfirm }: Props) {
  const usage = useTemplateUsage(template?.id, template !== null);
  const created = usage?.created ?? 0;
  return (
    <ConfirmDialog
      open={template !== null}
      onOpenChange={onOpenChange}
      tone="danger"
      layout="stacked"
      icon={<TriangleAlertIcon />}
      title={template ? `Delete ${template.category}?` : ""}
      description={`This permanently removes the template, its preview and its Figma link from ${BRAND.name}. This can't be undone.${template?.designId ? " Its Canvas design stays in your Canvas designs." : ""}`}
      confirmLabel="Delete template"
      pendingLabel="Deleting…"
      onConfirm={onConfirm}
    >
      {template && (
        <div className="mt-2 flex flex-col gap-3">
          {created > 0 && (
            <Callout tone="danger" icon={<TriangleAlertIcon />} title={`${plural(created, "post", "posts")} ${created === 1 ? "is" : "are"} of this category`}>
              Existing posts stay as they are, but they have no design reference to open any more.{template.published ? " Unpublish instead if you might need it later." : ""}
            </Callout>
          )}
          <Summary template={template} />
          <dl>
            <Fact label="Created by">{[shortName(template.createdBy), dateLine(template.createdAt)].filter(Boolean).join(" · ") || "Unknown"}</Fact>
          </dl>
        </div>
      )}
    </ConfirmDialog>
  );
}
