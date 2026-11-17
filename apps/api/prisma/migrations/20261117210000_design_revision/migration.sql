-- Posthive Canvas, phase 4: published design revisions and the template-to-design link. Additive only; no data is
-- changed (there is no UPDATE here, so existing templates keep exactly the status they have).

-- CreateTable
CREATE TABLE IF NOT EXISTS "DesignRevision" (
    "id" TEXT NOT NULL,
    "designId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "designVersion" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "manifest" JSONB NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignRevision_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "designId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DesignRevision_designId_number_key" ON "DesignRevision"("designId", "number");
CREATE UNIQUE INDEX IF NOT EXISTS "DesignRevision_designId_designVersion_key" ON "DesignRevision"("designId", "designVersion");
CREATE UNIQUE INDEX IF NOT EXISTS "Template_designId_key" ON "Template"("designId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DesignRevision_designId_fkey') THEN
    ALTER TABLE "DesignRevision" ADD CONSTRAINT "DesignRevision_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  -- NO ACTION (not deferrable): a design that a template links cannot be deleted directly. Deleting a workspace, which
  -- cascades to both the template and the design, is expected to still work: PostgreSQL runs the foreign key cascade
  -- queries with fire_triggers = false, so the check that deleting the design queues is fired after both of the
  -- workspace's cascade events, which were queued first, have run (spi.c SPI_execute_snapshot, trigger.c
  -- AfterTriggerEndQuery). Read from the source, not run: the local check script covers it (workspace delete succeeds,
  -- direct delete of a linked design fails). SET NULL would quietly strip a published template of its design.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Template_designId_fkey') THEN
    ALTER TABLE "Template" ADD CONSTRAINT "Template_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
  END IF;
END $$;

-- RLS (same policy as the other app tables: no direct Supabase API access)
ALTER TABLE "DesignRevision" ENABLE ROW LEVEL SECURITY;

-- A published revision never changes. The application has no code that updates or deletes one; these triggers also stop
-- a mistake or a hand-written statement. They do not stop the table's owner, who can drop them.
CREATE OR REPLACE FUNCTION "DesignRevision_refuse_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A published design revision cannot be changed (revision %).', OLD."id"
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DesignRevision_immutable_update" ON "DesignRevision";
CREATE TRIGGER "DesignRevision_immutable_update"
  BEFORE UPDATE ON "DesignRevision"
  FOR EACH ROW EXECUTE FUNCTION "DesignRevision_refuse_update"();

-- A direct DELETE is refused. A delete made by the foreign key's cascade (deleting an unlinked Design, or a Workspace) runs
-- inside the referential-integrity trigger, so pg_trigger_depth() is 2 or more there, and that one is allowed.
CREATE OR REPLACE FUNCTION "DesignRevision_refuse_delete"() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'A published design revision cannot be deleted (revision %).', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DesignRevision_immutable_delete" ON "DesignRevision";
CREATE TRIGGER "DesignRevision_immutable_delete"
  BEFORE DELETE ON "DesignRevision"
  FOR EACH ROW EXECUTE FUNCTION "DesignRevision_refuse_delete"();
