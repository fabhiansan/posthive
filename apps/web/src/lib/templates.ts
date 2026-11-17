import { normalizeCategory, type Category, type Pillar } from "./contentTypes";
import { figmaLinkError } from "./figmaLink";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

// Design template as returned by GET /templates (docs/content-types.md): the reference
// design for one content type. A post only takes its pillar and category, never its files.
export type TemplateFormat = "carousel" | "single" | "reel_cover" | "story" | "video";
export type TemplatePlatform = "instagram" | "linkedin";

export interface DesignTemplate {
  id: string;
  name: string;
  pillar: Pillar | null;
  category: Category;
  linkUrl: string | null;
  previewUrl: string | null;
  /** A draft is seen by the design team only; Marketing is sent published templates. */
  published: boolean;
  format: TemplateFormat | null;
  /** Carousel only. */
  slides: number | null;
  platforms: TemplatePlatform[];
  /** The Canvas design this template is made in, and the number of its latest published revision (null: none yet). */
  designId?: string | null;
  canvasRevision?: number | null;
  createdAt: string;
  /** The name of the designer who made it; null once the account is gone. */
  createdBy: string | null;
  updatedAt?: string;
}

/** Storage URLs are relative when the API stores files on local disk. */
export function fileHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `${API_BASE}${url}`;
}

export function isFigmaLink(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "figma.com" || host.endsWith(".figma.com");
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// What counts as a source: a real Figma design link, or a Canvas design with a published revision. MIRRORS the API's
// hasFigmaSource/hasCanvasSource/hasUsableSource (apps/api/src/lib/templates.ts) with the same test vectors: KEEP IDENTICAL,
// so nothing on the page claims a source the API would refuse. A blank link, or any other URL (https://example.com), is not one.
export const hasFigmaSource = (linkUrl: unknown): boolean => typeof linkUrl === "string" && linkUrl.trim() !== "" && figmaLinkError(linkUrl) === null;

export const hasCanvasSource = (canvasRevision: number | null | undefined): boolean => canvasRevision != null;

export const hasUsableSource = (t: { linkUrl?: string | null; canvasRevision?: number | null }): boolean => hasFigmaSource(t.linkUrl) || hasCanvasSource(t.canvasRevision);

/** A template with no source needs a Figma link or a Canvas revision from the design team. */
export function isIncomplete(t: { linkUrl?: string | null; canvasRevision?: number | null }): boolean {
  return !hasUsableSource(t);
}

/** Category → template. The API lists newest first, so the newest wins if a category has more than one. */
export function templatesByCategory(list: DesignTemplate[]): Map<Category, DesignTemplate> {
  const map = new Map<Category, DesignTemplate>();
  for (const t of list) {
    const category = normalizeCategory(t.category);
    if (category && !map.has(category)) map.set(category, t);
  }
  return map;
}
