-- Design templates: a template is now the reference design for one content type
-- (Pillar + Category), not a post template kit. This migration is additive only:
-- legacy rows keep their JSON "content". Duplicates and caption-only rows are removed
-- by a later migration, after scripts/template-migration-report.ts has been reviewed.

-- AlterTable
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "pillar" TEXT;
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "fileUrl" TEXT;
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "fileName" TEXT;
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "fileSize" INTEGER;
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "linkUrl" TEXT;
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "previewUrl" TEXT;
ALTER TABLE "Template" ALTER COLUMN "content" SET DEFAULT '{}';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Template_fileUrl_idx" ON "Template"("fileUrl");
CREATE INDEX IF NOT EXISTS "Template_previewUrl_idx" ON "Template"("previewUrl");

-- CreateTable
CREATE TABLE IF NOT EXISTS "LegacyTemplateMedia" (
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyTemplateMedia_pkey" PRIMARY KEY ("url")
);

-- RLS (same policy as the other app tables: no direct Supabase API access)
ALTER TABLE "LegacyTemplateMedia" ENABLE ROW LEVEL SECURITY;

-- Backfill from the legacy JSON. Malformed JSON parses to NULL instead of aborting.
CREATE OR REPLACE FUNCTION posthive_try_jsonb(t TEXT) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN t::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- Category and pillar (docs/content-types.md). Unknown categories stay NULL.
WITH mapping ("category", "pillar") AS (
  VALUES
    ('Product Features',             'Promotional'),
    ('Case Study',                   'Promotional'),
    ('Success Story',                'Promotional'),
    ('Client Testimonial',           'Promotional'),
    ('Event Partnership',            'Promotional'),
    ('External Event',               'Promotional'),
    ('Geospatial Insight/Expertise', 'Educational'),
    ('Blog Post',                    'Educational'),
    ('Tips/How To',                  'Educational'),
    ('Highlight CSR',                'Entertainment'),
    ('Behind the Scene',             'Entertainment'),
    ('Polling & Survey',             'Conversational'),
    ('Trend Response',               'Conversational'),
    ('Internal Event',               'Conversational'),
    ('Commemorative Content',        'Conversational'),
    ('Ask Me Anything',              NULL::TEXT)
)
UPDATE "Template" t
SET "category" = m."category", "pillar" = m."pillar"
FROM mapping m
WHERE t."category" IS NULL
  AND m."category" = posthive_try_jsonb(t."content") ->> 'category';

-- Preview: the first image of the legacy kit (videos are skipped).
UPDATE "Template" t
SET "previewUrl" = (
  SELECT e.u
  FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(posthive_try_jsonb(t."content") -> 'mediaUrls') = 'array'
         THEN posthive_try_jsonb(t."content") -> 'mediaUrls'
         ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS e(u, i)
  WHERE e.u ~* '\.(jpe?g|png|gif|webp)(\?.*)?$'
  ORDER BY e.i
  LIMIT 1
)
WHERE t."previewUrl" IS NULL AND t."fileUrl" IS NULL AND t."linkUrl" IS NULL;

-- Every legacy kit file (caption-only rows included) stays protected from post cleanup.
INSERT INTO "LegacyTemplateMedia" ("url")
SELECT DISTINCT e.u
FROM "Template" t
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(posthive_try_jsonb(t."content") -> 'mediaUrls') = 'array'
       THEN posthive_try_jsonb(t."content") -> 'mediaUrls'
       ELSE '[]'::jsonb END
) AS e(u)
WHERE e.u <> ''
ON CONFLICT ("url") DO NOTHING;

DROP FUNCTION posthive_try_jsonb(TEXT);
