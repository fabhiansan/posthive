import { z } from "zod";
import { CATEGORIES, PILLARS, pillarFor } from "./contentTypes.js";
import { figmaLinkError } from "./figmaLink.js";

const urlPath = (url: string) => { try { return new URL(url, "http://x").pathname; } catch { return ""; } };

export const TEMPLATE_FORMATS = ["carousel", "single", "reel_cover", "story", "video"] as const;
export const TEMPLATE_PLATFORMS = ["instagram", "linkedin"] as const;

export const MAX_SLIDES = 20;
const SLIDES_RANGE = `A carousel has 2 to ${MAX_SLIDES} slides.`;
const IMAGE_URL = /\.(jpe?g|png|gif|webp)$/i;

// One slide of a carousel: its image (an upload) and a short name for it ("Cover", "Problem"), or none.
const slideImage = z.object({
  url: z.string().trim().min(1).max(2048),
  label: z.string().trim().max(40, "A slide name is at most 40 characters.").nullish().transform((v) => v || null),
});

// Design template (docs/content-types.md): the reference design for one content type
// (Pillar + Category) — a Figma link (optional: a template made in Canvas has none) plus an optional preview image.
// One per workspace and category. Posts only take the pillar/category, never the link.
// The old .fig upload fields are not part of the body; unknown keys are ignored. Neither is `published`: a template
// starts as a draft and the design team publishes it with PATCH /templates/:id/status, which needs a Figma link or a
// published Canvas revision (routes/templates.ts). A blank link is no link; a link that is given must be a Figma design link.
export const templateBody = z.object({
  pillar: z.enum(PILLARS).nullable(),
  category: z.enum(CATEGORIES),
  linkUrl: z.string().trim().max(2048).nullish().transform((v) => v || null),
  previewUrl: z.string().trim().min(1).max(2048).nullable().default(null),
  format: z.enum(TEMPLATE_FORMATS).nullable().default(null),
  slides: z.number().int().min(2, "A carousel has 2 to 20 slides.").max(20, "A carousel has 2 to 20 slides.").nullable().default(null),
  platforms: z.array(z.enum(TEMPLATE_PLATFORMS)).default([]),
  // Left out = "keep what the template has" (an editor from before slide images sends neither field); sent empty = clear.
  slideImages: z.array(slideImage).optional(),
  captionGuideline: z.string().trim().max(2000, "The caption guideline is at most 2000 characters.").nullish().transform((v) => (v === undefined ? undefined : v || null)),
}).superRefine((t, ctx) => {
  if (t.pillar !== pillarFor(t.category)) {
    const expected = pillarFor(t.category) ?? "no pillar";
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pillar"], message: `${t.category} belongs to ${expected}` });
  }
  const linkError = t.linkUrl === null ? null : figmaLinkError(t.linkUrl);
  if (linkError) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["linkUrl"], message: linkError });
  if (t.previewUrl && !IMAGE_URL.test(urlPath(t.previewUrl))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["previewUrl"], message: "The preview must be an image" });
  }
  // Slide images only make sense for a carousel and are checked only then (any other format drops them below)
  const images = t.slideImages ?? [];
  if (t.format === "carousel" && images.length > 0) {
    if (images.length < 2 || images.length > MAX_SLIDES) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["slideImages"], message: SLIDES_RANGE });
    if (images.some((s) => !IMAGE_URL.test(urlPath(s.url)))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["slideImages"], message: "Every slide must be an image" });
    if (new Set(images.map((s) => s.url)).size !== images.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["slideImages"], message: "A slide image can be used once" });
  }
}).transform((t) => {
  // only a carousel has slides, and with images the count is the number of images; a platform listed twice is one platform.
  // slideImages stays undefined only for a carousel that did not send the list: the route fills it from the template.
  const slideImages = t.format === "carousel" ? t.slideImages : [];
  return {
    ...t,
    slideImages,
    slides: t.format !== "carousel" ? null : slideImages?.length ? slideImages.length : t.slides,
    platforms: [...new Set(t.platforms)],
  };
});

export type TemplateBody = z.infer<typeof templateBody>;
