-- Posthive Canvas, phase 2: images a design uses (PNG, or an SVG rasterized to PNG).
-- Additive only. "storageRef" is the private storage path and is never sent to the client.

-- CreateTable
CREATE TABLE IF NOT EXISTS "DesignAsset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "storageRef" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sourceFormat" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DesignAsset_storageRef_key" ON "DesignAsset"("storageRef");
CREATE INDEX IF NOT EXISTS "DesignAsset_workspaceId_idx" ON "DesignAsset"("workspaceId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DesignAsset_workspaceId_fkey') THEN
    ALTER TABLE "DesignAsset" ADD CONSTRAINT "DesignAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- RLS (same policy as the other app tables: no direct Supabase API access)
ALTER TABLE "DesignAsset" ENABLE ROW LEVEL SECURITY;
