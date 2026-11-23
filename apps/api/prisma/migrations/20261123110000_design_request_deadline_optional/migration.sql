-- Posthive Path B: the design deadline is optional and carries a time of day (before the post's publishing time).
-- Additive in effect: a stored day becomes that day at 00:00 UTC, and nothing else about the row changes. Safe to run twice.

ALTER TABLE "DesignRequest" ALTER COLUMN "deadline" DROP NOT NULL;
ALTER TABLE "DesignRequest" ALTER COLUMN "deadline" TYPE TIMESTAMP(3) USING "deadline"::timestamp(3);
