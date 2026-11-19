// LinkedIn retires each monthly API version about a year after it ships, and a retired one answers 426 to every call.
// These tests pin the version rules and what a failed post throws, with the network replaced by a fake.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; headers: Record<string, string> }> }));

vi.mock("../lib/prisma.js", () => ({ prisma: { account: { update: vi.fn() } } }));

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "0".repeat(64);
});

import { DEFAULT_LI_VERSION, linkedInVersion, linkedinAdapter, versionAgeMonths } from "./linkedin.js";
import { explainPublishError } from "../lib/publishError.js";
import { encrypt } from "../lib/encryption.js";

const account = () =>
  ({
    id: "a1",
    platform: "linkedin",
    credentials: encrypt(JSON.stringify({ accessToken: "tok", refreshToken: "r", personUrn: "urn:li:person:1", expiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 3_600_000 })),
  }) as never;

const answer = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers });

beforeEach(() => {
  h.calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the API version", () => {
  it("the default is not the retired 202511", () => {
    expect(DEFAULT_LI_VERSION).not.toBe("202511");
    expect(DEFAULT_LI_VERSION).toMatch(/^\d{6}$/);
  });

  it("LINKEDIN_API_VERSION changes it; a value that is not a month is ignored, so a typo cannot stop posting", () => {
    expect(linkedInVersion("202701")).toBe("202701");
    expect(linkedInVersion(" 202701 ")).toBe("202701");
    for (const bad of ["", "2027", "202713", "202700", "v202609", "latest", undefined]) expect(linkedInVersion(bad)).toBe(DEFAULT_LI_VERSION);
  });

  it("its age in months: this is how a version that is about to be retired is noticed", () => {
    const now = new Date("2026-11-18T00:00:00Z");
    expect(versionAgeMonths("202611", now)).toBe(0);
    expect(versionAgeMonths("202511", now)).toBe(12); // the one that just stopped working
    expect(versionAgeMonths("202609", now)).toBe(2);
    expect(versionAgeMonths("nope", now)).toBeNull();
  });

  it("every call sends that version in the LinkedIn-Version header", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      h.calls.push({ url, headers: init.headers });
      return answer(201, "", { "x-restli-id": "urn:li:share:99" });
    }));
    const result = await linkedinAdapter.createPost(account(), { text: "Hello", mediaUrls: [] });
    expect(result.platformPostId).toBe("urn:li:share:99");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe("https://api.linkedin.com/rest/posts");
    expect(h.calls[0].headers["LinkedIn-Version"]).toBe(linkedInVersion());
  });
});

describe("a post LinkedIn refuses", () => {
  const fail = async (status: number, body: string) => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(status, body)));
    return linkedinAdapter.createPost(account(), { text: "Hello", mediaUrls: [] }).then(
      () => { throw new Error("should have failed"); },
      (err: unknown) => err,
    );
  };

  it("the error of the report: the raw answer stays in the message for the log, and the person reads a plain sentence", async () => {
    const err = await fail(426, '{"status":426,"code":"NONEXISTENT_VERSION","message":"Requested version 20251101 is not active"}');
    expect((err as Error).message).toContain("NONEXISTENT_VERSION");
    const text = explainPublishError("linkedin", err);
    expect(text).toMatch(/^LinkedIn changed how its connection works/);
    expect(text).not.toMatch(/[{}]|426|20251101|NONEXISTENT/);
  });

  it("an expired token, a rate limit and a LinkedIn outage each read as what they are", async () => {
    expect(explainPublishError("linkedin", await fail(401, '{"status":401,"code":"REVOKED_ACCESS_TOKEN"}'))).toMatch(/^Your LinkedIn connection has expired/);
    expect(explainPublishError("linkedin", await fail(429, '{"status":429,"message":"Resource level throttle"}'))).toMatch(/^LinkedIn is limiting how fast/);
    expect(explainPublishError("linkedin", await fail(503, "<html>Service Unavailable</html>"))).toMatch(/^LinkedIn had a problem on its side/);
  });
});
