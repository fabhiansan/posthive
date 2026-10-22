-- Content-plan CSV import idempotency.
-- Nullable so existing manually-created PostJobs are unaffected.

ALTER TABLE "PostJob" ADD COLUMN IF NOT EXISTS "importKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "PostJob_workspaceId_importKey_key"
  ON "PostJob"("workspaceId", "importKey");
