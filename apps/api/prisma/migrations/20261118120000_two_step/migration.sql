-- Two-step verification with an authenticator app (TOTP). Additive only.

-- The secret is encrypted (lib/encryption.ts), never stored as typed. It is set when setup starts and counts only once
-- totpEnabledAt is set (the person proved they can read a code). totpLastStep is the newest 30-second step already
-- accepted, so the same code cannot be used twice.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpSecret" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpEnabledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpLastStep" INTEGER;

-- One-time codes for a person who has lost their phone. Only a hash is kept; a code is shown once, when it is made.
CREATE TABLE IF NOT EXISTS "RecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RecoveryCode_userId_idx" ON "RecoveryCode"("userId");

ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The step between a right password and a session: a login that needs a code waits here for 5 minutes. The token is random
-- and only its hash is kept; `attempts` counts wrong codes, and the challenge is gone after 5 (lib/auth/twoStepLogin.ts).
CREATE TABLE IF NOT EXISTS "TotpChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "remember" BOOLEAN NOT NULL DEFAULT true,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TotpChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TotpChallenge_tokenHash_key" ON "TotpChallenge"("tokenHash");
CREATE INDEX IF NOT EXISTS "TotpChallenge_userId_idx" ON "TotpChallenge"("userId");
CREATE INDEX IF NOT EXISTS "TotpChallenge_expiresAt_idx" ON "TotpChallenge"("expiresAt");

ALTER TABLE "TotpChallenge" ADD CONSTRAINT "TotpChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
