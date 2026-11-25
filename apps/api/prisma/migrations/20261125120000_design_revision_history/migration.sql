ALTER TABLE "DesignRequest" ADD COLUMN "revisionNote" TEXT;
ALTER TABLE "DesignRequest" ADD COLUMN "history" JSONB NOT NULL DEFAULT '[]';

-- Preserve the last delivered version for existing tasks before any revision can reopen them.
UPDATE "DesignRequest"
SET "history" = jsonb_build_array(jsonb_build_object(
  'kind', 'submitted', 'at', "doneAt", 'by', NULL,
  'figmaUrl', "figmaUrl", 'note', "designerNote"
))
WHERE "status" = 'done' AND "doneAt" IS NOT NULL;

-- Record every approval round, including bulk submissions and alternate publishing callers.
CREATE FUNCTION record_design_approval_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_kind TEXT;
        actor_name TEXT;
BEGIN
  IF NEW."approvalStatus" IS NOT DISTINCT FROM OLD."approvalStatus" THEN RETURN NEW; END IF;
  event_kind := CASE NEW."approvalStatus" WHEN 'pending' THEN 'review_submitted' WHEN 'approved' THEN 'approved' WHEN 'rejected' THEN 'returned' ELSE NULL END;
  IF event_kind IS NULL THEN RETURN NEW; END IF;
  SELECT name INTO actor_name FROM "User" WHERE id = CASE WHEN NEW."approvalStatus" = 'pending' THEN NEW."submittedById" ELSE NEW."reviewedByUserId" END;
  UPDATE "DesignRequest" SET "history" = "history" || jsonb_build_array(jsonb_build_object(
    'kind', event_kind, 'at', CURRENT_TIMESTAMP, 'by', actor_name,
    'figmaUrl', NULL, 'note', CASE WHEN NEW."approvalStatus" = 'rejected' THEN NEW."reviewNote" ELSE NULL END
  )) WHERE "postJobId" = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER design_approval_history AFTER UPDATE OF "approvalStatus" ON "PostJob"
FOR EACH ROW EXECUTE FUNCTION record_design_approval_event();
