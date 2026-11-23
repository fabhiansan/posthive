-- Posthive Edit Content, Path B: a request from Marketing to a designer for the design of one post. Additive only.
-- One row per post ("postJobId" is unique). "status" is draft (a saved brief) or sent (locked until Marketing cancels).
-- "assigneeId" and "createdById" are SET NULL so deleting a user keeps the brief.

-- CreateTable
CREATE TABLE IF NOT EXISTS "DesignRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "postJobId" TEXT NOT NULL,
    "assigneeId" TEXT,
    "deadline" DATE NOT NULL,
    "brief" TEXT NOT NULL,
    "referenceUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "sentAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DesignRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DesignRequest_postJobId_key" ON "DesignRequest"("postJobId");
CREATE INDEX IF NOT EXISTS "DesignRequest_workspaceId_assigneeId_status_idx" ON "DesignRequest"("workspaceId", "assigneeId", "status");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DesignRequest_workspaceId_fkey') THEN
    ALTER TABLE "DesignRequest" ADD CONSTRAINT "DesignRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DesignRequest_postJobId_fkey') THEN
    ALTER TABLE "DesignRequest" ADD CONSTRAINT "DesignRequest_postJobId_fkey" FOREIGN KEY ("postJobId") REFERENCES "PostJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DesignRequest_assigneeId_fkey') THEN
    ALTER TABLE "DesignRequest" ADD CONSTRAINT "DesignRequest_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DesignRequest_createdById_fkey') THEN
    ALTER TABLE "DesignRequest" ADD CONSTRAINT "DesignRequest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- RLS (same policy as the other app tables: no direct Supabase API access)
ALTER TABLE "DesignRequest" ENABLE ROW LEVEL SECURITY;
