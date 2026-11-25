// What the designer's "Mark as done" needs from Figma: a link that is not a Figma file is refused before anything is
// fetched, a 404 is private, and anything Figma does that we do not understand is "unreachable", never a refusal.
import { describe, expect, it, vi } from "vitest";
import { SafeFetchError } from "./safeFetch.js";
import { checkFigmaLink } from "./figmaCheck.js";

const LINK = "https://www.figma.com/design/Xk3aPq/env-enforcement?node-id=1-2";
const reply = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as never;

describe("checkFigmaLink", () => {
  it("a link that is not a Figma file never reaches Figma", async () => {
    const fetcher = reply(200);
    for (const bad of ["", "https://example.com/design/x", "http://www.figma.com/design/x", "https://www.figma.com/pricing", "not a link"]) {
      expect(await checkFigmaLink(bad, fetcher)).toEqual({ state: "format" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("200 is valid and carries the file's title", async () => {
    expect(await checkFigmaLink(LINK, reply(200, { title: "  Braga's Backcasting 2026 " }))).toEqual({ state: "valid", title: "Braga's Backcasting 2026" });
  });

  it("200 with no title is still valid", async () => {
    expect(await checkFigmaLink(LINK, reply(200, { version: "1.0" }))).toEqual({ state: "valid", title: null });
  });

  it("404 is private (or mistyped)", async () => {
    expect(await checkFigmaLink(LINK, reply(404, { error: true }))).toEqual({ state: "private" });
  });

  it("another status, a network error or a broken answer is unreachable, not private", async () => {
    expect(await checkFigmaLink(LINK, reply(500))).toEqual({ state: "unreachable" });
    expect(await checkFigmaLink(LINK, reply(429))).toEqual({ state: "unreachable" });
    expect(await checkFigmaLink(LINK, vi.fn(async () => { throw new SafeFetchError("slow", "TIMEOUT"); }) as never)).toEqual({ state: "unreachable" });
    expect(await checkFigmaLink(LINK, vi.fn(async () => new Response("<html>", { status: 200 })) as never)).toEqual({ state: "unreachable" });
  });

  it("asks Figma's oEmbed for exactly this link, with the bounds that keep a slow answer short", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    await checkFigmaLink(`  ${LINK}  `, fetcher as never);
    expect(fetcher).toHaveBeenCalledWith(`https://www.figma.com/api/oembed?url=${encodeURIComponent(LINK)}`, expect.objectContaining({ totalTimeoutMs: 5000, maxRedirects: 0 }));
  });
});
