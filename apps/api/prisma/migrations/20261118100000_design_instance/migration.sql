-- Posthive Canvas, phase 5: Marketing's design instances. Additive only; no data is changed (there is no UPDATE here, and
-- every existing row is a "template" design that already has its document and none of the new columns).
--
-- An instance is a "Design" row with kind = 'instance'. It has no document of its own: it pins one exact, immutable
-- "DesignRevision" ("baseRevisionId") and stores only "overrides", the text and images that revision's manifest lets
-- Marketing change. The effective document is composed in memory when it is drawn and is never stored.

-- AlterTable. Dropping NOT NULL only changes the catalog: it rewrites nothing and cannot fail on existing rows.
-- Design_shape_check (below) is what keeps a template's document from ever being null.
ALTER TABLE "Design" ALTER COLUMN "document" DROP NOT NULL;
ALTER TABLE "Design" ADD COLUMN IF NOT EXISTS "overrides" JSONB;
ALTER TABLE "Design" ADD COLUMN IF NOT EXISTS "baseRevisionId" TEXT;

-- CreateIndex. The first is the "my designs" list: workspace, kind, owner, then createdAt and id (never updatedAt, which
-- every autosave changes) in the order of its keyset pagination, so a page is one backward index scan with no sort.
-- The second answers "is any instance pinned to this revision" and the foreign key's own check.
CREATE INDEX IF NOT EXISTS "Design_workspaceId_kind_createdByUserId_createdAt_id_idx" ON "Design"("workspaceId", "kind", "createdByUserId", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "Design_baseRevisionId_idx" ON "Design"("baseRevisionId");

-- AddForeignKey
DO $$
BEGIN
  -- NO ACTION (not deferrable), like Template.designId: a design that has instances cannot be deleted, because deleting it
  -- cascades to its revisions and the instances still point at them. Deleting a workspace, which cascades to every one of
  -- its designs (both kinds) in one statement, is expected to still work for the same reason as in phase 4: the check
  -- that deleting a revision queues is fired after that statement's cascade into "Design" has removed the instances.
  -- Read from the PostgreSQL source, not run: the local check script covers it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Design_baseRevisionId_fkey') THEN
    ALTER TABLE "Design" ADD CONSTRAINT "Design_baseRevisionId_fkey" FOREIGN KEY ("baseRevisionId") REFERENCES "DesignRevision"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
  END IF;

  -- Each kind has exactly one shape. NOT VALID: it is enforced on every insert and update from now on, but existing rows
  -- are not scanned, so this migration can never fail on old data (they all satisfy it anyway).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Design_shape_check') THEN
    ALTER TABLE "Design" ADD CONSTRAINT "Design_shape_check" CHECK (
      ("kind" = 'template' AND "document" IS NOT NULL AND "baseRevisionId" IS NULL AND "overrides" IS NULL)
      OR ("kind" = 'instance' AND "document" IS NULL AND "baseRevisionId" IS NOT NULL AND "overrides" IS NOT NULL)
    ) NOT VALID;
  END IF;
END $$;

-- The revision an instance is made from, and its kind, never change. The application never writes either after the insert;
-- this also stops a mistake or a hand-written statement from moving an instance onto another revision. The WHEN clause
-- means an ordinary save (autosave) never runs the function. It does not stop the table's owner, who can drop it.
CREATE OR REPLACE FUNCTION "Design_refuse_repin"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A design''s kind and base revision cannot be changed (design %).', OLD."id"
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Design_pin_base" ON "Design";
CREATE TRIGGER "Design_pin_base"
  BEFORE UPDATE ON "Design"
  FOR EACH ROW
  WHEN (OLD."baseRevisionId" IS DISTINCT FROM NEW."baseRevisionId" OR OLD."kind" IS DISTINCT FROM NEW."kind")
  EXECUTE FUNCTION "Design_refuse_repin"();
