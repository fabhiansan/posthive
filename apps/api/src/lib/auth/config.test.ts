// Startup validation of the local provider's signing secret (lib/auth/config.ts). The check is a pure function of the environment it is
// given; what makes it a STARTUP check is that index.ts calls it first thing in main(), which the last describe pins.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authProviderName, validateAuthConfig } from "./config.js";

const VALID = "0123456789abcdef".repeat(4); // 64 hex characters = 32 bytes
const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv => over as NodeJS.ProcessEnv;
const local = (secret: string | undefined) => env({ AUTH_PROVIDER: "local", JWT_ACCESS_SECRET: secret });

describe("validateAuthConfig with the local provider", () => {
  it.each([
    ["64 lowercase hex characters", VALID],
    ["64 uppercase hex characters", VALID.toUpperCase()],
    ["64 mixed-case hex characters", "aB3F".repeat(16)],
    ["what `openssl rand -hex 32` makes", "5843c4fa910e25509bcab2c59490352ba15e8a1eeaf89b4d5800c499c211e026"],
  ])("accepts %s", (_what, secret) => {
    expect(() => validateAuthConfig(local(secret))).not.toThrow();
  });

  it.each([
    ["unset", undefined],
    ["empty (the shipped deploy/prod/env.example line `JWT_ACCESS_SECRET=`)", ""],
  ])("refuses a secret that is %s, and says it is missing", (_what, secret) => {
    expect(() => validateAuthConfig(local(secret))).toThrow(/JWT_ACCESS_SECRET is missing or empty/);
  });

  it.each([
    ["63 hex characters", VALID.slice(1)],
    ["65 hex characters", VALID + "0"],
    ["128 hex characters (two secrets pasted together)", VALID + VALID],
    ["64 characters with one non-hex letter", "g" + VALID.slice(1)],
    ["a 0x prefix and 62 hex characters (64 in all)", "0x" + VALID.slice(2)],
    ["the .env.example placeholder", "your-access-secret-here"],
    ["the .env.docker placeholder", "replace_with_64_char_hex"],
    ["only whitespace", "   "],
    ["a valid secret with a leading space", " " + VALID],
    ["a valid secret with a trailing newline", VALID + "\n"],
    ["a valid secret with its quotes still on", `"${VALID}"`],
    ["a 32-byte secret in base64 (44 characters)", Buffer.from(VALID, "hex").toString("base64")],
    ["64 full-width digits (not ASCII hex)", "０".repeat(64)],
  ])("refuses a secret that is %s, and says what the format is", (_what, secret) => {
    expect(() => validateAuthConfig(local(secret))).toThrow(/must be exactly 64 hexadecimal characters/);
  });

  it("is the same when AUTH_PROVIDER is unset, empty, or anything but exactly 'supabase' (the selection lib/auth/index.ts makes)", () => {
    for (const provider of [undefined, "", "local", "LOCAL", "Supabase", "SUPABASE", " supabase", "supabase ", "firebase"]) {
      expect(() => validateAuthConfig(env({ AUTH_PROVIDER: provider, JWT_ACCESS_SECRET: undefined })), String(provider)).toThrow(/missing or empty/);
      expect(() => validateAuthConfig(env({ AUTH_PROVIDER: provider, JWT_ACCESS_SECRET: "short" })), String(provider)).toThrow(/exactly 64/);
      expect(() => validateAuthConfig(env({ AUTH_PROVIDER: provider, JWT_ACCESS_SECRET: VALID })), String(provider)).not.toThrow();
    }
  });

  // An operator reads this message in a log, and the log may be shipped (Railway, Sentry): it must never carry any of the value.
  it.each([
    ["a malformed value", "Zq7!distinctive-Secret-value-0f3a9"],
    ["a 63-character hex value", "f3a9c1d27be84a05" + "9c3d6e1b7a2f4058" + "e1d9b3c7a5f20846" + "b7c3e9d1a4f6082"],
  ])("never contains the value, any 8-character piece of it, or its length (%s)", (_what, secret) => {
    let message = "";
    try {
      validateAuthConfig(local(secret));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/exactly 64/);
    for (let i = 0; i + 8 <= secret.length; i++) expect(message).not.toContain(secret.slice(i, i + 8));
    expect(message).not.toMatch(new RegExp(`\\b${secret.length}\\b`));
  });

  it("reads process.env when it is given nothing, and the environment is left as it was", () => {
    const saved = { p: process.env.AUTH_PROVIDER, s: process.env.JWT_ACCESS_SECRET };
    try {
      delete process.env.AUTH_PROVIDER;
      delete process.env.JWT_ACCESS_SECRET;
      expect(() => validateAuthConfig()).toThrow(/missing or empty/);
      process.env.JWT_ACCESS_SECRET = VALID;
      expect(() => validateAuthConfig()).not.toThrow();
    } finally {
      if (saved.p === undefined) delete process.env.AUTH_PROVIDER;
      else process.env.AUTH_PROVIDER = saved.p;
      if (saved.s === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = saved.s;
    }
  });
});

describe("validateAuthConfig with another provider: the variable is not used, so it is not asked for", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["malformed", "your-access-secret-here"],
    ["valid", VALID],
  ])("AUTH_PROVIDER=supabase with the secret %s: nothing thrown", (_what, secret) => {
    expect(() => validateAuthConfig(env({ AUTH_PROVIDER: "supabase", JWT_ACCESS_SECRET: secret }))).not.toThrow();
  });

  it("authProviderName: only exactly 'supabase' is supabase", () => {
    expect(authProviderName(env({ AUTH_PROVIDER: "supabase" }))).toBe("supabase");
    for (const p of [undefined, "", "local", "Supabase", " supabase", "supabase "]) {
      expect(authProviderName(env({ AUTH_PROVIDER: p })), String(p)).toBe("local");
    }
  });
});

describe("importing the module validates nothing", () => {
  const saved = process.env.JWT_ACCESS_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = saved;
  });
  it("config.ts loads cleanly with no secret in the environment (the check runs only when it is called)", async () => {
    delete process.env.JWT_ACCESS_SECRET;
    vi.resetModules();
    const fresh = await import("./config.js");
    expect(typeof fresh.validateAuthConfig).toBe("function");
  });
});

// The check only protects anything if the process runs it before it listens. Loading the whole app takes 15-30 s on a slow disk, so the
// ORDER is pinned in the source (and was run against the real src/index.ts once, by hand, for the change that added it).
describe("startup wiring: index.ts calls validateAuthConfig first in main(), and nothing else calls it", () => {
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
  const index = src("../../index.ts");
  const main = index.slice(index.indexOf("async function main()"));

  it("it is the first statement of main(), before storage, Fastify, the listener and the worker exist", () => {
    expect(index).toContain("async function main()");
    const body = main.slice(main.indexOf("{") + 1).trimStart();
    expect(body.startsWith("validateAuthConfig();")).toBe(true);
    const call = main.indexOf("validateAuthConfig()");
    for (const later of ["new LocalDiskStorage", "new R2Storage", "new SupabaseStorage", "Fastify(", "app.listen(", "startWorker("]) {
      expect(main.indexOf(later), later).toBeGreaterThan(call);
    }
  });

  it("a failed main() ends the process with a non-zero exit code (so the platform sees a crash, not a healthy server)", () => {
    expect(index).toMatch(/main\(\)\.catch\(\(err\) => \{[^}]*process\.exit\(1\)/s);
  });

  it("no other source file calls it (in particular, nothing calls it while being imported)", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const callers = (readdirSync(root, { recursive: true }) as string[])
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))
      .filter((p) => readFileSync(root + p, "utf8").includes("validateAuthConfig("))
      .sort();
    expect(callers).toEqual(["index.ts", "lib/auth/config.ts"]); // the call, and the definition
  });

  it("the provider is chosen by the same function the check uses, so the two cannot drift apart", () => {
    const auth = src("./index.ts");
    expect(auth).toContain("authProviderName()");
    expect(auth).not.toContain("process.env.AUTH_PROVIDER");
  });
});
