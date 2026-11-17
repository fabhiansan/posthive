import { z } from "zod";
import { CATEGORIES, PILLARS, pillarFor } from "./contentTypes.js";
import { figmaLinkError } from "./figmaLink.js";

const urlPath = (url: string) => { try { return new URL(url, "http://x").pathname; } catch { return ""; } };

export const TEMPLATE_FORMATS = ["carousel", "single", "reel_cover", "story", "video"] as const;
export const TEMPLATE_PLATFORMS = ["instagram", "linkedin"] as const;

// Design template (docs/content-types.md): the reference design for one content type
// (Pillar + Category) — a Figma link plus an optional preview image.
// One per workspace and category. Posts only take the pillar/category, never the link.
// The old .fig upload fields are not part of the body; unknown keys are ignored. Neither is `published`: a template
// starts as a draft and the design team publishes it with PATCH /templates/:id/status.
export const templateBody = z.object({
  pillar: z.enum(PILLARS).nullable(),
  category: z.enum(CATEGORIES),
  linkUrl: z.string({ required_error: "Add a Figma link." }).trim().max(2048),
  previewUrl: z.string().trim().min(1).max(2048).nullable().default(null),
  format: z.enum(TEMPLATE_FORMATS).nullable().default(null),
  slides: z.number().int().min(2, "A carousel has 2 to 20 slides.").max(20, "A carousel has 2 to 20 slides.").nullable().default(null),
  platforms: z.array(z.enum(TEMPLATE_PLATFORMS)).default([]),
}).superRefine((t, ctx) => {
  if (t.pillar !== pillarFor(t.category)) {
    const expected = pillarFor(t.category) ?? "no pillar";
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pillar"], message: `${t.category} belongs to ${expected}` });
  }
  const linkError = figmaLinkError(t.linkUrl);
  if (linkError) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["linkUrl"], message: linkError });
  if (t.previewUrl && !/\.(jpe?g|png|gif|webp)$/i.test(urlPath(t.previewUrl))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["previewUrl"], message: "The preview must be an image" });
  }
}).transform((t) => ({
  ...t,
  // only a carousel has slides; a platform listed twice is one platform
  slides: t.format === "carousel" ? t.slides : null,
  platforms: [...new Set(t.platforms)],
}));

export type TemplateBody = z.infer<typeof templateBody>;
