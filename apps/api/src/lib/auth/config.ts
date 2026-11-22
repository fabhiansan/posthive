// Configuration the auth provider needs, checked at startup. Nothing here runs when the module is imported: validateAuthConfig is
// called from main() in index.ts, before the server listens. (localAuth.ts keeps its own request-time check as defense in depth.)

/** The same selection lib/auth/index.ts makes: anything but exactly "supabase" is the local provider, an unset or empty value included. */
export function authProviderName(env: NodeJS.ProcessEnv = process.env): "local" | "supabase" {
  return env.AUTH_PROVIDER === "supabase" ? "supabase" : "local";
}

const HOW = `Generate one with: openssl rand -hex 32 (or: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")`;

/**
 * The local provider signs and verifies every session with JWT_ACCESS_SECRET, so it must be present and exactly 32 bytes of hex (64
 * characters, what `openssl rand -hex 32` makes). Throws when it is not; any other provider does not use the variable and is not asked
 * for it. The message says what is wrong and never contains the value, any part of it, or its length.
 */
export function validateAuthConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (authProviderName(env) !== "local") return;
  const secret = env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error(`JWT_ACCESS_SECRET is missing or empty, and the local auth provider needs it. ${HOW}`);
  if (!/^[0-9a-fA-F]{64}$/.test(secret)) {
    throw new Error(`JWT_ACCESS_SECRET must be exactly 64 hexadecimal characters (0-9, a-f: 32 bytes), with no quotes, spaces or line breaks. ${HOW}`);
  }
}
