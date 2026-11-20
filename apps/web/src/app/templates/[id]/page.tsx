"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ExternalLinkIcon, EyeOffIcon, GlobeIcon, LayoutTemplateIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { InlineAlert } from "@/components/InlineAlert";
import { TemplateEditor } from "@/components/TemplateEditor";
import { CanvasDesignBlock } from "@/components/templates/CanvasDesignBlock";
import { CustomizeButton } from "@/components/templates/CustomizeButton";
import { DeleteTemplateDialog, UnpublishTemplateDialog } from "@/components/templates/TemplateDialogs";
import { CaptionCard, ChecklistCard, DetailCard, DetailsCard, MetaStrip, SlidesCard } from "@/components/templates/TemplateDetailCards";
import { TemplateFeedMockup } from "@/components/templates/TemplateFeedMockup";
import { TemplateStatus } from "@/components/templates/TemplateStatus";
import { TemplatesHeader } from "@/components/templates/TemplatesHeader";
import { useToast } from "@/components/Toast";
import { TrialUrgentBanner } from "@/components/TrialUrgentBanner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/context/WorkspaceContext";
import { apiFetch } from "@/lib/api";
import { publishBlockedReason } from "@/lib/template-library";
import { isFigmaLink, type DesignTemplate } from "@/lib/templates";
import { usePermissions } from "@/lib/usePermissions";
import { useTemplates } from "@/lib/useTemplates";

/**
 * One template on its own page (docs/design/designer-02b-template-detail.png). The design team edits it, publishes it to
 * Marketing or takes it back to a draft, and deletes it; both of those ask first and say so in a toast under the header.
 * Marketing, who is sent published templates only, opens the design and uses the template.
 */
export default function TemplateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { canManageTemplates: canManage, canEditContent: canUse } = usePermissions();
  const { activeWorkspace } = useWorkspace();
  // The toasts of the Template Library sit under the header's bell and avatar, not in the corner
  const { success, error: toastError } = useToast("top-right");
  const { data, loading, error, reload } = useTemplates();

  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const [switching, setSwitching] = useState(false);

  const template: DesignTemplate | undefined = data?.templates.find((t) => t.id === id);

  async function setPublished(published: boolean) {
    if (!template) return;
    setSwitching(true);
    try {
      await apiFetch(`/templates/${template.id}/status`, { method: "PATCH", body: JSON.stringify({ published }) });
      success(published ? `${template.category} published. Marketing can see it now.` : `${template.category} unpublished. Marketing no longer sees it.`);
      reload();
    } catch (e) {
      toastError(e instanceof Error && e.message ? e.message : "Couldn't change the status. Try again.");
      throw e;
    } finally {
      setSwitching(false);
    }
  }

  async function remove() {
    if (!template) return;
    try {
      await apiFetch(`/templates/${template.id}`, { method: "DELETE" });
    } catch (e) {
      toastError(e instanceof Error && e.message ? e.message : "Couldn't delete the template.");
      throw e;
    }
    success(`${template.category} template deleted.`);
    router.push("/templates");
  }

  const crumbs = [{ label: canManage ? "Design workspace" : "Assets" }, { label: "Template Library", href: "/templates" }, { label: template?.category ?? "Template" }];
  const blocked = template ? publishBlockedReason(template) : null;

  let subtitle: string | undefined;
  if (template) {
    if (!canManage) subtitle = "A reference design from the design team. It is never attached to a post.";
    else if (template.published) subtitle = `Published template · listed under ${template.pillar ?? "no pillar"} in Marketing's Pick from templates. Marketing opens the design from the Figma link or the preview below.`;
    else subtitle = "Draft template · Marketing cannot see it yet. Publish it to list it in Marketing's Pick from templates.";
  }

  return (
    <div className="theme-dashboard flex-1 overflow-y-auto bg-background">
      <TrialUrgentBanner />
      <div className="mx-auto flex max-w-[110rem] flex-col gap-4 p-4 pt-16 md:p-6 md:pt-6">
        <TemplatesHeader
          crumbs={crumbs}
          title={template?.category ?? "Template"}
          badge={template && canManage ? <TemplateStatus published={template.published} /> : undefined}
          subtitle={subtitle}
        />

        {error && (
          <InlineAlert tone="danger" title="We couldn't load the template">
            {error}{" "}
            <button type="button" onClick={reload} className="cursor-pointer underline underline-offset-2">
              Try again
            </button>
          </InlineAlert>
        )}

        {loading && !data && <Skeleton aria-busy="true" aria-label="Loading the template" className="h-96 rounded-2xl" />}

        {data && !template && (
          <Card className="border-0">
            <EmptyState
              icon={<LayoutTemplateIcon />}
              title="Template not found"
              description="It was deleted, or it is a draft the design team has not published yet."
              action={
                <Button asChild variant="secondary" className="w-fit">
                  <Link href="/templates">Back to library</Link>
                </Button>
              }
            />
          </Card>
        )}

        {template && (
          <>
            <MetaStrip template={template} canManage={canManage} />

            {canManage && !template.published && (
              <InlineAlert tone="warning" role="status" icon={<EyeOffIcon />} title="This template is a draft" className="border-0">
                Marketing cannot see it. Publish it to list it in Compose and show it as the design reference for {template.category} posts.
              </InlineAlert>
            )}

            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_26rem]">
              <div className="flex min-w-0 flex-col gap-4">
                <DetailCard title="Template preview" headingId="preview-heading" hint="Master design · shown in a feed mockup">
                  <TemplateFeedMockup template={template} account={activeWorkspace?.name ?? "Your workspace"} />
                </DetailCard>
                <SlidesCard template={template} />
                <CaptionCard template={template} canManage={canManage} />
              </div>

              <div className="flex min-w-0 flex-col gap-4">
                <DetailsCard template={template} canManage={canManage} />
                {canManage && (
                  <Card className="border-0 p-5">
                    <CanvasDesignBlock template={template} onChanged={reload} />
                  </Card>
                )}
                {canManage && <ChecklistCard template={template} />}
              </div>
            </div>

            {/* The bar sticks to the bottom on wide screens only: on a phone it would cover a fifth of the page. The reason is visible text, not only a tooltip: a disabled button takes no focus and a tooltip does not show on touch. */}
            <Card className="z-10 flex-row flex-wrap items-center gap-x-4 gap-y-3 border-0 px-5 py-4 shadow-sm lg:sticky lg:bottom-0">
              <div className="min-w-0 flex-1 basis-60 type-body-r-xs text-muted">
                {canManage && !template.published && blocked ? (
                  <p id="publish-reason" role="status" className="text-brand-800">{blocked}</p>
                ) : canManage ? (
                  <p>{template.published ? `Published · Marketing sees this template under ${template.category} in Choose Template.` : "Draft · only the design team sees this template."}</p>
                ) : (
                  <p>Published by the design team.</p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild variant="ghost">
                  <Link href="/templates">Back to library</Link>
                </Button>
                {canManage ? (
                  <>
                    <Button variant="ghost" className="text-red-600 hover:bg-red-50 hover:text-red-600" onClick={() => setDeleting(true)}>
                      <Trash2Icon />
                      Delete
                    </Button>
                    {template.published ? (
                      <Button variant="destructive-outline" disabled={switching} onClick={() => setUnpublishing(true)}>
                        <EyeOffIcon />
                        Unpublish
                      </Button>
                    ) : (
                      <Button
                        disabled={switching || blocked !== null}
                        title={blocked ?? undefined}
                        aria-describedby={blocked ? "publish-reason" : undefined}
                        onClick={() => void setPublished(true).catch(() => {})}
                      >
                        <GlobeIcon />
                        Publish
                      </Button>
                    )}
                    <Button variant={template.published ? "default" : "secondary"} onClick={() => setEditing(true)}>
                      <PencilIcon />
                      Edit template
                    </Button>
                  </>
                ) : (
                  <>
                    {template.linkUrl && (
                      <Button asChild variant="secondary">
                        <a href={template.linkUrl} target="_blank" rel="noopener noreferrer">
                          <ExternalLinkIcon />
                          {isFigmaLink(template.linkUrl) ? "Open in Figma" : "Open link"}
                        </a>
                      </Button>
                    )}
                    {canUse && <Button onClick={() => router.push(`/compose?template=${template.id}`)}>Use template</Button>}
                    {canUse && template.canvasRevision != null && <CustomizeButton template={template} size="default" label="Customize in Canvas" />}
                  </>
                )}
              </div>
            </Card>
          </>
        )}
      </div>

      {editing && template && (
        <TemplateEditor
          template={template}
          takenCategories={new Set(data?.templates.map((t) => t.category))}
          onClose={() => setEditing(false)}
          onSaved={(t) => {
            setEditing(false);
            success(`${t.category} template updated.`);
            reload();
          }}
        />
      )}

      <UnpublishTemplateDialog template={unpublishing && template ? template : null} onOpenChange={setUnpublishing} onConfirm={() => setPublished(false)} />
      <DeleteTemplateDialog template={deleting && template ? template : null} onOpenChange={setDeleting} onConfirm={remove} />
    </div>
  );
}
