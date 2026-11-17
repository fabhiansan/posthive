-- Template Library for the design team: a template is a Draft or Published, and says its format and platforms.
-- Additive only. Only Published templates reach Marketing (GET /templates, the public API and MCP).
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "published" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "format" TEXT;
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "slides" INTEGER;
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "platforms" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Marketing sees every template today, so every template that exists stays visible: new ones start as drafts.
UPDATE "Template" SET "published" = true;
