"use client";

import { useEffect, useState } from "react";
import { CloudUploadIcon, ImageIcon, ImageOffIcon, LinkIcon, FolderIcon, ExternalLinkIcon } from "lucide-react";
import { DesignReferenceCard } from "@/components/DesignReferenceCard";
import { PlatformIcon } from "@/components/PlatformIcon";
import { PLATFORM_LIMIT } from "@/components/PlatformPreview";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { DesignRevisionButton } from "./DesignRevisionButton";
import { apiFetch, assetUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import { normalizeCategory } from "@/lib/contentTypes";
import {
  activityText,
  approvalLabel,
  captionLimit,
  filterOf,
  longDate,
  pillOf,
  publishingLabel,
  statusOfPost,
  timeWib,
  type PostDetail,
} from "@/lib/content-list";
import { designLine } from "@/lib/post-editor";
import { formatPlanDate } from "@/lib/import-rows";
import { wibDateKey } from "@/lib/datetime";
import { platformLabel } from "@/lib/platforms";
import { missingMessage } from "@/lib/submitReadiness";
import { templatesByCategory, type DesignTemplate } from "@/lib/templates";
import { InfoTile } from "./InfoTile";
import { StatusChip } from "./StatusChip";

type Props = {
  /** The post to show; null closes the drawer. */
  id: string | null;
  templates: DesignTemplate[];
  /** Edit, delete, submit and retry are for the people who make content. */
  canEdit: boolean;
  canReview: boolean;
  /** This person sends their drafts for review (the approval flow applies to them). */
  canSubmitOwn: boolean;
  onClose: () => void;
  onEdit: (id: string) => void;
  onReview: (id: string) => void;
  onSubmit: (id: string) => void;
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
};

/** The post of one row, read only: what it is, its caption, its design, what happened to it. Everything is edited in the full editor. */
export function ContentDrawer({ id, templates, canEdit, canReview, canSubmitOwn, onClose, onEdit, onReview, onSubmit, onRetry, onDelete }: Props) {
  const [post, setPost] = useState<PostDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  // The answer for the post on screen only: a slow one for a row the person already left is dropped
  useEffect(() => {
    if (!id) return;
    let live = true;
    setPost(null);
    setError(null);
    apiFetch<PostDetail>(`/jobs/${id}/detail`)
      .then((answer) => live && setPost(answer))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Something went wrong. Try again."));
    return () => {
      live = false;
    };
  }, [id, version]);

  const category = post ? normalizeCategory(post.category) : null;
  const template = category ? templatesByCategory(templates).get(category) : undefined;
  const limit = post ? captionLimit(post.channels, PLATFORM_LIMIT) : null;
  const filter = post ? filterOf(post) : null;

  // Which buttons the footer has. Until the required fields are there a draft has only Close and Edit Content; once
  // they are, Submit for review and Delete appear. A post that is already in review, out or failed is past that gate.
  // A draft belongs to the workspace, not to whoever uploaded it: a plan is imported by one person and kept by the
  // team, so every person who makes content may edit and submit it. Deleting and retrying stay with the person who made
  // the post, or an admin (the server refuses the rest).
  const unsent = filter === "draft" || filter === "rejected";
  const complete = post ? post.missing.length === 0 : false;
  const ownerOrAdmin = canEdit && Boolean(post && (canReview || post.mine));
  const canEditPost = canEdit && (unsent || filter === "review" || (filter === "pending" && !canSubmitOwn));
  // In review the post has been sent: nothing to submit until an edit pulls it back to a draft
  // Sent back by the reviewer is the same: nothing to send until an edit changes the content (the server clears the
  // rejection then and the post is a plain draft again, with Submit)
  const withDesigner = post?.designRequest?.status === "sent";
  const canSubmit = canEdit && canSubmitOwn && filter === "draft" && complete && !withDesigner;
  const canDelete = ownerOrAdmin && (!unsent || complete);
  const canRetry = ownerOrAdmin && filter === "failed";
  // Told only to the person who sends posts for review: why their draft has only two buttons
  const hint =
    post && canEdit && canSubmitOwn && withDesigner && post.designRequest
      ? `${designLine(post.designRequest)}. Cancel the request in the editor to send this post on.`
      : post && canEdit && canSubmitOwn && filter === "rejected"
      ? "Revision requested. Edit the content to send it for review again."
      : post && canEdit && canSubmitOwn && unsent && !complete
        ? missingMessage(post.missing)
        : null;

  return (
    <Sheet open={id !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" showCloseButton className="w-full gap-0 bg-surface p-0 sm:max-w-170">
        <header className="space-y-2 border-b border-border px-6 py-5">
          {post ? (
            <>
              <p className="pr-10 type-body-r-xxs tracking-wide text-muted-foreground uppercase">
                Content detail{post.sourceRow ? ` · Row ${post.sourceRow}` : ""}
                {post.pillar ? ` · Pillar: ${post.category ?? post.pillar}` : ""}
              </p>
              <SheetTitle className="pr-10 type-head-sb-5 break-words text-fg">{post.title}</SheetTitle>
              <SheetDescription className="type-body-r-xs">
                {[
                  statusOfPost(post),
                  post.source ? `Imported from ${post.source.fileName}${post.sourceRow ? ` (row ${post.sourceRow})` : ""}` : null,
                  post.source ? formatPlanDate(wibDateKey(new Date(post.source.importedAt))) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </SheetDescription>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <StatusChip status={pillOf(post)} label={`Content: ${statusOfPost(post)}`} />
                <StatusChip status={filter === "review" ? "review" : filter === "rejected" ? "changes" : "brief"} label={`Approval: ${approvalLabel(post)}`} />
                <StatusChip status={filter === "pending" ? "scheduled" : filter === "done" ? "published" : filter === "failed" ? "failed" : "brief"} label={`Publishing: ${publishingLabel(post)}`} />
                <span className="ml-auto flex items-center gap-1.5">
                  {post.channels.map((c) => (
                    <span key={c} title={platformLabel(c)} className="flex size-8 items-center justify-center rounded-lg bg-bg">
                      <PlatformIcon platform={c} size={18} />
                    </span>
                  ))}
                </span>
              </div>
            </>
          ) : (
            <>
              <SheetTitle className="pr-10 type-head-sb-5 text-fg">{error ? "This post can't be shown" : "Loading…"}</SheetTitle>
              <SheetDescription className="type-body-r-xs">{error ?? "Fetching the post."}</SheetDescription>
            </>
          )}

        </header>

        <div className="min-h-0 flex-1 overflow-y-auto bg-bg px-4 py-5 sm:px-6">
          {error && (
            <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 type-body-r-s text-red-600">
              {error}
            </p>
          )}
          {!post && !error && (
            <div className="space-y-3" aria-hidden="true">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}

          {post && (
            <>
              <div className="space-y-4">
                <Card className="gap-4 p-4 sm:p-5">
                <section aria-labelledby="info-title">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 id="info-title" className="type-body-sb-m text-fg">Content information</h3>
                    <p className="type-body-r-xs text-muted-foreground">{post.source ? "Imported · read-only preview" : "Read-only preview"}</p>
                  </div>
                  <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                    <InfoTile label="Content pillar">{post.pillar ?? "Not set"}</InfoTile>
                    <InfoTile label="Content format">{post.format === "carousel" ? `Carousel${post.media.length ? ` · ${post.media.length} slides` : ""}` : post.format === "single" ? "Single image" : "Not set"}</InfoTile>
                    <InfoTile label="Publishing platform">
                      {post.channels.length > 0 ? post.channels.map(platformLabel).join(" · ") : "No channel yet"}
                    </InfoTile>
                    <InfoTile label="Publishing date">{post.scheduledFor ? longDate(post.scheduledFor) : "No date yet"}</InfoTile>
                    <InfoTile label="Publishing time">{post.scheduledFor ? timeWib(post.scheduledFor) : "—"}</InfoTile>
                    <InfoTile label="Approval status">{approvalLabel(post)}</InfoTile>
                  </dl>
                  {post.reviewNote && post.approvalStatus === "rejected" && (
                    <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 type-body-r-s text-red-600">
                      <span className="type-body-sb-s">Design review:</span> {post.reviewNote}
                    </p>
                  )}
                </section>

                <section aria-labelledby="caption-title">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 id="caption-title" className="type-body-sb-m text-fg">Caption</h3>
                    <p className="type-body-r-xs text-muted-foreground">
                      {post.captionLength.toLocaleString("en-US")}
                      {limit ? ` / ${limit.toLocaleString("en-US")}` : ""} characters
                    </p>
                  </div>
                  <p className={cn("mt-3 rounded-xl bg-bg px-4 py-3 type-body-r-s break-words whitespace-pre-wrap", !post.caption && "text-muted-foreground")}>
                    {post.caption || "No caption yet."}
                  </p>
                  {limit && post.captionLength > limit && (
                    <p role="status" className="mt-2 type-body-r-xs text-red-600">
                      This is {(post.captionLength - limit).toLocaleString("en-US")} characters over what {platformLabel(post.channels.find((c) => PLATFORM_LIMIT[c] === limit) ?? "")} takes.
                    </p>
                  )}
                </section>

                <section aria-label="Copywriting & Supporting Assets">
                  <h3 className="type-body-sb-s">Copywriting &amp; Supporting Assets</h3>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {[["Copywriting", post.link, post.designCopy, LinkIcon], ["Supporting Assets", post.assets?.link, post.assets?.text, FolderIcon]].map(([label, url, text, Icon]) => {
                      const Glyph = Icon as typeof LinkIcon;
                      return url ? <Button key={String(label)} asChild variant="secondary" className="justify-start text-blue-700"><a href={String(url)} target="_blank" rel="noopener noreferrer"><Glyph />{String(label)}<ExternalLinkIcon className="ml-auto" /></a></Button> : <p key={String(label)} className="rounded-xl bg-bg p-3 type-body-r-xs break-words text-muted">{String(label)}: {text ? String(text) : "Not provided"}</p>;
                    })}
                  </div>
                </section>
                </Card>
                <Card className="gap-4 p-4 sm:p-5">
                  <h3 className="type-body-sb-m">Design Information</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <InfoTile label="Design path">{post.designPath === "B" || post.designRequest ? "Path B · Assign to Designer" : post.designPath === "A" ? "Path A · Use a template" : "Not determined"}</InfoTile>
                    <InfoTile label="Designer (PIC)">{post.designRequest?.assignee ?? "Not assigned"}</InfoTile>
                    <InfoTile label="Design deadline">{post.designRequest?.deadline ? `${longDate(post.designRequest.deadline)} · ${timeWib(post.designRequest.deadline)}` : "Not set"}</InfoTile>
                    <InfoTile label="Reference">{post.designInfo?.referenceUrl ? <a href={post.designInfo.referenceUrl} target="_blank" rel="noopener noreferrer" className="break-all text-brand-800 underline">{post.designInfo.referenceUrl}</a> : "Not provided"}</InfoTile>
                  </dl>
                  {post.designPath === "A" && <DesignReferenceCard template={template} category={category} />}
                </Card>
                <DesignStatus post={post} />
                <Card className="gap-3 p-4 sm:p-5">
                  <h3 className="type-body-sb-m">Designer detail</h3>
                  <dl className="grid gap-3">
                    <InfoTile label="Notes / Instructions">{post.designInfo?.brief || "Not provided"}</InfoTile>
                    <InfoTile label="Designer note">{post.designInfo?.designerNote || "No submitted note yet"}</InfoTile>
                    {post.designInfo?.revisionNote && <InfoTile label="Requested design changes">{post.designInfo.revisionNote}</InfoTile>}
                  </dl>
                  {canEditPost && post.designRequest?.status === "done" && unsent && <DesignRevisionButton postId={post.id} onChanged={() => setVersion((n) => n + 1)} />}
                </Card>
                <Card className="p-4 sm:p-5"><DesignSection key={post.id} post={post} template={template} category={category} /></Card>
                <Card className="p-4 sm:p-5"><ActivitySection post={post} /></Card>
              </div>
            </>
          )}
        </div>

        <footer className="space-y-3 border-t border-border px-6 py-4">
          <p className="type-body-r-xs text-muted-foreground" role={hint ? "status" : undefined}>
            {hint ?? (canEdit ? "Preview only · all edits happen in the full-page editor" : "Preview only")}
          </p>
          {/* Delete stands apart on the left, away from the actions that move the post forward on the right */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {post && canDelete && (
              <Button variant="destructive-outline" className="mr-auto" onClick={() => onDelete(post.id)}>
                Delete
              </Button>
            )}
            {post && canRetry && <Button variant="secondary" className="border-neutral-500" onClick={() => onRetry(post.id)}>Retry failed</Button>}
            {post && canSubmit && <Button variant="secondary" className="border-neutral-500" onClick={() => onSubmit(post.id)}>Submit for review</Button>}
            {post && canReview && filter === "review" && <Button variant="secondary" className="border-neutral-500" onClick={() => onReview(post.id)}>Review</Button>}
            <Button variant="secondary" className="border-neutral-500" onClick={onClose}>Close</Button>
            {/* an approved post is locked for a person who goes through review: the server refuses their edit */}
            {post && canEditPost && <Button onClick={() => onEdit(post.id)}>Edit Content</Button>}
          </div>
        </footer>
      </SheetContent>
    </Sheet>
  );
}

function DesignSection({ post, template, category }: { post: PostDetail; template: DesignTemplate | undefined; category: ReturnType<typeof normalizeCategory> }) {
  // A failed image stays in its own square; switching posts resets the errors.
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const shown = post.media.length - post.media.filter((url) => gone.has(url)).length;
  return (
    <section aria-labelledby={`design-title-${post.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={`design-title-${post.id}`} className="type-body-sb-m text-fg">Design Preview</h3>
        <p className="type-body-r-xs text-muted-foreground">Template &amp; ready design</p>
      </div>
      <div className="mt-3 space-y-3">
        {post.media.length > 0 ? (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {post.media.map((url) => (
              <li key={url} className="aspect-square overflow-hidden rounded-xl bg-bg">
                {gone.has(url) ? (
                  <div className="flex size-full flex-col items-center justify-center gap-1.5 p-2 text-center text-muted-foreground">
                    <ImageOffIcon aria-hidden="true" className="size-5" />
                    <span className="type-body-r-xxs">File removed</span>
                  </div>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={assetUrl(url)} alt="" loading="lazy" className="size-full object-cover" onError={() => setGone((g) => new Set(g).add(url))} />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex items-start gap-3 rounded-xl border border-dashed border-neutral-300 px-4 py-4">
            <CloudUploadIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="type-body-m-m text-fg">No template or design yet</p>
              <p className="mt-0.5 type-body-r-xs text-muted-foreground">Choose a template for this content type, ask a designer, or upload a ready design in the editor.</p>
            </div>
          </div>
        )}
        {post.media.length > 0 && (
          <p className="flex items-center gap-1.5 type-body-r-xs text-muted-foreground">
            <ImageIcon aria-hidden="true" className="size-3.5" />
            {shown > 0 ? `${shown} ${shown === 1 ? "image" : "images"} attached` : "The files of this design are no longer stored."}
          </p>
        )}
        {post.designRequest && (
          <p className={post.designRequest.status === "done" ? "rounded-xl bg-green-50 px-4 py-3 type-body-r-s text-green-700" : "rounded-xl bg-brand-100 px-4 py-3 type-body-r-s text-brand-800"}>
            {designLine(post.designRequest)}
            {post.designRequest.status === "draft" ? " (brief saved, not sent yet)" : ""}
          </p>
        )}
        {post.designFigmaUrl && (
          <a href={post.designFigmaUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 type-body-m-s text-brand-800 underline-offset-2 hover:underline">
            Open the design in Figma <span aria-hidden>↗</span>
          </a>
        )}
      </div>
    </section>
  );
}

function DesignStatus({ post }: { post: PostDetail }) {
  const r = post.designRequest;
  const info = post.designInfo;
  const stage = post.approvalStatus === "approved" ? 4 : r?.status === "sent" && info?.revisionNote ? 3 : r?.status === "done" ? 2 : info?.inProgress ? 1 : 0;
  const requested = r && r.status !== "draft";
  const revised = info?.history.some((e) => e.kind === "revision");
  return <Card className="gap-4 p-4 sm:p-5">
    <h3 className="type-body-sb-m">Design status</h3>
    {requested ? <>
      <ol aria-label="Design milestones" className="grid grid-cols-5">
        {["Requested", "In Design", "Submitted", "Revision", "Completed"].map((label, i) => <li key={label} aria-current={stage === i ? "step" : undefined} className="relative flex min-w-0 flex-col items-center gap-2 text-center">
          {i < 4 && <span aria-hidden="true" className="absolute top-2 left-1/2 h-px w-full bg-neutral-200" />}
          <span aria-hidden="true" className={cn("relative size-4 rounded-full border-2", i === stage ? "border-brand-700 bg-accent" : i < stage && (i !== 3 || revised) ? "border-green-700 bg-green-100" : "border-neutral-200 bg-surface")} />
          <span className="type-body-r-xxs">{label}</span>
          {i === 3 && stage === 4 && !revised && <span className="type-body-r-xxs text-muted">Not needed</span>}
        </li>)}
      </ol>
      <p className="type-body-r-xs text-muted">{stage === 4 ? "Approved by Admin" : stage === 3 ? "Design revision requested by Marketing" : stage === 2 ? post.approvalStatus === "pending" ? "Waiting for Admin approval" : post.approvalStatus === "rejected" ? "Returned to Marketing by Admin" : "Waiting for Marketing to submit to Admin" : stage === 1 ? "Designer is working on the design" : "Request sent to designer"}</p>
    </> : <p className="type-body-r-s text-muted">{r ? "Brief saved · request not sent" : "No designer assignment"}</p>}
  </Card>;
}

function ActivitySection({ post }: { post: PostDetail }) {
  const events = [
    ...post.activity.filter((e) => !post.designInfo?.history.some((h) => (h.kind === "approved" && e.kind === "approved") || (h.kind === "returned" && e.kind === "revision"))).map((e) => ({ at: e.at, label: activityText(e, platformLabel), note: null as string | null, url: null as string | null })),
    ...(post.designInfo?.sentAt ? [{ at: post.designInfo.sentAt, label: `Design requested · ${post.designRequest?.assignee ?? "Designer removed"}`, note: null, url: null }] : []),
    ...(post.designInfo?.history ?? []).map((e) => ({ at: e.at, label: `${({ submitted: "Design submitted to Marketing", revision: "Design revision requested", review_submitted: "Marketing submitted to Admin", approved: "Approved by Admin", returned: "Admin returned content to Marketing" })[e.kind]}${e.by ? ` · ${e.by}` : ""}`, note: e.note, url: e.figmaUrl })),
  ].sort((a, b) => (a.at ? Date.parse(a.at) : Infinity) - (b.at ? Date.parse(b.at) : Infinity));
  return (
    <section aria-labelledby={`activity-title-${post.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={`activity-title-${post.id}`} className="type-body-sb-m text-fg">Activity</h3>
        <p className="type-body-r-xs text-muted-foreground">Oldest first</p>
      </div>
      <ol className="mt-3 space-y-2.5">
        {events.map((entry, i) => (
          <li key={i} className="relative border-l border-border pb-4 pl-5 type-body-r-s text-fg last:border-transparent last:pb-0">
            <span aria-hidden="true" className="absolute top-1 -left-1 size-2 rounded-full bg-brand-700" />
            <p className="break-words">{entry.label}</p>
            {entry.at && <p className="mt-1 type-body-r-xs text-muted">{longDate(entry.at)} · {timeWib(entry.at)}</p>}
            {entry.note && <p className="mt-2 rounded-lg bg-bg p-3 whitespace-pre-wrap break-words">{entry.note}</p>}
            {entry.url && <a href={entry.url} target="_blank" rel="noopener noreferrer" className="text-brand-800 underline">Open submitted design</a>}
          </li>
        ))}
      </ol>
    </section>
  );
}
