import { describe, expect, it } from "vitest";
import { contentMediaUrls, externalMediaUrl, isStoredUploadPath, mediaUrlList, toStoredUrl } from "./mediaUrl.js";

describe("isStoredUploadPath", () => {
  it.each(["/uploads/a.png", "/uploads/3f2a-1b.jpg", "/uploads/folder/a_b-c.webp", "/uploads/a/b/c.png"])("accepts %s", (u) => expect(isStoredUploadPath(u)).toBe(true));
  it.each([
    "/uploads/../x", "/uploads/a/../../x", "/uploads/./x", "/uploads//x", "/uploads/a//b", "/uploads/", "/uploads", "/uploads/.canvas-private/ws/a.png",
    "/uploads/.hidden", "/uploads/a/.b", "/uploads/..\\x", "/uploads/a b.png", "/uploads/a%2e%2e/x", "/uploads/%2e%2e/x", "/uploads/a.png\0", "/uploads/a:b",
    "uploads/a.png", "/other/a.png", "https://x.test/uploads/a.png", "file:///etc/passwd", "", "/uploads/" + "a".repeat(2100),
  ])("refuses %j", (u) => expect(isStoredUploadPath(u)).toBe(false));
  it("refuses things that are not strings", () => {
    for (const v of [null, undefined, 1, {}, ["/uploads/a.png"]]) expect(isStoredUploadPath(v)).toBe(false);
  });
});

describe("externalMediaUrl", () => {
  it.each(["https://example.com/a.png", "http://example.com/a.png", "https://cdn.example.com:8443/a.png?x=1#y", "https://8.8.8.8/a.png"])("accepts %s", (u) => expect(externalMediaUrl(u)).toBe(u));
  it.each([
    "https://localhost/a", "https://127.0.0.1/a", "https://[::1]/a", "https://169.254.169.254/x", "https://10.0.0.1/a", "https://2130706433/a", "https://svc.internal/a",
    "file:///etc/passwd", "javascript:alert(1)", "data:image/png;base64,AAAA", "ftp://example.com/a", "//example.com/a", "/uploads/a.png",
    "https://u:p@example.com/a", "https://example.com/a b", "https://example.com/a\n", "https://example.com\\a", "https://example.com/" + "a".repeat(2100), "", "nope",
  ])("refuses %j", (u) => expect(externalMediaUrl(u)).toBeNull());
  it("refuses non strings", () => {
    for (const v of [null, undefined, 1, {}]) expect(externalMediaUrl(v)).toBeNull();
  });
});

describe("toStoredUrl / mediaUrlList", () => {
  const env = { PUBLIC_API_URL: "https://api.example.test/", API_URL: "https://internal.example.test" } as unknown as NodeJS.ProcessEnv;
  it("maps the API origin in front of /uploads/ to the stored path, and nothing else", () => {
    expect(toStoredUrl("https://api.example.test/uploads/a.png", env)).toBe("/uploads/a.png");
    expect(toStoredUrl("https://internal.example.test/uploads/a.png", env)).toBe("/uploads/a.png");
    expect(toStoredUrl("https://api.example.test/other/a.png", env)).toBe("https://api.example.test/other/a.png");
    expect(toStoredUrl("https://api.example.test.evil.test/uploads/a.png", env)).toBe("https://api.example.test.evil.test/uploads/a.png");
    expect(toStoredUrl("https://evil.test/uploads/a.png", env)).toBe("https://evil.test/uploads/a.png");
    expect(toStoredUrl("https://api.example.test/uploads/a.png", {} as NodeJS.ProcessEnv)).toBe("https://api.example.test/uploads/a.png");
  });
  it("mediaUrlList is an array of strings of bounded length, or null", () => {
    expect(mediaUrlList(["https://api.example.test/uploads/a.png", "/uploads/b.png"], env)).toEqual(["/uploads/a.png", "/uploads/b.png"]);
    expect(mediaUrlList([], env)).toEqual([]);
    for (const bad of ["x", null, undefined, {}, [1], [null], ["a".repeat(2100)]]) expect(mediaUrlList(bad, env)).toBeNull();
  });
});

describe("contentMediaUrls", () => {
  it("collects pictures, the YouTube thumbnail and the YouTube video address", () => {
    const c = JSON.stringify({ mediaUrls: ["/uploads/a.png", "/uploads/b.png"], youtubeThumbnailUrl: "/uploads/t.png", youtubeVideoUrl: "https://youtu.be/x" });
    expect(contentMediaUrls(c)).toEqual(["/uploads/a.png", "/uploads/b.png", "/uploads/t.png", "https://youtu.be/x"]);
  });
  it("is empty for content that is not JSON, not an object, or has no media; and ignores non strings", () => {
    for (const c of ["", "not json", "null", "[]", "{}", JSON.stringify({ mediaUrls: "x" })]) expect(contentMediaUrls(c)).toEqual([]);
    expect(contentMediaUrls(JSON.stringify({ mediaUrls: [1, null, "/uploads/a.png", ""], youtubeThumbnailUrl: 5 }))).toEqual(["/uploads/a.png"]);
  });
});
