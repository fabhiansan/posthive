import { prisma } from "./prisma.js";

/**
 * Drops URLs still used by a template. Posts made from a template share its design
 * files, so post cleanup (delete, edit, after publish) must never remove them.
 */
export async function withoutTemplateMedia(urls: string[]): Promise<string[]> {
  if (!urls.length) return urls;
  const templates = await prisma.template.findMany({
    where: { OR: urls.map((url) => ({ content: { contains: url } })) },
    select: { content: true },
  });
  if (!templates.length) return urls;
  const inUse = new Set<string>();
  for (const t of templates) {
    try {
      for (const url of (JSON.parse(t.content) as { mediaUrls?: string[] }).mediaUrls ?? []) inUse.add(url);
    } catch { /* malformed template content — ignore */ }
  }
  return urls.filter((url) => !inUse.has(url));
}

/**
 * Post content for a post created from a template via API/MCP: template fields plus
 * empty per-slide copy (Marketing fills it in) — design guidance stays on the template.
 */
export function postContentFromTemplate(
  templateId: string,
  tc: Record<string, unknown>,
  text: string,
  commentText: string | null,
): Record<string, unknown> {
  const slides = Array.isArray(tc.slides)
    ? (tc.slides as { label?: string }[]).map((s) => ({ label: s.label ?? "", text: "" }))
    : undefined;
  return { ...tc, text, commentText, templateId, ...(slides ? { slides } : {}) };
}

/** True when a template has per-slide copy that must be typed in before scheduling. */
export function templateNeedsCopy(tc: Record<string, unknown>): boolean {
  return Array.isArray(tc.slides) && tc.slides.length > 0;
}

type SlideCopy = { label: string; text?: string }[];

/** Labels of slides whose copy Marketing still has to fill in before the post leaves draft. */
export function missingSlideCopy(slides: SlideCopy | undefined): string[] {
  return (slides ?? []).filter((s) => !s.text?.trim()).map((s) => s.label);
}

/** 400 message when a stored post still has empty slide copy, else null. */
export function slideCopyError(storedContent: string): string | null {
  let slides: SlideCopy | undefined;
  try { slides = (JSON.parse(storedContent) as { slides?: SlideCopy }).slides; } catch { return null; }
  const empty = missingSlideCopy(slides);
  return empty.length ? `Fill in the copywriting for: ${empty.join(", ")}` : null;
}
