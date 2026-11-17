"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeftIcon, ExternalLinkIcon, EyeOffIcon, GlobeIcon, LayoutTemplateIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { InlineAlert } from "@/components/InlineAlert";
import { TemplateEditor } from "@/components/TemplateEditor";
import { TemplateCover } from "@/components/templates/TemplateCover";
import { TemplateStatus } from "@/components/templates/TemplateStatus";
import { TemplatesHeader } from "@/components/templates/TemplatesHeader";
import { useToast } from "@/components/Toast";
import { TrialUrgentBanner } from "@/components/TrialUrgentBanner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { createdLine, formatText, linkLabel, platformsText } from "@/lib/template-library";
import { isFigmaLink, type DesignTemplate } from "@/lib/templates";
import { usePermissions } from "@/lib/usePermissions";
import { useTemplates } from "@/lib/useTemplates";
import { wibDateKey } from "@/lib/datetime";
import { formatPlanDate } from "@/lib/import-rows";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 border-b border-border/60 py-3 last:border-b-0">
      <dt className="type-body-r-s text-neutral-500">{label}</dt>
      <dd className="min-w-0 break-words type-body-m-s text-neutral-900">{children}</dd>
    </div>
  );
}

/**
 * One template on its own page. The design team edits it, publishes it to Marketing or takes it back to a draft, and
 * deletes it. Marketing, who is sent published templates only, opens the design and uses the template.
 */
export default function TemplateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { canManageTemplates: canManage, canEditContent: canUse } = usePermissions();
  const { success, error: toastError } = useToast();
  const { data, loading, error, reload } = useTemplates();

  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [switching, setSwitching] = useState(false);

  const template: DesignTemplate | undefined = data?.templates.find((t) => t.id === id);
  const back = (
    <Button asChild variant="secondary" className="w-fit">
      <Link href="/templates">
        <ArrowLeftIcon />
        Back to templates
      </Link>
    </Button>
  );

  async function setPublished(published: boolean) {
    if (!template) return;
    setSwitching(true);
    try {
      await apiFetch(`/templates/${template.id}/status`, { method: "PATCH", body: JSON.stringify({ published }) });
      success(published ? "Published. Marketing can see it now." : "Moved to draft. Marketing no longer sees it.");
      reload();
    } catch (e) {
      toastError(e instanceof Error && e.message ? e.message : "Couldn't change the status. Try again.");
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
    success(`Template for ${template.category} deleted.`);
    router.push("/templates");
  }

  const crumbs = [{ label: canManage ? "Design workspace" : "Assets" }, { label: "Template Library", href: "/templates" }, { label: template?.category ?? "Template" }];
  const updated = template?.updatedAt ? formatPlanDate(wibDateKey(new Date(template.updatedAt))) : null;

  return (
    <div className="theme-dashboard flex-1 overflow-y-auto bg-background">
      <TrialUrgentBanner />
      <div className="mx-auto flex max-w-[110rem] flex-col gap-4 p-4 pt-16 md:p-6 md:pt-6">
        <TemplatesHeader
          crumbs={crumbs}
          title={template?.category ?? "Template"}
          badge={template && canManage ? <TemplateStatus published={template.published} /> : undefined}
          subtitle={template ? (canManage ? "Publish it to share the design with Marketing, or keep it as a draft." : "A reference design from the design team. It is never attached to a post.") : undefined}
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
              action={back}
            />
          </Card>
        )}

        {template && (
          <Card className="gap-6 border-0 p-5 lg:flex-row lg:p-6">
            <TemplateCover template={template} className="aspect-4/5 w-full max-w-sm self-start lg:w-2/5" />

            <div className="flex min-w-0 flex-1 flex-col gap-5">
              {canManage && !template.published && (
                <InlineAlert tone="warning" role="status" icon={<EyeOffIcon />} title="This template is a draft" className="border-0">
                  Marketing cannot see it. Publish it to list it in Compose and show it as the design reference for {template.category} posts.
                </InlineAlert>
              )}

              <dl>
                <Row label="Content pillar">{template.pillar ?? "No pillar"}</Row>
                <Row label="Content category">{template.category}</Row>
                <Row label="Content format">{formatText(template) ?? "No format yet"}</Row>
                <Row label="Publishing platforms">{platformsText(template.platforms) ?? "No platform yet"}</Row>
                <Row label="Figma link">
                  {template.linkUrl ? (
                    <a href={template.linkUrl} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1.5 text-brand-800 underline-offset-4 hover:underline">
                      <span className="truncate">{linkLabel(template.linkUrl)}</span>
                      <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    </a>
                  ) : (
                    "No Figma link yet"
                  )}
                </Row>
                <Row label="Created">{createdLine(template).replace(/^Created /, "")}</Row>
                {updated && <Row label="Last updated">{updated}</Row>}
              </dl>

              <div className="mt-auto flex flex-wrap items-center gap-2">
                {back}
                {canManage ? (
                  <>
                    <Button variant="secondary" onClick={() => setEditing(true)}>
                      <PencilIcon />
                      Edit
                    </Button>
                    <Button variant={template.published ? "secondary" : "default"} disabled={switching} onClick={() => void setPublished(!template.published)}>
                      {template.published ? <EyeOffIcon /> : <GlobeIcon />}
                      {template.published ? "Unpublish" : "Publish"}
                    </Button>
                    <Button variant="destructive-outline" onClick={() => setDeleting(true)}>
                      <Trash2Icon />
                      Delete
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
                    {canUse && (
                      <Button onClick={() => router.push(`/compose?template=${template.id}`)}>Use template</Button>
                    )}
                  </>
                )}
              </div>
            </div>
          </Card>
        )}
      </div>

      {editing && template && (
        <TemplateEditor
          template={template}
          takenCategories={new Set(data?.templates.map((t) => t.category))}
          onClose={() => setEditing(false)}
          onSaved={(t) => {
            setEditing(false);
            success(`Template for ${t.category} updated.`);
            reload();
          }}
        />
      )}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this template?"
        description={template && `The template for ${template.category} and its preview are removed, and Marketing no longer sees a design reference for this category. Existing posts are not changed.`}
        confirmLabel="Delete template"
        pendingLabel="Deleting…"
        onConfirm={remove}
      />
    </div>
  );
}
