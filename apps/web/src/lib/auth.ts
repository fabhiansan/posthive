const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  hasPassword: boolean;
  avatarUrl: string | null;
  timezone: string;
  emailVerified: boolean;
  role: "owner" | "admin" | "designer" | "member";
}

export async function getSession(): Promise<AuthUser | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/session`, { credentials: "include" });
    if (!res.ok) return null;
    const { user } = await res.json() as { user: AuthUser };
    return user;
  } catch {
    return null;
  }
}

/** Message to show for a failed auth request. Never returns an object: it is rendered as-is. */
export function authErrorMessage(status: number, error: unknown, fallback: string): string {
  if (status === 429) return "Too many attempts. Try again in a few minutes.";
  return typeof error === "string" && error ? error : fallback;
}

/** What a sign-in answers: a person who is in, or (right password, two-step on) a challenge that waits for a code. */
export type LoginResult = { user: AuthUser } | { challenge: string };

async function postAuthRaw(path: string, body: unknown, fallback: string): Promise<{ user?: AuthUser; challenge?: string; twoStepRequired?: boolean }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  // A rate-limit or proxy error may not be JSON.
  const data = await res.json().catch(() => ({})) as { user?: AuthUser; challenge?: string; twoStepRequired?: boolean; error?: unknown };
  if (!res.ok) throw new Error(authErrorMessage(res.status, data.error, fallback));
  return data;
}

async function postAuth(path: string, body: unknown, fallback: string): Promise<AuthUser> {
  return (await postAuthRaw(path, body, fallback)).user!;
}

/** `remember: false` = "Keep me logged in" unchecked: cookies end when the browser closes. */
export async function login(email: string, password: string, remember = true): Promise<LoginResult> {
  try {
    const data = await postAuthRaw("/auth/login", { email, password, remember }, "Login failed");
    if (data.twoStepRequired && data.challenge) return { challenge: data.challenge };
    return { user: data.user! };
  } catch (err) {
    // The API says "Invalid email or password"; the design wants this wording.
    if (err instanceof Error && err.message === "Invalid email or password") {
      throw new Error("Email or password is incorrect.");
    }
    throw err;
  }
}

/** The second step of a sign-in: the code from the authenticator app, or a recovery code. */
export async function loginWithCode(challenge: string, code: string): Promise<AuthUser> {
  return postAuth("/auth/login/two-step", { challenge, code }, "That code didn't work. Try again.");
}

/** The API's `code` for a challenge that ran out: the person has to start again from the password. */
export const CHALLENGE_EXPIRED = "That sign-in took too long. Enter your email and password again.";

/** The API's message when the email is taken. The sign-up form shows it inline with a login link. */
export const EMAIL_TAKEN = "Email already in use";

export async function register(email: string, password: string, name: string, marketing = false): Promise<AuthUser> {
  return postAuth("/auth/register", { email, password, name, marketing }, "Registration failed");
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, { method: "POST", credentials: "include" });
}
