"use client";

import type { ReactNode } from "react";
import { CheckIcon, EyeIcon, ExternalLinkIcon, MinusIcon } from "lucide-react";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { shortName } from "@/lib/dashboard-format";
import { platformLabel } from "@/lib/platforms";
import { checklistOf, dateLine, dateTimeLine, formatText, guidelineParts, platformsText, slideCaption, sourceLabel } from "@/lib/template-library";
import { fileHref, hasFigmaSource, type DesignTemplate } from "@/lib/templates";

/** A card of the detail page: a title, and a line on the right saying what the card is for. */
export function DetailCard({ title, hint, headingId, className, children }: { title: string; hint?: string; headingId: string; className?: string; children: ReactNode }) {
  return (
    <Card className={cn("gap-4 border-0 p-5", className)} role="region" aria-labelledby={headingId}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="type-body-sb-m text-fg">{title}</h2>
        {hint && <p className="min-w-0 truncate text-right type-body-r-xs text-muted">{hint}</p>}
      </div>
      {children}
    </Card>
  );
}

/** One chip of the strip under the title. */
function Chip({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "success" }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 type-body-m-xs", tone === "success" ? "border-green-200 bg-green-50 text-green-700" : "border-border bg-neutral-50 text-neutral-800")}>
      {children}
    </span>
  );
}

/**
 * The strip under the title: who can see it, what it is, who made it and when it was last edited; the platforms it is for on
 * the right. The status pill is next to the title (and only the design team gets it), so it is not repeated here.
 */
export function MetaStrip({ template: t, canManage }: { template: DesignTemplate; canManage: boolean }) {
  const format = formatText(t);
  const made = [t.createdBy && `Created by ${shortName(t.createdBy)}`, dateLine(t.createdAt)].filter(Boolean).join(" · ");
  const edited = dateTimeLine(t.updatedAt);
  return (
    <Card className="flex-row flex-wrap items-center gap-x-3 gap-y-2 border-0 px-5 py-4">
      {canManage && (
        <Chip tone={t.published ? "success" : "plain"}>
          <EyeIcon aria-hidden="true" className="size-3.5" />
          {t.published ? "Visible to Marketing" : "Hidden from Marketing"}
        </Chip>
      )}
      <Chip>Pillar: {t.pillar ?? "No pillar"}</Chip>
      <Chip>Format: {format ?? "No format yet"}</Chip>
      <p className="min-w-0 type-body-r-xs text-muted">{[made, edited && `Last edited ${edited}`].filter(Boolean).join(" · ")}</p>
      {t.platforms.length > 0 && (
        <span className="ml-auto flex items-center gap-2" aria-label={`Platforms: ${platformsText(t.platforms)}`}>
          {t.platforms.map((p) => (
            <span key={p} className="flex size-9 items-center justify-center rounded-lg bg-neutral-50" title={platformLabel(p)}>
              <PlatformIcon platform={p} size={20} />
            </span>
          ))}
        </span>
      )}
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 py-1.5">
      <dt className="type-body-r-s text-neutral-500">{label}</dt>
      <dd className="min-w-0 break-words type-body-m-s text-neutral-900">{children}</dd>
    </div>
  );
}

/** The facts of a template, in the design's order: who made it, when, what it is for and where its design lives. */
export function DetailsCard({ template: t, canManage }: { template: DesignTemplate; canManage: boolean }) {
  const linked = hasFigmaSource(t.linkUrl) && t.linkUrl;
  const edited = dateTimeLine(t.updatedAt);
  return (
    <DetailCard title="Template details" headingId="details-heading" hint={canManage ? (t.published ? "Visible to Marketing" : "Hidden from Marketing") : undefined}>
      <dl className="rounded-xl bg-neutral-50 px-4 py-2">
        {t.createdBy && <Row label="Created by">{t.createdBy} · Design team</Row>}
        <Row label="Created">{dateTimeLine(t.createdAt) || "Unknown"}</Row>
        <Row label="Content pillar">{t.pillar ?? "No pillar"}</Row>
        <Row label="Content category">{t.category}</Row>
        <Row label="Format">{formatText(t) ?? "No format yet"}</Row>
        <Row label="Platform">{platformsText(t.platforms) ?? "No platform yet"}</Row>
        <Row label="Figma URL">
          {linked ? (
            <a href={t.linkUrl!} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1.5 text-brand-800 underline-offset-4 hover:underline">
              <span className="truncate">{sourceLabel(t)}</span>
              <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0" />
            </a>
          ) : (
            sourceLabel(t)
          )}
        </Row>
        {edited && <Row label="Last edited">{edited}{t.canvasRevision != null ? ` · Revision ${t.canvasRevision}` : ""}</Row>}
      </dl>
    </DetailCard>
  );
}

/** What the template has and what it still needs, computed from the template (lib/template-library.ts). The design team only. */
export function ChecklistCard({ template: t }: { template: DesignTemplate }) {
  const items = checklistOf(t);
  const done = items.filter((i) => i.done).length;
  return (
    <DetailCard title="Template checklist" hint={`${done} of ${items.length} ready`} headingId="checklist-heading">
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.key} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full", item.done ? "bg-green-600 text-white" : "border border-neutral-300 text-neutral-400")}
            >
              {item.done ? <CheckIcon className="size-3" strokeWidth={3} /> : <MinusIcon className="size-3" strokeWidth={3} />}
            </span>
            <div className="min-w-0">
              <p className="type-body-m-s text-fg">
                {item.title}
                <span className="sr-only">{item.done ? " ready" : " not ready"}</span>
              </p>
              <p className="type-body-r-xxs text-muted">{item.detail}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="type-body-r-xs text-brand-800">Edits to a published template reach Marketing immediately. Unpublish first if you need a larger rework.</p>
    </DetailCard>
  );
}

/** The slides of a carousel, one picture each with its name under it. Nothing is drawn for a template with none. */
export function SlidesCard({ template: t }: { template: DesignTemplate }) {
  if (t.slideImages.length === 0) return null;
  const n = t.slideImages.length;
  return (
    <DetailCard title="Slides in this template" headingId="slides-heading" hint={`${n} slides · editable text layers`}>
      <ol className="flex gap-3 overflow-x-auto pb-1">
        {t.slideImages.map((slide, i) => (
          // five across when they fit, as in the design; more than that scroll sideways (never narrower than 7rem)
          <li key={slide.url} className="min-w-28 shrink-0 basis-[calc((100%-3rem)/5)]">
            <div className="aspect-4/5 overflow-hidden rounded-lg bg-neutral-100">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={fileHref(slide.url)} alt={`Slide ${i + 1}`} loading="lazy" className="size-full object-cover" />
            </div>
            <p className="mt-1.5 truncate type-body-r-xs text-muted" title={slideCaption(slide, i)}>{slideCaption(slide, i)}</p>
          </li>
        ))}
      </ol>
    </DetailCard>
  );
}

/** What a caption for this kind of post should do, written by the design team; hashtags stand out. Nothing is drawn when there is none. */
export function CaptionCard({ template: t, canManage }: { template: DesignTemplate; canManage: boolean }) {
  if (!t.captionGuideline) return null;
  return (
    <DetailCard title="Caption guideline" headingId="caption-heading" hint={canManage ? "Suggested by Designer · Marketing can edit" : "Suggested by the design team · you write the caption"}>
      <p className="whitespace-pre-line rounded-xl bg-neutral-50 p-4 type-body-r-s text-fg">
        {guidelineParts(t.captionGuideline).map((part, i) => (part.tag ? <span key={i} className="text-brand-800">{part.text}</span> : part.text))}
      </p>
    </DetailCard>
  );
}
