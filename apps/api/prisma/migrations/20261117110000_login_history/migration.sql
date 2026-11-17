-- What the profile page shows under "Devices & login history". Additive only.
-- The browser a session was opened from, so the list can say "Chrome on macOS".
ALTER TABLE "AuthSession" ADD COLUMN IF NOT EXISTS "userAgent" TEXT;

-- One row per sign-in and per wrong password on a real account, kept 30 days (lib/cleanupCron.ts).
-- No IP address is stored.
CREATE TABLE IF NOT EXISTS "LoginEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "success" BOOLEAN NOT NULL,
    "failure" TEXT,

    CONSTRAINT "LoginEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LoginEvent_userId_at_idx" ON "LoginEvent"("userId", "at");

ALTER TABLE "LoginEvent" ADD CONSTRAINT "LoginEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
