-- Posthive Canvas, phase 6: design review. Additive only; no data is changed (there is no UPDATE or DELETE of existing rows
-- here, and the one new column is NULL on every existing row).
--
-- Marketing submits one of its designs ("Design" with kind = 'instance') for review. A submission is an immutable snapshot
-- ("DesignSubmission") made on the server; the designer's answer ("DesignReviewRequest") leaves 'pending' exactly once.
-- A design that has a submission is never hard-deleted: "Design"."archivedAt" soft-deletes it instead.

-- AlterTable
ALTER TABLE "Design" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DesignSubmission" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "instanceVersion" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "baseRevisionId" TEXT NOT NULL,
    "overrides" JSONB NOT NULL,
    "document" JSONB NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignSubmission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DesignReviewRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "pendingInstanceId" TEXT,
    "comment" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignReviewRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex. (instanceId, number) and (instanceId, instanceVersion) also answer the foreign key's own check on "Design".
-- baseRevisionId answers the one on "DesignRevision". "pendingInstanceId" is unique: at most one pending review per instance.
CREATE UNIQUE INDEX IF NOT EXISTS "DesignSubmission_instanceId_number_key" ON "DesignSubmission"("instanceId", "number");
CREATE UNIQUE INDEX IF NOT EXISTS "DesignSubmission_instanceId_instanceVersion_key" ON "DesignSubmission"("instanceId", "instanceVersion");
CREATE INDEX IF NOT EXISTS "DesignSubmission_baseRevisionId_idx" ON "DesignSubmission"("baseRevisionId");
CREATE INDEX IF NOT EXISTS "DesignSubmission_workspaceId_idx" ON "DesignSubmission"("workspaceId");
CREATE UNIQUE INDEX IF NOT EXISTS "DesignReviewRequest_submissionId_key" ON "DesignReviewRequest"("submissionId");
CREATE UNIQUE INDEX IF NOT EXISTS "DesignReviewRequest_pendingInstanceId_key" ON "DesignReviewRequest"("pendingInstanceId");
CREATE INDEX IF NOT EXISTS "DesignReviewRequest_workspaceId_status_createdAt_id_idx" ON "DesignReviewRequest"("workspaceId", "status", "createdAt", "id");

-- AddForeignKey
DO $$
BEGIN
  -- A workspace owns its snapshots and reviews: deleting it removes them (one statement, so the NO ACTION checks below are
  -- fired after every cascade of that statement, as for the phase 4 and 5 tables).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DesignSubmission_workspaceId_fkey') THEN
    ALTER TABLE "DesignSubmission" ADD CONSTRAINT "DesignSubmission_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  -- NO ACTION (not deferrable), NEVER CASCADE: an instance that has a submission cannot be deleted directly. A cascade
  -- would run at trigger depth 2, which the DELETE trigger below allows, and would silently erase the review history.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DesignSubmission_instanceId_fkey') THEN
    ALTER TABLE "DesignSubmission" ADD CONSTRAINT "DesignSubmission_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Design"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
  END IF;
  -- The same for the revision: a published revision that a submission was made from cannot be deleted (so neither can the
  -- template design that owns it). The instance's own foreign key already says so; this one is the second safeguard.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DesignSubmission_baseRevisionId_fkey') THEN
    ALTER TABLE "DesignSubmission" ADD CONSTRAINT "DesignSubmission_baseRevisionId_fkey" FOREIGN KEY ("baseRevisionId") REFERENCES "DesignRevision"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DesignReviewRequest_workspaceId_fkey') THEN
    ALTER TABLE "DesignReviewRequest" ADD CONSTRAINT "DesignReviewRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DesignReviewRequest_submissionId_fkey') THEN
    ALTER TABLE "DesignReviewRequest" ADD CONSTRAINT "DesignReviewRequest_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DesignSubmission"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
  END IF;
  -- No foreign key on any user id ("submittedByUserId", "decidedByUserId"): SET NULL would update an immutable row and make
  -- deleting an account fail, and CASCADE would erase review history. The name is read from "User" when it is shown.

  -- Only an instance can be archived. NOT VALID: enforced on every insert and update from now on, existing rows are not
  -- scanned (the column is new, so they all satisfy it).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Design_archive_check') THEN
    ALTER TABLE "Design" ADD CONSTRAINT "Design_archive_check" CHECK ("archivedAt" IS NULL OR "kind" = 'instance') NOT VALID;
  END IF;

  -- The four states, and what each one carries. The tables are new, so these are validated at once.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DesignReviewRequest_status_check') THEN
    ALTER TABLE "DesignReviewRequest" ADD CONSTRAINT "DesignReviewRequest_status_check" CHECK ("status" IN ('pending', 'approved', 'changes_requested', 'superseded'));
  END IF;
  -- Pending exactly when the instance is named in "pendingInstanceId" (that column is what makes it unique).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DesignReviewRequest_pending_check') THEN
    ALTER TABLE "DesignReviewRequest" ADD CONSTRAINT "DesignReviewRequest_pending_check" CHECK (("status" = 'pending') = ("pendingInstanceId" IS NOT NULL));
  END IF;
  -- A decision names who and when; a request that is still pending or was replaced has neither, and no comment.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DesignReviewRequest_decided_check') THEN
    ALTER TABLE "DesignReviewRequest" ADD CONSTRAINT "DesignReviewRequest_decided_check" CHECK (
      ("status" IN ('approved', 'changes_requested') AND "decidedAt" IS NOT NULL AND "decidedByUserId" IS NOT NULL)
      OR ("status" IN ('pending', 'superseded') AND "decidedAt" IS NULL AND "decidedByUserId" IS NULL AND "comment" IS NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DesignReviewRequest_comment_check') THEN
    ALTER TABLE "DesignReviewRequest" ADD CONSTRAINT "DesignReviewRequest_comment_check" CHECK ("status" <> 'changes_requested' OR ("comment" IS NOT NULL AND btrim("comment") <> ''));
  END IF;
END $$;

-- RLS (same policy as the other app tables: no direct Supabase API access)
ALTER TABLE "DesignSubmission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DesignReviewRequest" ENABLE ROW LEVEL SECURITY;

-- A submission never changes. The application has no code that updates or deletes one; these triggers also stop a mistake or
-- a hand-written statement. They do not stop the table's owner, who can drop them, and they do not cover TRUNCATE.
CREATE OR REPLACE FUNCTION "DesignSubmission_refuse_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A design submission cannot be changed (submission %).', OLD."id"
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DesignSubmission_immutable_update" ON "DesignSubmission";
CREATE TRIGGER "DesignSubmission_immutable_update"
  BEFORE UPDATE ON "DesignSubmission"
  FOR EACH ROW EXECUTE FUNCTION "DesignSubmission_refuse_update"();

-- A direct DELETE is refused. A delete made by the foreign key's cascade (deleting a Workspace) runs inside the
-- referential-integrity trigger, so pg_trigger_depth() is 2 or more there, and that one is allowed.
CREATE OR REPLACE FUNCTION "DesignSubmission_refuse_delete"() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'A design submission cannot be deleted (submission %).', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DesignSubmission_immutable_delete" ON "DesignSubmission";
CREATE TRIGGER "DesignSubmission_immutable_delete"
  BEFORE DELETE ON "DesignSubmission"
  FOR EACH ROW EXECUTE FUNCTION "DesignSubmission_refuse_delete"();

-- A review request leaves 'pending' exactly once (decided, or superseded by a newer submission) and then never changes. While
-- it is pending, only its status, decision fields and "pendingInstanceId" may change, and the new status cannot be 'pending'.
CREATE OR REPLACE FUNCTION "DesignReviewRequest_guard_update"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'pending' THEN
    RAISE EXCEPTION 'A design review that is no longer pending cannot be changed (review %).', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = 'pending'
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
     OR NEW."submissionId" IS DISTINCT FROM OLD."submissionId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'A pending design review can only be decided or superseded (review %).', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DesignReviewRequest_guard_update" ON "DesignReviewRequest";
CREATE TRIGGER "DesignReviewRequest_guard_update"
  BEFORE UPDATE ON "DesignReviewRequest"
  FOR EACH ROW EXECUTE FUNCTION "DesignReviewRequest_guard_update"();

CREATE OR REPLACE FUNCTION "DesignReviewRequest_refuse_delete"() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'A design review cannot be deleted (review %).', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DesignReviewRequest_immutable_delete" ON "DesignReviewRequest";
CREATE TRIGGER "DesignReviewRequest_immutable_delete"
  BEFORE DELETE ON "DesignReviewRequest"
  FOR EACH ROW EXECUTE FUNCTION "DesignReviewRequest_refuse_delete"();

-- An archived design is frozen: no later UPDATE of any kind (so no edit, no restore, no second archive). Archiving itself is
-- allowed because the row's old "archivedAt" is NULL then. The WHEN clause means an ordinary save never runs the function.
-- A restore, if it is ever wanted, needs a migration that drops this trigger. It does not stop the table's owner.
CREATE OR REPLACE FUNCTION "Design_refuse_archived_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'An archived design cannot be changed (design %).', OLD."id"
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Design_archived_frozen" ON "Design";
CREATE TRIGGER "Design_archived_frozen"
  BEFORE UPDATE ON "Design"
  FOR EACH ROW
  WHEN (OLD."archivedAt" IS NOT NULL)
  EXECUTE FUNCTION "Design_refuse_archived_update"();
