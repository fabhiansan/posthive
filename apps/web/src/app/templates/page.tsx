"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DownloadIcon, InfoIcon, LayoutTemplateIcon, SearchXIcon, UploadIcon } from "lucide-react";
import { DesignStat } from "@/components/dashboard/designer/DesignStat";
import { EmptyState } from "@/components/EmptyState";
import { InlineAlert } from "@/components/InlineAlert";
import { Pager } from "@/components/Pager";
import { TemplateEditor } from "@/components/TemplateEditor";
import { TemplateCard } from "@/components/templates/TemplateCard";
import { DeleteTemplateDialog } from "@/components/templates/TemplateDialogs";
import { TemplateFilters } from "@/components/templates/TemplateFilters";
import { TemplatesHeader } from "@/components/templates/TemplatesHeader";
import { useToast } from "@/components/Toast";
import { TrialUrgentBanner } from "@/components/TrialUrgentBanner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/cn";
import { NO_FILTERS, downloadCsv, filterTemplates, footerLine, isFiltered, libraryCounts, marketingLine, pageOf, toCsv, type LibraryFilters, type StatusFilter } from "@/lib/template-library";
import type { DesignTemplate } from "@/lib/templates";
import { useTemplates } from "@/lib/useTemplates";
import { usePermissions } from "@/lib/usePermissions";

const TABS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All templates" },
  { value: "published", label: "Published" },
  { value: "draft", label: "Draft" },
];

/**
 * The Template Library (docs/design/designer-template.png). The design team sees every template, drafts included, and
 * uploads and deletes them; a draft is published or taken back on the template's own page. Marketing sees the
 * published ones only (the API sends nothing else), can open one and use it, and gets none of the controls.
 */
export default function TemplatesPage() {
  const router = useRouter();
  const { canManageTemplates: canManage, canEditContent: canUse } = usePermissions();
  // The toasts of the Template Library sit under the header's bell and avatar, not in the corner
  const { success, danger, error: toastError } = useToast("top-right");
  const { data, loading, error, reload } = useTemplates();

  const [filters, setFilters] = useState<LibraryFilters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<DesignTemplate | null>(null);

  const all = useMemo(() => data?.templates ?? [], [data]);
  const counts = useMemo(() => libraryCounts(all), [all]);
  const shown = useMemo(() => filterTemplates(all, filters), [all, filters]);
  const current = pageOf(shown, page);
  const taken = useMemo(() => new Set(all.map((t) => t.category)), [all]);

  function change(next: LibraryFilters) {
    setFilters(next);
    setPage(1);
  }

  async function remove() {
    if (!deleting) return;
    const { id, category } = deleting;
    try {
      await apiFetch(`/templates/${id}`, { method: "DELETE" });
      danger(`${category} template deleted.`);
      reload();
    } catch (e) {
      toastError(e instanceof Error && e.message ? e.message : "Couldn't delete the template.");
      throw e;
    }
  }

  const title = canManage ? "Master Template" : "Template Library";
  const subtitle = canManage
    ? "Templates you publish here appear in the Marketing Team's Pick from templates list in Compose."
    : "The design team's published designs. Open one as a reference when you make a post.";

  return (
    <div className="theme-dashboard flex-1 overflow-y-auto bg-background">
      <TrialUrgentBanner />
      <div className="mx-auto flex max-w-[110rem] flex-col gap-4 p-4 pt-16 md:p-6 md:pt-6">
        <TemplatesHeader
          crumbs={[{ label: canManage ? "Design workspace" : "Assets" }, { label: "Template Library" }]}
          title={title}
          subtitle={subtitle}
        />

        {error && (
          <InlineAlert tone="danger" title={data ? "Couldn't refresh the templates" : "We couldn't load the templates"}>
            {error}{" "}
            <button type="button" onClick={reload} className="cursor-pointer underline underline-offset-2">
              Try again
            </button>
          </InlineAlert>
        )}

        {loading && !data && (
          <div aria-busy="true" aria-label="Loading the templates" className="space-y-4">
            <Skeleton className="h-24 rounded-2xl" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
            </div>
            <Skeleton className="h-96 rounded-2xl" />
          </div>
        )}

        {data && (
          <>
            <TemplateFilters filters={filters} onChange={change} canManage={canManage} onUpload={() => setUploading(true)} />

            {canManage && (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <DesignStat value={counts.total} label="Total templates" />
                  <DesignStat value={counts.published} label="Published · visible to Marketing" tone="good" />
                  <DesignStat value={counts.draft} label="Draft · hidden from Marketing" tone="warn" />
                  <DesignStat value={counts.pillars} label="Content pillars covered" />
                </div>
                <InlineAlert tone="warning" role="status" icon={<InfoIcon />} title="Published templates are shared with the Marketing Team" className="border-0">
                  Drafts stay hidden. Once published, a template is listed in Compose under Pick from templates and shows as the design reference for posts of its category.
                </InlineAlert>
              </>
            )}

            <Card className="gap-4 border-0 p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                {canManage ? (
                  <Tabs value={filters.status} onValueChange={(v) => change({ ...filters, status: v as StatusFilter })} className="min-w-0 max-w-full">
                    <TabsList aria-label="Template status" className="max-w-full flex-wrap justify-start border-0 bg-transparent p-0">
                      {TABS.map((tab) => (
                        <TabsTrigger key={tab.value} value={tab.value} className="group-data-[variant=default]/tabs-list:px-4 group-data-[variant=default]/tabs-list:py-2 group-data-[variant=default]/tabs-list:data-[state=active]:bg-neutral-50 group-data-[variant=default]/tabs-list:data-[state=active]:text-fg">
                          {tab.label}
                          <span className={cn("min-w-5 rounded-full px-1.5 text-center type-body-sb-xxs tabular-nums", tab.value === "all" ? "bg-brand-100 text-neutral-950" : "bg-green-600/10 text-green-700")}>
                            {tab.value === "all" ? counts.total : tab.value === "published" ? counts.published : counts.draft}
                          </span>
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                ) : (
                  <p className="type-body-sb-s text-brand-950">Published templates</p>
                )}
                <p className="type-body-r-xs text-neutral-500">Sorted by created date · newest first</p>
              </div>

              {all.length === 0 ? (
                <EmptyState
                  size="compact"
                  icon={<LayoutTemplateIcon />}
                  title={canManage ? "No templates yet" : "No published templates yet"}
                  description={
                    canManage
                      ? "Upload the first design for a content category. It stays a draft, hidden from Marketing, until you publish it."
                      : "The design team has not published a template yet. They appear here once they do."
                  }
                  action={
                    canManage && (
                      <Button onClick={() => setUploading(true)}>
                        <UploadIcon />
                        Upload Template
                      </Button>
                    )
                  }
                />
              ) : shown.length === 0 ? (
                <EmptyState
                  size="compact"
                  icon={<SearchXIcon />}
                  title="No templates match"
                  description="Nothing fits the search and filters you picked."
                  action={isFiltered(filters) && <Button variant="secondary" onClick={() => change(NO_FILTERS)}>Clear filters</Button>}
                />
              ) : (
                <>
                  <ul aria-label="Templates" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {current.items.map((t) => (
                      <TemplateCard
                        key={t.id}
                        template={t}
                        canManage={canManage}
                        canUse={canUse}
                        onDelete={() => setDeleting(t)}
                        onUse={() => router.push(`/compose?template=${t.id}`)}
                      />
                    ))}
                  </ul>
                  <div className="flex flex-wrap items-center justify-between gap-2 type-body-r-xs text-neutral-500">
                    <p aria-live="polite">{footerLine(current.items.length, shown.length, canManage)}</p>
                    <Pager page={current.page} pageCount={current.pageCount} onPage={setPage} />
                  </div>
                </>
              )}
            </Card>

            {canManage && (
              <Card className="flex-row flex-wrap items-center justify-between gap-3 border-0 px-5 py-4">
                <p className="type-body-r-s text-neutral-600">{marketingLine(counts)}</p>
                <Button
                  variant="secondary"
                  className="border-neutral-600 bg-transparent text-neutral-600 hover:bg-neutral-50"
                  disabled={shown.length === 0}
                  onClick={() => downloadCsv("templates.csv", toCsv(shown))}
                >
                  <DownloadIcon />
                  Export list
                </Button>
              </Card>
            )}
          </>
        )}
      </div>

      {uploading && (
        <TemplateEditor
          template={null}
          takenCategories={taken}
          onClose={() => setUploading(false)}
          onSaved={(t) => {
            setUploading(false);
            success(`${t.category} template saved as a draft. Open it to publish.`);
            reload();
          }}
        />
      )}

      <DeleteTemplateDialog template={deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }} onConfirm={remove} />
    </div>
  );
}
