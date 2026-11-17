import { PILLARS, type Pillar } from "./contentTypes";
import { wibDateKey } from "./datetime";
import { shortName } from "./dashboard-format";
import { formatPlanDate } from "./import-rows";
import { platformLabel } from "./platforms";
import type { DesignTemplate, TemplateFormat, TemplatePlatform } from "./templates";

// The Template Library page (docs/design/designer-template.png): what a card says, how the list is filtered, counted,
// paged and exported. The design team sees drafts and published templates; Marketing is sent published ones only.

export const PAGE_SIZE = 8;

export const FORMATS: { value: TemplateFormat; label: string }[] = [
  { value: "carousel", label: "Carousel" },
  { value: "single", label: "Single image" },
  { value: "reel_cover", label: "Reel cover" },
  { value: "story", label: "Story" },
  { value: "video", label: "Video" },
];

export const PLATFORMS: TemplatePlatform[] = ["instagram", "linkedin"];

/** Slides a carousel may have (the API refuses anything else). */
export const MIN_SLIDES = 2;
export const MAX_SLIDES = 20;

const RATIO: Partial<Record<TemplateFormat, string>> = { reel_cover: "9:16", story: "9:16" };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ── What a card says ────────────────────────────────────────────────────────

/** "Carousel · 5 slides", "Single image", "Reel cover · 9:16"; null when the designer left the format out. */
export function formatText(t: Pick<DesignTemplate, "format" | "slides">): string | null {
  if (!t.format) return null;
  const label = FORMATS.find((f) => f.value === t.format)?.label ?? t.format;
  if (t.format === "carousel" && t.slides) return `${label} · ${t.slides} slides`;
  const ratio = RATIO[t.format];
  return ratio ? `${label} · ${ratio}` : label;
}

/** The line under a title: "Educational · Carousel · 5 slides". */
export function subLine(t: Pick<DesignTemplate, "pillar" | "format" | "slides">): string {
  return `${t.pillar ?? "No pillar"} · ${formatText(t) ?? "No format yet"}`;
}

/** "LinkedIn · Instagram", or null when none is set. */
export function platformsText(platforms: readonly string[]): string | null {
  return platforms.length === 0 ? null : platforms.map(platformLabel).join(" · ");
}

/** "figma.com/design/Pt3mPl8/Insight-Carousel": the link without its scheme and "www."; no link says so. */
export function linkLabel(url: string | null): string {
  if (!url) return "No Figma link yet";
  return url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
}

/** "Created 12 Nov 2026 · Dewi K." in WIB; the person is left out when the account is gone. */
export function createdLine(t: Pick<DesignTemplate, "createdAt" | "createdBy">): string {
  const at = new Date(t.createdAt);
  if (Number.isNaN(at.getTime())) return "";
  const who = shortName(t.createdBy);
  return `Created ${formatPlanDate(wibDateKey(at))}${who ? ` · ${who}` : ""}`;
}

// ── Filter, count, page ─────────────────────────────────────────────────────

export type StatusFilter = "all" | "published" | "draft";

export interface LibraryFilters {
  q: string;
  /** A pillar, "none" (Ask Me Anything) or "all". */
  pillar: Pillar | "none" | "all";
  format: TemplateFormat | "all";
  platform: TemplatePlatform | "all";
  status: StatusFilter;
}

export const NO_FILTERS: LibraryFilters = { q: "", pillar: "all", format: "all", platform: "all", status: "all" };

export function isFiltered(f: LibraryFilters): boolean {
  return (Object.keys(NO_FILTERS) as (keyof LibraryFilters)[]).some((k) => f[k] !== NO_FILTERS[k]);
}

const haystack = (t: DesignTemplate) => [t.category, t.pillar, formatText(t), t.createdBy].filter(Boolean).join(" ").toLowerCase();

/** The templates that pass every filter, newest created first. */
export function filterTemplates(list: readonly DesignTemplate[], f: LibraryFilters): DesignTemplate[] {
  const q = f.q.trim().toLowerCase();
  return list
    .filter((t) => {
      if (f.status !== "all" && t.published !== (f.status === "published")) return false;
      if (f.pillar !== "all" && (f.pillar === "none" ? t.pillar !== null : t.pillar !== f.pillar)) return false;
      if (f.format !== "all" && t.format !== f.format) return false;
      if (f.platform !== "all" && !t.platforms.includes(f.platform)) return false;
      return q === "" || haystack(t).includes(q);
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export interface LibraryCounts {
  total: number;
  published: number;
  draft: number;
  /** How many of the four pillars have a published template. */
  pillars: number;
}

export function libraryCounts(list: readonly DesignTemplate[]): LibraryCounts {
  const published = list.filter((t) => t.published);
  const pillars = PILLARS.filter((p) => published.some((t) => t.pillar === p)).length;
  return { total: list.length, published: published.length, draft: list.length - published.length, pillars };
}

export interface TemplatePage {
  items: DesignTemplate[];
  page: number;
  pageCount: number;
}

/** One page of a list; a page past the end is the last one. */
export function pageOf(list: readonly DesignTemplate[], page: number): TemplatePage {
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pageCount);
  return { items: list.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE), page: current, pageCount };
}

/** "Showing 8 of 24 templates · Drafts are visible to Designers only" */
export function footerLine(shown: number, total: number, drafts: boolean): string {
  const base = `Showing ${shown} of ${plural(total, "template", "templates")}`;
  return drafts ? `${base} · Drafts are visible to Designers only` : base;
}

/** "Marketing currently sees 18 published templates across 5 content pillars." */
export function marketingLine(c: LibraryCounts): string {
  if (c.published === 0) return "Marketing currently sees no published templates.";
  return `Marketing currently sees ${plural(c.published, "published template", "published templates")} across ${plural(c.pillars, "content pillar", "content pillars")}.`;
}

// ── Export ──────────────────────────────────────────────────────────────────

const CSV_HEAD = ["Category", "Pillar", "Format", "Platforms", "Status", "Figma link", "Created", "Created by"];

// A spreadsheet reads a cell that starts with one of these as a formula, and a name or a link is typed by a person
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** The templates as CSV, one row each, in the order given. */
export function toCsv(list: readonly DesignTemplate[]): string {
  const rows = list.map((t) => {
    const at = new Date(t.createdAt);
    return [
      t.category,
      t.pillar ?? "No pillar",
      formatText(t) ?? "",
      t.platforms.map(platformLabel).join(", "),
      t.published ? "Published" : "Draft",
      t.linkUrl ?? "",
      Number.isNaN(at.getTime()) ? "" : wibDateKey(at),
      t.createdBy ?? "",
    ];
  });
  return [CSV_HEAD, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** Gives the browser a file to save. */
export function downloadCsv(name: string, csv: string): void {
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
