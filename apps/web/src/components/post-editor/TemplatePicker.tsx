"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CheckIcon, CircleHelpIcon, SearchIcon } from "lucide-react";
import { FilterChips } from "@/components/FilterChips";
import { TemplateCover } from "@/components/templates/TemplateCover";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { cn } from "@/lib/cn";
import { PILLARS, normalizeCategory } from "@/lib/contentTypes";
import { FORMATS, NO_FILTERS, filterTemplates, subLine, type LibraryFilters } from "@/lib/template-library";
import type { DesignTemplate } from "@/lib/templates";
import { StudioButton } from "./StudioButton";

type Props = {
  /** The published templates (Marketing is sent nothing else). */
  templates: DesignTemplate[];
  loading: boolean;
  /** The category the post has, which is the picked template. */
  category: string | null;
  onPick: (template: DesignTemplate) => void;
  /** The template of the post's category, for the Studio button. */
  picked: DesignTemplate | null;
  canvasInstanceId: string | null;
  canvasTemplateId: string | null;
  /** The post the Studio saves its export back to. */
  postId: string | null;
  ensurePost: () => Promise<string>;
  onOpened: (ids: { canvasInstanceId: string; canvasTemplateId: string }, postId: string) => Promise<void>;
  /** The Studio is being opened (true) or is open (false). */
  onBusy: (busy: boolean) => void;
  disabled?: boolean;
};

const ALL = "all";

/** Path A: pick one of the published templates, then open it in the Studio. Picking only fills the pillar and the category. */
export function TemplatePicker({ templates, loading, category, onPick, picked, canvasInstanceId, canvasTemplateId, postId, ensurePost, onOpened, onBusy, disabled }: Props) {
  const [filters, setFilters] = useState<LibraryFilters>(NO_FILTERS);
  const [chip, setChip] = useState(ALL);

  // the chips are the categories of the templates that pass the other filters
  const passing = useMemo(() => filterTemplates(templates, filters), [templates, filters]);
  const categories = useMemo(() => [...new Set(passing.map((t) => t.category))], [passing]);
  const shown = chip === ALL ? passing : passing.filter((t) => t.category === chip);
  const current = normalizeCategory(category);

  return (
    <div className="flex flex-col gap-4 rounded-xl bg-brand-100/50 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="type-body-sb-m text-fg">Path A · Choose a template</h3>
          <p className="type-body-r-xs text-muted">Choose a design template to get started, or explore more in the template library.</p>
        </div>
        <Link href="/templates" className="type-body-sb-xs text-brand-800 underline-offset-2 hover:underline">View all templates</Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1.4fr]">
        <label className="block rounded-xl bg-surface px-3 py-2">
          <span className="block type-body-r-xxs text-muted">Content pillar</span>
          <NativeSelect value={filters.pillar} onChange={(e) => { setFilters({ ...filters, pillar: e.target.value as LibraryFilters["pillar"] }); setChip(ALL); }} className="border-0 bg-transparent p-0 pr-7" aria-label="Content pillar">
            <NativeSelectOption value={ALL}>All pillars</NativeSelectOption>
            {PILLARS.map((p) => <NativeSelectOption key={p} value={p}>{p}</NativeSelectOption>)}
          </NativeSelect>
        </label>
        <label className="block rounded-xl bg-surface px-3 py-2">
          <span className="block type-body-r-xxs text-muted">Content format</span>
          <NativeSelect value={filters.format} onChange={(e) => { setFilters({ ...filters, format: e.target.value as LibraryFilters["format"] }); setChip(ALL); }} className="border-0 bg-transparent p-0 pr-7" aria-label="Content format">
            <NativeSelectOption value={ALL}>All formats</NativeSelectOption>
            {FORMATS.map((f) => <NativeSelectOption key={f.value} value={f.value}>{f.label}</NativeSelectOption>)}
          </NativeSelect>
        </label>
        <label className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2">
          <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-neutral-500" />
          <Input type="search" value={filters.q} onChange={(e) => { setFilters({ ...filters, q: e.target.value }); setChip(ALL); }} placeholder="Search template…" aria-label="Search template" className="h-auto rounded-none border-0 bg-transparent p-0 focus:ring-0" />
        </label>
      </div>

      {categories.length > 1 && (
        <FilterChips
          label="Category"
          value={chip}
          onChange={setChip}
          options={[{ value: ALL, label: "All" }, ...categories.map((c) => ({ value: c, label: c }))]}
          className="flex-wrap"
          itemClassName="rounded-full px-3 py-1"
        />
      )}

      {loading && templates.length === 0 ? (
        <p role="status" className="type-body-r-s text-muted">Loading templates…</p>
      ) : shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center type-body-r-s text-muted">
          {templates.length === 0 ? "The design team has not published a template yet. Ask a designer for this post instead (Path B)." : "No template matches. Clear a filter to see more."}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {shown.map((t) => {
            const on = current !== null && normalizeCategory(t.category) === current;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => onPick(t)}
                  className={cn("relative flex h-full w-full cursor-pointer flex-col gap-2 rounded-xl border bg-surface p-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60", on ? "border-brand-500 ring-1 ring-brand-500" : "border-border hover:bg-neutral-50")}
                >
                  <TemplateCover template={t} className="aspect-4/5" />
                  {on && (
                    <span className="absolute top-3 right-3 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground" aria-hidden="true">
                      <CheckIcon className="size-3.5" />
                    </span>
                  )}
                  <span className="min-w-0 px-1 pb-1">
                    <span className="block truncate type-body-sb-xs text-fg">{t.category}</span>
                    <span className="block truncate type-body-r-xxs text-muted">{subLine(t)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex min-w-0 flex-1 basis-60 items-start gap-2 type-body-r-xs text-muted">
          <CircleHelpIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          The selected template opens in the design Studio, where you can customize its text and images. Export it, then upload the result below.
        </p>
        {picked ? (
          <StudioButton template={picked} canvasInstanceId={canvasInstanceId} canvasTemplateId={canvasTemplateId} postId={postId} ensurePost={ensurePost} onOpened={onOpened} onBusy={onBusy} disabled={disabled} />
        ) : (
          <p className="type-body-r-xs text-muted">Pick a template to open it in the Studio.</p>
        )}
      </div>
    </div>
  );
}
