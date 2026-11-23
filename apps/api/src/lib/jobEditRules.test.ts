import { describe, expect, it } from "vitest";
import { CANVAS_KEYS, canEditJob, sameContent, shouldResetReview, withoutCanvasKeys } from "./jobEditRules.js";

describe("sameContent (what counts as a content change)", () => {
  it("ignores empty values the edit form always sends", () => {
    expect(sameContent('{"text":"a","title":"t"}', '{"text":"a","title":"t","perAccount":{},"mediaUrls":[]}')).toBe(true);
  });

  it("ignores key order", () => {
    expect(sameContent('{"a":1,"b":2}', '{"b":2,"a":1}')).toBe(true);
  });

  it("detects a changed title or caption", () => {
    expect(sameContent('{"title":"a"}', '{"title":"b"}')).toBe(false);
    expect(sameContent('{"text":"a"}', '{"text":"a!"}')).toBe(false);
  });

  it("detects added media", () => {
    expect(sameContent('{"mediaUrls":[]}', '{"mediaUrls":["/a.png"]}')).toBe(false);
  });
});

const job = (patch: Partial<{ status: string; approvalStatus: string | null }> = {}) => ({
  status: "draft",
  approvalStatus: null as string | null,
  ...patch,
});

describe("canEditJob: Marketing (member) changing the post date or content", () => {
  it.each([
    ["plain draft", job()],
    ["draft in review", job({ approvalStatus: "pending" })],
    ["rejected draft", job({ approvalStatus: "rejected" })],
  ])("is allowed on a %s, whoever made it: a plan is imported by one person and kept by the team", (_name, j) => {
    expect(canEditJob("member", j)).toEqual({ ok: true });
  });

  it("is locked once approved (Scheduled)", () => {
    const r = canEditJob("member", job({ status: "pending", approvalStatus: "approved" }));
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("is locked on published / failed posts", () => {
    expect(canEditJob("member", job({ status: "done" }))).toMatchObject({ ok: false, status: 409 });
    expect(canEditJob("member", job({ status: "failed" }))).toMatchObject({ ok: false, status: 409 });
  });

  it("is not about who made the draft: the same answer for the uploader and for a colleague", () => {
    // the rule takes no user at all, so a draft cannot be one person's and closed to the others
    expect(canEditJob.length).toBe(2);
    for (const j of [job(), job({ approvalStatus: "pending" }), job({ approvalStatus: "rejected" })]) {
      expect(canEditJob("member", j)).toEqual({ ok: true });
    }
  });

  it("still locks an approved post for Marketing, whoever made it", () => {
    expect(canEditJob("member", job({ status: "pending", approvalStatus: "approved" }))).toMatchObject({ ok: false, status: 403 });
    expect(canEditJob("member", job({ status: "pending" }))).toMatchObject({ ok: false, status: 403 });
  });
});

describe("canEditJob: other roles", () => {
  it("lets admin and owner edit an approved post, even someone else's", () => {
    const approved = job({ status: "pending", approvalStatus: "approved" });
    expect(canEditJob("admin", approved)).toEqual({ ok: true });
    expect(canEditJob("owner", approved)).toEqual({ ok: true });
  });

  it("denies the design team and unknown roles", () => {
    expect(canEditJob("designer", job({ approvalStatus: "pending" }))).toMatchObject({ ok: false, status: 403 });
    expect(canEditJob(null, job())).toMatchObject({ ok: false, status: 403 });
  });
});

describe("shouldResetReview", () => {
  const inReview = job({ approvalStatus: "pending" });
  const rejected = job({ approvalStatus: "rejected" });

  it("does not reset for a date-only change", () => {
    expect(shouldResetReview("member", inReview, false)).toBe(false);
    expect(shouldResetReview("member", rejected, false)).toBe(false);
  });

  it("resets an in-review or rejected draft when content changes", () => {
    expect(shouldResetReview("member", inReview, true)).toBe(true);
    expect(shouldResetReview("member", rejected, true)).toBe(true);
  });

  it("never resets a plain draft", () => {
    expect(shouldResetReview("member", job(), true)).toBe(false);
  });

  it("never resets when a manage role edits", () => {
    expect(shouldResetReview("admin", inReview, true)).toBe(false);
    expect(shouldResetReview("owner", inReview, true)).toBe(false);
  });
});

describe("sameContent: the keys it is told to ignore", () => {
  const studio = '{"text":"a","canvasInstanceId":"ci","canvasTemplateId":"ct"}';

  it("the Studio link is not a change, so opening the Studio never sends a post back out of review", () => {
    expect(sameContent('{"text":"a"}', studio, CANVAS_KEYS)).toBe(true);
    expect(sameContent(studio, '{"text":"a","canvasInstanceId":"other","canvasTemplateId":"ct"}', CANVAS_KEYS)).toBe(true);
  });

  it("without the list the same difference counts, and a real change still counts with it", () => {
    expect(sameContent('{"text":"a"}', studio)).toBe(false);
    expect(sameContent('{"text":"a"}', studio.replace('"a"', '"b"'), CANVAS_KEYS)).toBe(false);
  });

  it("content that is not an object is compared as it is", () => {
    expect(sameContent("[1]", "[1]", CANVAS_KEYS)).toBe(true);
    expect(sameContent("not json", "not json", CANVAS_KEYS)).toBe(true);
    expect(sameContent("not json", "other", CANVAS_KEYS)).toBe(false);
  });
});

describe("withoutCanvasKeys: what a copy of a post keeps", () => {
  it("drops the Studio link and keeps everything else", () => {
    expect(JSON.parse(withoutCanvasKeys('{"text":"a","youtubeTags":["x"],"canvasInstanceId":"ci","canvasTemplateId":"ct"}'))).toEqual({ text: "a", youtubeTags: ["x"] });
  });

  it("a post that has no link is returned as the very same string (not re-formatted)", () => {
    const raw = '{ "text": "a" }';
    expect(withoutCanvasKeys(raw)).toBe(raw);
  });

  it("content that is not an object is returned as it is", () => {
    expect(withoutCanvasKeys("not json")).toBe("not json");
    expect(withoutCanvasKeys("[1]")).toBe("[1]");
  });
});
