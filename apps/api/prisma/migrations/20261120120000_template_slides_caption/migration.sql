-- Template Library: a carousel template keeps one image per slide (with an optional short name), and a template can
-- carry a caption guideline for Marketing. Additive only; every existing row gets an empty list and no guideline.
-- The slide images are two lists of the same length (a URL has an Upload row, so it can be claimed and protected like the
-- preview): "slideLabels"[n] is the name of "slideUrls"[n], an empty string when it has none.
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "captionGuideline" TEXT;
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "slideUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "slideLabels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
