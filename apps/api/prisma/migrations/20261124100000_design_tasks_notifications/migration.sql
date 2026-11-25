-- Posthive designer side: the designer's answer on a design request (a Figma link + a note, then "done"), and the
-- notification drawer every role has. Additive only; every statement is safe to run twice.
-- "status" of a design request is now draft | sent | done (a text column, no change needed).

-- AlterTable
ALTER TABLE "DesignRequest" ADD COLUMN IF NOT EXISTS "figmaUrl" TEXT;
ALTER TABLE "DesignRequest" ADD COLUMN IF NOT EXISTS "designerNote" TEXT;
ALTER TABLE "DesignRequest" ADD COLUMN IF NOT EXISTS "doneAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Notification" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "postJobId" TEXT,
    "actorId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_userId_workspaceId_createdAt_idx" ON "Notification"("userId", "workspaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "Notification_userId_workspaceId_readAt_idx" ON "Notification"("userId", "workspaceId", "readAt");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Notification_workspaceId_fkey') THEN
    ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Notification_userId_fkey') THEN
    ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Notification_postJobId_fkey') THEN
    ALTER TABLE "Notification" ADD CONSTRAINT "Notification_postJobId_fkey" FOREIGN KEY ("postJobId") REFERENCES "PostJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Notification_actorId_fkey') THEN
    ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- RLS (same policy as the other app tables: no direct Supabase API access)
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
