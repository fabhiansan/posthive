-- Who sent a post for design review, when, and how many times (the designer dashboard). Additive only.
ALTER TABLE "PostJob" ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3);
ALTER TABLE "PostJob" ADD COLUMN IF NOT EXISTS "submittedById" TEXT;
ALTER TABLE "PostJob" ADD COLUMN IF NOT EXISTS "submitCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PostJob" ADD CONSTRAINT "PostJob_submittedById_fkey"
  FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "PostJob_workspaceId_submittedAt_idx" ON "PostJob"("workspaceId", "submittedAt");

-- Posts already waiting for review: sent by their author at their last change, the best the rows know.
UPDATE "PostJob"
SET "submittedAt" = "updatedAt", "submittedById" = "userId", "submitCount" = 1
WHERE "approvalStatus" = 'pending' AND "submittedAt" IS NULL;
