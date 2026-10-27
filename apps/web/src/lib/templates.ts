import { CATEGORY_INFO, type Category } from "./contentTypes";

// Template kit as returned by GET /templates (content is a JSON string).
export interface RawTemplate {
  id: string;
  name: string;
  content: string;
  updatedAt?: string;
}

export interface TemplateSlide {
  label: string;
  guide: string;
}

export interface TemplateKit {
  id: string;
  name: string;
  updatedAt?: string;
  text: string;
  commentText?: string;
  mediaUrls: string[];
  /** Missing on caption-only templates saved before the template kit. */
  category?: Category;
  pillar: string | null;
  format: "carousel" | "poster";
  slides: TemplateSlide[];
}

export function parseTemplate(raw: RawTemplate): TemplateKit {
  const c = (() => { try { return JSON.parse(raw.content) as Record<string, unknown>; } catch { return {}; } })();
  const category = typeof c.category === "string" && c.category in CATEGORY_INFO ? (c.category as Category) : undefined;
  const mediaUrls = Array.isArray(c.mediaUrls) ? (c.mediaUrls as string[]) : [];
  return {
    id: raw.id,
    name: raw.name,
    updatedAt: raw.updatedAt,
    text: typeof c.text === "string" ? c.text : "",
    commentText: typeof c.commentText === "string" ? c.commentText : undefined,
    mediaUrls,
    category,
    pillar: category ? CATEGORY_INFO[category].pillar : null,
    format: c.format === "poster" ? "poster" : "carousel",
    slides: Array.isArray(c.slides) ? (c.slides as TemplateSlide[]) : [],
  };
}

/** "Carousel, 5 slides" / "Poster" / "Caption only". */
export function formatSummary(t: TemplateKit): string {
  if (t.mediaUrls.length === 0) return "Caption only";
  if (t.format === "poster") return "Poster";
  return `Carousel, ${t.mediaUrls.length} slide${t.mediaUrls.length === 1 ? "" : "s"}`;
}
