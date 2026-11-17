"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { PILLARS } from "@/lib/contentTypes";
import { platformLabel } from "@/lib/platforms";
import { FORMATS, PLATFORMS, type LibraryFilters, type StatusFilter } from "@/lib/template-library";

const BOX = "rounded-xl bg-neutral-50 px-3.5 py-2.5";

type FieldProps = { label: string; value: string; onChange: (value: string) => void; options: [value: string, label: string][] };

/** A filter: its name small on top, the choice under it. */
function Field({ label, value, onChange, options }: FieldProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className={cn("h-auto border-0", BOX)}>
        <span className="flex min-w-0 flex-col items-start text-left">
          <span className="type-body-r-xxs text-neutral-600">{label}</span>
          <SelectValue className="block truncate type-body-r-s text-neutral-600" />
        </span>
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, text]) => (
          <SelectItem key={v} value={v}>{text}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type Props = {
  filters: LibraryFilters;
  onChange: (next: LibraryFilters) => void;
  /** The design team: a status filter and the Upload button. */
  canManage: boolean;
  onUpload: () => void;
};

/** The card above the list: search, content pillar, format, platform and (for the design team) status, then Upload. */
export function TemplateFilters({ filters, onChange, canManage, onUpload }: Props) {
  const set = <K extends keyof LibraryFilters>(key: K, value: LibraryFilters[K]) => onChange({ ...filters, [key]: value });
  return (
    <Card className="border-0 p-5">
      <div className={canManage ? "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.5fr)_repeat(4,minmax(0,1fr))_auto]" : "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"}>
        <label className={cn("flex flex-col items-start focus-within:ring-2 focus-within:ring-ring/30", BOX)}>
          <span className="type-body-r-xxs text-neutral-600">Search</span>
          <Input
            type="search"
            value={filters.q}
            onChange={(e) => set("q", e.target.value)}
            placeholder="Search templates…"
            className="h-auto rounded-none border-0 bg-transparent p-0 text-neutral-600 placeholder:text-neutral-500 focus:ring-0"
          />
        </label>
        <Field
          label="Content pillar"
          value={filters.pillar}
          onChange={(v) => set("pillar", v as LibraryFilters["pillar"])}
          options={[["all", "All pillars"], ...PILLARS.map((p): [string, string] => [p, p]), ["none", "No pillar"]]}
        />
        <Field
          label="Content format"
          value={filters.format}
          onChange={(v) => set("format", v as LibraryFilters["format"])}
          options={[["all", "All formats"], ...FORMATS.map((f): [string, string] => [f.value, f.label])]}
        />
        <Field
          label="Publishing platform"
          value={filters.platform}
          onChange={(v) => set("platform", v as LibraryFilters["platform"])}
          options={[["all", "All platforms"], ...PLATFORMS.map((p): [string, string] => [p, platformLabel(p)])]}
        />
        {canManage && (
          <>
            <Field
              label="Template status"
              value={filters.status}
              onChange={(v) => set("status", v as StatusFilter)}
              options={[["all", "All statuses"], ["published", "Published"], ["draft", "Draft"]]}
            />
            <Button size="lg" className="h-full min-h-14 rounded-xl type-body-sb-m" onClick={onUpload}>
              Upload Template
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
