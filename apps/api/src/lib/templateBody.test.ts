import { describe, expect, it } from "vitest";
import { templateBody } from "./templateBody.js";

const base = {
  pillar: "Promotional",
  category: "Case Study",
  linkUrl: "https://www.figma.com/design/AbC123/Slope-stability",
};

const issue = (input: unknown) => {
  const r = templateBody.safeParse(input);
  return r.success ? null : r.error.issues[0]?.message;
};

describe("templateBody", () => {
  it("accepts a Figma link without a preview", () => {
    const r = templateBody.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.previewUrl).toBeNull();
  });

  it("accepts a Figma link with an image preview", () => {
    expect(templateBody.safeParse({ ...base, previewUrl: "/uploads/a.png" }).success).toBe(true);
  });

  it("rejects a link that is not from figma.com", () => {
    expect(issue({ ...base, linkUrl: "https://example.com/design/abc" })).toMatch(/Figma link/);
  });

  // A template made in Canvas has no Figma link (it is published through its Canvas revision), so a missing, null, blank
  // or whitespace-only link is no link. A link that is given must still be a Figma design link.
  it.each([["missing", undefined], ["null", null], ["empty", ""], ["spaces", "   "]])("a %s link is no link", (_label, linkUrl) => {
    const r = templateBody.safeParse({ ...base, linkUrl });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.linkUrl).toBeNull();
  });

  it.each(["https://example.com", "https://example.com/design/abc", "http://www.figma.com/design/AbC", "https://figma.com.evil.com/design/AbC", "https://www.figma.com/community/file/1", "figma"])("still rejects %s", (linkUrl) => {
    expect(issue({ ...base, linkUrl })).toMatch(/Figma link/);
  });

  it("trims a link that is given", () => {
    const r = templateBody.safeParse({ ...base, linkUrl: `  ${base.linkUrl}  ` });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.linkUrl).toBe(base.linkUrl);
  });

  it("rejects a preview that is not an image", () => {
    expect(issue({ ...base, previewUrl: "/uploads/a.pdf" })).toBe("The preview must be an image");
  });

  it("rejects a pillar that does not match the category", () => {
    expect(issue({ ...base, pillar: "Educational" })).toMatch(/belongs to/);
  });

  it("format, slides and platforms are optional", () => {
    const r = templateBody.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ format: null, slides: null, platforms: [] });
  });

  it("a carousel keeps its slides; any other format drops them", () => {
    expect(templateBody.parse({ ...base, format: "carousel", slides: 5 })).toMatchObject({ format: "carousel", slides: 5 });
    expect(templateBody.parse({ ...base, format: "single", slides: 5 })).toMatchObject({ format: "single", slides: null });
    expect(templateBody.parse({ ...base, slides: 5 })).toMatchObject({ format: null, slides: null });
  });

  it("slides are 2 to 20", () => {
    expect(issue({ ...base, format: "carousel", slides: 1 })).toMatch(/2 to 20/);
    expect(issue({ ...base, format: "carousel", slides: 21 })).toMatch(/2 to 20/);
    expect(issue({ ...base, format: "carousel", slides: 2.5 })).toBeTruthy();
  });

  it("a format the app does not know is refused", () => {
    expect(issue({ ...base, format: "hologram" })).toBeTruthy();
  });

  it("platforms are Instagram and LinkedIn, each once", () => {
    expect(templateBody.parse({ ...base, platforms: ["instagram", "linkedin", "instagram"] }).platforms).toEqual(["instagram", "linkedin"]);
    expect(issue({ ...base, platforms: ["tiktok"] })).toBeTruthy();
  });

  it("`published` is not part of the body: a template cannot publish itself", () => {
    expect(templateBody.parse({ ...base, published: true })).not.toHaveProperty("published");
  });

  describe("slide images and the caption guideline", () => {
    const carousel = { ...base, format: "carousel" };
    const slides = (n: number, extra: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => ({ url: `/uploads/s${i + 1}.png`, ...extra }));

    it("a carousel keeps its slide images in order, and their number is the slide count (the typed number is ignored)", () => {
      const r = templateBody.parse({ ...carousel, slides: 9, slideImages: [{ url: "/uploads/b.png", label: "Cover" }, { url: "/uploads/a.jpg" }, { url: "/uploads/c.webp", label: "  " }] });
      expect(r.slideImages).toEqual([{ url: "/uploads/b.png", label: "Cover" }, { url: "/uploads/a.jpg", label: null }, { url: "/uploads/c.webp", label: null }]);
      expect(r.slides).toBe(3);
    });

    it("with no images the typed slide count stays", () => {
      expect(templateBody.parse({ ...carousel, slides: 5 })).toMatchObject({ slides: 5, slideImages: [] });
    });

    it("any other format drops the images, and a missing list is an empty one", () => {
      expect(templateBody.parse({ ...base, format: "single", slideImages: slides(3) }).slideImages).toEqual([]);
      expect(templateBody.parse({ ...base, slideImages: slides(3) }).slideImages).toEqual([]);
      expect(templateBody.parse(carousel).slideImages).toEqual([]);
    });

    it("2 to 20 images: one is refused, 20 pass, 21 are refused", () => {
      expect(issue({ ...carousel, slideImages: slides(1) })).toMatch(/2 to 20/);
      expect(templateBody.safeParse({ ...carousel, slideImages: slides(2) }).success).toBe(true);
      expect(templateBody.safeParse({ ...carousel, slideImages: slides(20) }).success).toBe(true);
      expect(issue({ ...carousel, slideImages: slides(21) })).toMatch(/2 to 20/);
    });

    it("every slide is an image, used once, with a name of at most 40 characters", () => {
      expect(issue({ ...carousel, slideImages: [{ url: "/uploads/a.png" }, { url: "/uploads/b.pdf" }] })).toBe("Every slide must be an image");
      expect(issue({ ...carousel, slideImages: [{ url: "/uploads/a.png" }, { url: "/uploads/a.png" }] })).toBe("A slide image can be used once");
      expect(issue({ ...carousel, slideImages: [{ url: "/uploads/a.png", label: "x".repeat(41) }, { url: "/uploads/b.png" }] })).toMatch(/40 characters/);
      expect(templateBody.safeParse({ ...carousel, slideImages: [{ url: "/uploads/a.png", label: "x".repeat(40) }, { url: "/uploads/b.png" }] }).success).toBe(true);
    });

    it("the caption guideline is trimmed, a blank one is none, and it is at most 2000 characters", () => {
      expect(templateBody.parse({ ...base, captionGuideline: "  Open with the problem.  " }).captionGuideline).toBe("Open with the problem.");
      for (const v of [undefined, null, "", "   "]) expect(templateBody.parse({ ...base, captionGuideline: v }).captionGuideline).toBeNull();
      expect(templateBody.safeParse({ ...base, captionGuideline: "x".repeat(2000) }).success).toBe(true);
      expect(issue({ ...base, captionGuideline: "x".repeat(2001) })).toMatch(/2000/);
    });
  });

  it("ignores file fields: .fig can no longer be set", () => {
    const r = templateBody.safeParse({ ...base, fileUrl: "/uploads/x.fig", fileName: "x.fig", fileSize: 10 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).not.toHaveProperty("fileUrl");
  });
});
