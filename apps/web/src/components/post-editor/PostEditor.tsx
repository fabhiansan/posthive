"use client";

import Link from "next/link";
import { FileTextIcon, LockIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { InlineAlert } from "@/components/InlineAlert";
import { TemplatesHeader } from "@/components/templates/TemplatesHeader";
import { TrialUrgentBanner } from "@/components/TrialUrgentBanner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/context/WorkspaceContext";
import { apiFetch } from "@/lib/api";
import { crumbLabel, pathOf, scheduledOf } from "@/lib/post-editor";
import { ActionBar } from "./ActionBar";
import { BasicInfoCard } from "./BasicInfoCard";
import { DesignPathCard } from "./DesignPathCard";
import { DesignRequestForm } from "./DesignRequestForm";
import { PreviewCard } from "./PreviewCard";
import { StatusStrip } from "./StatusStrip";
import { TemplatePicker } from "./TemplatePicker";
import { UploadDesignCard } from "./UploadDesignCard";
import { usePostEditor } from "./usePostEditor";
import { WorkflowCard } from "./WorkflowCard";

/**
 * The Edit Content page (docs/design/Edit Content · Path A, Path B), for a post that exists (`jobId`) and for a new one
 * (no `jobId`, the /compose address). One form: the basics, how the design is made (a template, or a designer), the
 * finished design, and on the right how it will look and where it stands.
 */
export function PostEditor({ jobId = null }: { jobId?: string | null }) {
  const editor = usePostEditor(jobId);
  const { activeWorkspace } = useWorkspace();
  const { form, set, job, stored, accounts, request, load, readOnlyReason, perms } = editor;
  // the post as the cards read it: a post that is not saved yet has none, and an answer with no approval is not in review
  const post = job ? { status: job.status, approvalStatus: job.approvalStatus ?? null, commentText: job.commentText, updatedAt: job.updatedAt } : null;
  const locked = readOnlyReason !== null;
  const canConnect = activeWorkspace?.role === "owner" || activeWorkspace?.role === "admin";

  const crumbs = [{ label: "Content List", href: "/jobs" }, { label: editor.isNew ? "New content" : `Edit content · ${crumbLabel(stored)}` }];
  const title = editor.isNew ? "Add Content" : "Edit Content";
  const subtitle = "Fill in the details, choose a design path, then submit to Admin for approval.";

  // What the design request may do right now: only a plain draft can have one, and a post in review has nothing left to design
  const inReview = editor.approvalStatus === "pending";
  const notDraft = editor.status !== "draft";
  const disabledB = notDraft ? "Only a draft can be sent to a designer." : inReview ? "This post is in review. Send it back first to ask for a design." : null;
  const disabledA = request?.status === "sent" ? "The design is with the designer. Cancel the request to use a template." : null;

  return (
    <div className="theme-dashboard flex-1 overflow-y-auto bg-background">
      <TrialUrgentBanner />
      <div className="mx-auto flex max-w-[110rem] flex-col gap-4 p-4 pt-16 md:p-6 md:pt-6">
        <TemplatesHeader crumbs={crumbs} title={title} subtitle={subtitle} />

        {load === "loading" && <Skeleton aria-busy="true" aria-label="Loading the post" className="h-96 rounded-2xl" />}

        {(load === "missing" || load === "error") && (
          <Card className="border-0">
            <EmptyState
              icon={<FileTextIcon />}
              title={load === "missing" ? "Post not found" : "We couldn't load the post"}
              description={load === "missing" ? "It was deleted, or it is a draft you can't see." : (editor.loadError ?? "Try again in a moment.")}
              action={<Button asChild variant="secondary" className="w-fit"><Link href="/jobs">Back to Content List</Link></Button>}
            />
          </Card>
        )}

        {load === "ready" && (
          <>
            <StatusStrip post={post} stored={stored} request={request} channels={accounts.filter((a) => form.accountIds.includes(a.id)).map((a) => a.platform)} />

            {readOnlyReason && (
              <InlineAlert tone="info" role="status" icon={<LockIcon />} title="This post can't be changed" className="border-0">
                {readOnlyReason}
              </InlineAlert>
            )}
            {!readOnlyReason && inReview && !perms.canReview && (
              <InlineAlert tone="info" role="status" className="border-0">
                This post is in review. A change to its content brings it back to Draft, and you send it again.
              </InlineAlert>
            )}

            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_26rem]">
              <div className="flex min-w-0 flex-col gap-4">
                <BasicInfoCard form={form} set={set} stored={stored} post={post} accounts={accounts} canConnect={canConnect} locked={locked} />

                <DesignPathCard
                  initial={pathOf(request, editor.template !== null)}
                  disabledA={disabledA}
                  disabledB={disabledB}
                  pathA={
                    <TemplatePicker
                      templates={editor.templates ?? []}
                      loading={editor.templatesLoading}
                      category={form.category}
                      picked={editor.template}
                      onPick={(t) => set({ pillar: t.pillar, category: t.category })}
                      canvasInstanceId={stored.canvasInstanceId ?? null}
                      canvasTemplateId={stored.canvasTemplateId ?? null}
                      ensurePost={editor.ensurePost}
                      onBusy={editor.setOpening}
                      onOpened={async (ids, id) => {
                        // saved at once, apart from the form: the design belongs to the post, and it is not an edit of its content
                        await apiFetch(`/jobs/${id}`, { method: "PATCH", body: JSON.stringify(ids) });
                        editor.noteCanvas(ids);
                      }}
                      disabled={locked}
                    />
                  }
                  pathB={
                    <DesignRequestForm
                      request={request}
                      publishAt={scheduledOf(form)?.toISOString() ?? null}
                      ensurePost={editor.ensureSaved}
                      onChange={editor.setRequest}
                      onDirtyChange={editor.setBriefDirty}
                      disabled={locked || disabledB !== null}
                    />
                  }
                />

                <UploadDesignCard
                  format={form.format}
                  mediaUrls={form.mediaUrls}
                  canvasDesigns={form.canvasDesigns}
                  platforms={accounts.filter((a) => form.accountIds.includes(a.id)).map((a) => a.platform)}
                  designFigmaUrl={form.designFigmaUrl}
                  onMedia={(change) => set(change)}
                  onFigma={(designFigmaUrl) => set({ designFigmaUrl })}
                  onBusy={editor.setUploading}
                  disabled={locked}
                />
              </div>

              <div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-6">
                <PreviewCard form={form} accounts={accounts} workspaceName={activeWorkspace?.name ?? "Your workspace"} templateName={editor.template?.category ?? null} request={request} />
                <WorkflowCard post={post} approvalFlow={editor.approvalFlow} />
              </div>
            </div>

            <ActionBar editor={editor} />
          </>
        )}
      </div>
    </div>
  );
}
