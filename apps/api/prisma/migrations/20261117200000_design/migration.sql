-- Posthive Canvas, phase 3: saved designs. Additive only.
-- "document" is the CanvasDocument JSON and is never null (a new design starts from the blank document);
-- "version" is the optimistic lock (a save succeeds only while it still names the stored version).

-- CreateTable
CREATE TABLE IF NOT EXISTS "Design" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Design_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Design_workspaceId_kind_updatedAt_idx" ON "Design"("workspaceId", "kind", "updatedAt");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Design_workspaceId_fkey') THEN
    ALTER TABLE "Design" ADD CONSTRAINT "Design_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- RLS (same policy as the other app tables: no direct Supabase API access)
ALTER TABLE "Design" ENABLE ROW LEVEL SECURITY;
