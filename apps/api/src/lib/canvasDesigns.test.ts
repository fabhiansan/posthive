import crypto from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesignImageRejected, checkDesignPng, cursorsAvailable, readDesignPng, signCursor, verifyCursor } from "./canvasDesigns.js";
import { encodeCursor } from "./canvas.js";
import { canvasDesignMetadataProblem, designImageProblems, designsOfContent, pruneDesigns } from "./designImage.js";

const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]); // the CRC is not checked by the server (documented limit)
};
/** A structurally complete PNG of the given size, built by hand: the server never decodes the pixels. */
const png = (w: number, h: number, body = 0) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([MAGIC, chunk("IHDR", ihdr), chunk("IDAT", Buffer.alloc(body)), IEND]);
};
const reason = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return e instanceof DesignImageRejected ? e.code : `other:${String(e)}`;
  }
  return "ok";
};

describe("readDesignPng", () => {
  it("coalesces many tiny stream chunks without retaining one array entry per chunk", async () => {
    async function* tiny() {
      for (let i = 0; i < 100_000; i++) yield Buffer.from([i & 0xff]);
    }
    const out = await readDesignPng(Readable.from(tiny()));
    expect(out).toHaveLength(100_000);
    expect(out[0]).toBe(0);
    expect(out[99_999]).toBe(99_999 & 0xff);
  });

  it("stops at 10 MB even when the source keeps offering data", async () => {
    async function* huge() {
      for (let i = 0; i < 200; i++) yield Buffer.alloc(64 * 1024);
    }
    await expect(readDesignPng(Readable.from(huge()))).rejects.toMatchObject({ code: "TOO_LARGE" });
  });
});

describe("checkDesignPng", () => {
  it("accepts a complete PNG of exactly the approved size", () => {
    expect(reason(() => checkDesignPng(png(1080, 1350, 50), { width: 1080, height: 1350 }))).toBe("ok");
  });

  it("refuses a different size, even by one pixel, and a swapped width and height", () => {
    expect(reason(() => checkDesignPng(png(1080, 1351), { width: 1080, height: 1350 }))).toBe("SIZE_MISMATCH");
    expect(reason(() => checkDesignPng(png(1350, 1080), { width: 1080, height: 1350 }))).toBe("SIZE_MISMATCH");
  });

  it("refuses a file that is not a PNG by its BYTES (a JPEG, text, an empty file, a PNG signature alone)", () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
    for (const bad of [jpeg, Buffer.from("<svg></svg>"), Buffer.alloc(0), MAGIC]) expect(reason(() => checkDesignPng(bad, { width: 1, height: 1 }))).toBe("NOT_PNG");
  });

  it("refuses a file whose SIGNATURE is wrong even when everything after it is a perfect PNG (one byte changed)", () => {
    for (const at of [0, 1, 4, 7]) {
      const bad = png(10, 10, 40);
      bad[at] ^= 0xff;
      expect(reason(() => checkDesignPng(bad, { width: 10, height: 10 })), `byte ${at}`).toBe("NOT_PNG");
    }
  });

  it("refuses a truncated PNG, and one with bytes after IEND", () => {
    const whole = png(10, 10, 40);
    expect(reason(() => checkDesignPng(whole.subarray(0, whole.length - 5), { width: 10, height: 10 }))).toBe("NOT_PNG");
    expect(reason(() => checkDesignPng(Buffer.concat([whole, Buffer.from("tail")]), { width: 10, height: 10 }))).toBe("NOT_PNG");
  });

  it("refuses a malformed IHDR: wrong length field, wrong chunk type, zero or absurd dimensions", () => {
    const wrongLen = png(10, 10);
    wrongLen.writeUInt32BE(12, 8);
    expect(reason(() => checkDesignPng(wrongLen, { width: 10, height: 10 }))).toBe("NOT_PNG");
    const wrongType = png(10, 10);
    wrongType.write("IDAT", 12, "latin1");
    expect(reason(() => checkDesignPng(wrongType, { width: 10, height: 10 }))).toBe("NOT_PNG");
    expect(reason(() => checkDesignPng(png(0, 10), { width: 0, height: 10 }))).toBe("NOT_PNG");
    expect(reason(() => checkDesignPng(png(8193, 10), { width: 8193, height: 10 }))).toBe("NOT_PNG");
    expect(reason(() => checkDesignPng(png(0xffffffff, 0xffffffff), { width: 10, height: 10 }))).toBe("NOT_PNG");
  });

  it("refuses a file over 10 MB", () => {
    expect(reason(() => checkDesignPng(png(10, 10, 10_000_001), { width: 10, height: 10 }))).toBe("TOO_LARGE");
  });
});

describe("the signed cursor", () => {
  const KEY = "ab".repeat(32);
  let before: string | undefined;
  beforeEach(() => {
    before = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = before;
  });

  const row = { createdAt: new Date("2026-11-20T10:00:00.000Z"), id: "r1" };
  const issued = () => signCursor(row, "ws-1", "u1");

  it("round-trips for the person and the workspace it was issued to", () => {
    expect(verifyCursor(issued(), "ws-1", "u1")).toEqual({ t: row.createdAt.getTime(), i: "r1" });
  });

  it("is refused for another person in the same workspace, and for the same person in another workspace", () => {
    expect(verifyCursor(issued(), "ws-1", "u2")).toBeNull();
    expect(verifyCursor(issued(), "ws-2", "u1")).toBeNull();
  });

  it("refuses a well-shaped payload that was changed, keeping the old MAC", () => {
    const [, mac] = issued().split(".");
    const forged = encodeCursor({ createdAt: new Date("2000-01-01T00:00:00.000Z"), id: "r1" });
    expect(verifyCursor(`${forged}.${mac}`, "ws-1", "u1")).toBeNull();
    expect(verifyCursor(`${encodeCursor({ createdAt: row.createdAt, id: "r2" })}.${mac}`, "ws-1", "u1")).toBeNull();
  });

  it("refuses a MAC with one bit flipped, and any non-canonical spelling of the right one", () => {
    const [payload, mac] = issued().split(".");
    const bytes = Buffer.from(mac, "base64url");
    bytes[0] ^= 1;
    expect(verifyCursor(`${payload}.${bytes.toString("base64url")}`, "ws-1", "u1")).toBeNull();
    // 32 bytes are 43 base64url characters and the last one carries two unused bits: flipping the lowest gives the SAME bytes in another spelling
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lenient = mac.slice(0, -1) + alphabet[alphabet.indexOf(mac.slice(-1)) ^ 1];
    expect(lenient).not.toBe(mac);
    expect(Buffer.from(lenient, "base64url").equals(Buffer.from(mac, "base64url"))).toBe(true);
    expect(verifyCursor(`${payload}.${lenient}`, "ws-1", "u1")).toBeNull();
  });

  it("returns null, never throws, for a MAC of the wrong size or alphabet (timingSafeEqual would throw on a length mismatch)", () => {
    const [payload, mac] = issued().split(".");
    const bad = [
      "", // empty MAC
      mac.slice(0, 42), // 31 bytes and a bit
      Buffer.alloc(31).toString("base64url"), // 31 bytes
      Buffer.alloc(33).toString("base64url"), // 33 bytes
      Buffer.alloc(64).toString("base64url"),
      `${mac}!`, // outside the alphabet
      "####",
      "====",
    ];
    for (const m of bad) expect(() => verifyCursor(`${payload}.${m}`, "ws-1", "u1"), m).not.toThrow();
    for (const m of bad) expect(verifyCursor(`${payload}.${m}`, "ws-1", "u1"), m).toBeNull();
  });

  it("refuses no dot, two dots, an empty payload, a plain unsigned cursor, non-strings and oversize input", () => {
    const [payload, mac] = issued().split(".");
    for (const raw of [payload, `${payload}.${mac}.${mac}`, `.${mac}`, `${payload}.`, encodeCursor(row), "", undefined, null, 5, {}, [issued()], `${payload}.${mac}`.padEnd(301, "x")]) {
      expect(verifyCursor(raw, "ws-1", "u1")).toBeNull();
    }
  });

  it("refuses a correctly signed payload that is not exactly what encodeCursor writes", () => {
    const key = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(KEY, "hex"), Buffer.alloc(0), "canvas-approved-cursor", 32));
    const sign = (payload: string) => crypto.createHmac("sha256", key).update(`approved-v1\nws-1\nu1\n${payload}`).digest().toString("base64url");
    const payload = Buffer.from(JSON.stringify({ t: 1, i: "r1", extra: true })).toString("base64url");
    expect(verifyCursor(`${payload}.${sign(payload)}`, "ws-1", "u1")).toBeNull();
  });

  it("is unavailable, and refuses everything, without a valid ENCRYPTION_KEY", () => {
    const c = issued();
    for (const bad of [undefined, "", "abc", "z".repeat(64)]) {
      if (bad === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = bad;
      expect(cursorsAvailable()).toBe(false);
      expect(verifyCursor(c, "ws-1", "u1")).toBeNull();
      expect(() => signCursor(row, "ws-1", "u1")).toThrow();
    }
  });

  it("a different key does not verify another key's cursor", () => {
    const c = issued();
    process.env.ENCRYPTION_KEY = "cd".repeat(32);
    expect(verifyCursor(c, "ws-1", "u1")).toBeNull();
  });
});

describe("designImage: what a post stores and which channels cannot take it", () => {
  const one = { submissionId: "s1", mediaUrl: "/uploads/canvas-designs/s1/a.png", bytes: 2_000_000 };

  it("designsOfContent keeps only well-formed entries and ignores everything else", () => {
    expect(designsOfContent({ canvasDesigns: [one, null, 5, { submissionId: 1, mediaUrl: "x" }, { submissionId: "s", mediaUrl: "u", bytes: -1 }, { submissionId: "s", mediaUrl: "u", bytes: "9", extra: 1 }] })).toEqual([one, { submissionId: "s", mediaUrl: "u" }, { submissionId: "s", mediaUrl: "u" }]);
    for (const bad of [undefined, null, "x", 3, {}, { canvasDesigns: "x" }, { canvasDesigns: {} }]) expect(designsOfContent(bad)).toEqual([]);
  });

  it("pruneDesigns drops an entry whose picture is gone, and shows each picture once", () => {
    const b = { submissionId: "s2", mediaUrl: "/uploads/b.png" };
    expect(pruneDesigns([one, b], ["/uploads/b.png"])).toEqual([b]);
    expect(pruneDesigns([one, { ...one, submissionId: "s9" }], [one.mediaUrl])).toEqual([one]);
    expect(pruneDesigns([one, b], [])).toEqual([]);
  });

  it("Instagram: refused (JPEG only), whatever the size", () => {
    const p = designImageProblems({ canvasDesigns: [{ ...one, bytes: 10 }] }, ["instagram"]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/Instagram.*JPEG/);
  });

  it("Bluesky, Threads and LinkedIn: refused only over their size, at the exact boundary", () => {
    const at = (bytes: number) => ({ canvasDesigns: [{ ...one, bytes }] });
    expect(designImageProblems(at(976_562), ["bluesky"])).toEqual([]);
    expect(designImageProblems(at(976_563), ["bluesky"])[0]).toMatch(/Bluesky.*0\.98 MB|Bluesky.*MB/);
    expect(designImageProblems(at(8_000_000), ["threads"])).toEqual([]);
    expect(designImageProblems(at(8_000_001), ["threads"])).toHaveLength(1);
    expect(designImageProblems(at(5_000_000), ["linkedin"])).toEqual([]);
    expect(designImageProblems(at(5_000_001), ["linkedin"])).toHaveLength(1);
  });

  it("one sentence per channel, duplicates collapsed, an unknown channel has no rule, no designs means no problem", () => {
    expect(designImageProblems({ canvasDesigns: [one] }, ["instagram", "instagram", "bluesky"])).toHaveLength(2);
    expect(designImageProblems({ canvasDesigns: [one] }, ["mastodon", "x"])).toEqual([]);
    expect(designImageProblems({ mediaUrls: ["/uploads/a.png"] }, ["instagram"])).toEqual([]);
    expect(designImageProblems("not json", ["instagram"])).toEqual([]);
    expect(designImageProblems(JSON.stringify({ canvasDesigns: [one] }), ["instagram"])).toHaveLength(1); // a stored post's JSON string
  });

  it("a Canvas-design URL without matching metadata fails closed for every channel", () => {
    expect(canvasDesignMetadataProblem({ mediaUrls: [one.mediaUrl] })).toMatch(/without its design details/);
    expect(canvasDesignMetadataProblem({ mediaUrls: [one.mediaUrl], canvasDesigns: [one] })).toBeNull();
    expect(designImageProblems({ mediaUrls: [one.mediaUrl] }, ["mastodon"])).toHaveLength(1);
    expect(designImageProblems({ mediaUrls: [one.mediaUrl], canvasDesigns: [one] }, ["mastodon"])).toEqual([]);
    expect(canvasDesignMetadataProblem({ mediaUrls: [], youtubeThumbnailUrl: one.mediaUrl, youtubeVideoUrl: "https://youtu.be/x" })).toMatch(/without its design details/);
    expect(designImageProblems({ mediaUrls: [], youtubeThumbnailUrl: one.mediaUrl }, ["youtube"])).toHaveLength(1);
  });

  it("an entry without a size is not judged on size (but Instagram still refuses it)", () => {
    const nosize = { canvasDesigns: [{ submissionId: "s", mediaUrl: "u" }] };
    expect(designImageProblems(nosize, ["bluesky"])).toEqual([]);
    expect(designImageProblems(nosize, ["instagram"])).toHaveLength(1);
  });
});
