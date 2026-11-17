// Loading a design's images is the one place stored data meets a credentialed request. These tests pin that the
// request can only ever go to <API base>/canvas/assets/<valid id>/content, and that a bad id or a bad API base is
// refused before anything is sent. Node environment, a stubbed fetch, no DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../../canvas/src/limits";
import { ASSET_ID, AssetLoadError, assetContentUrl, createDesign, deleteDesign, getDesign, listDesigns, loadAsset, saveDesign } from "./canvas";

const png = () => new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), { status: 200 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
let decodeFails = false;

beforeEach(() => {
  fetchMock = vi.fn(async () => png());
  vi.stubGlobal("fetch", fetchMock);
  decodeFails = false;
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = async () => {
        if (decodeFails) throw new Error("bad image");
      };
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err instanceof AssetLoadError ? err.code : `other: ${String(err)}`;
  }
  return "resolved";
};

describe("the id pattern", () => {
  it("is the engine's pattern", () => {
    expect(ASSET_ID.source).toBe(LIMITS.id.source);
    expect(ASSET_ID.flags).toBe(LIMITS.id.flags);
  });
});

describe("loadAsset takes an id and nothing else", () => {
  const HOSTILE: unknown[] = [
    "https://evil.example/x.png",
    "http://localhost:3001/user/me",
    "//evil.example/x",
    "/user/me",
    "/canvas/assets/abc/content",
    "..",
    "../x",
    "..%2fx",
    "a/b",
    "a\\b",
    "a?b",
    "a#b",
    "a%2e%2e",
    "a%2Fb",
    "abc\n",
    "abc\r\n",
    "a b",
    " abc",
    "",
    "x".repeat(65),
    "ａｂｃ", // fullwidth letters
    "a∕b", // a division slash that looks like /
    "a／b", // fullwidth solidus
    "a\u0000b",
    "javascript:alert(1)",
    "data:text/plain,x",
    undefined,
    null,
    5,
    {},
    [],
    ["abc"],
    { toString: () => "abc" },
  ];

  it.each(HOSTILE.map((id) => [JSON.stringify(id) ?? String(id), id]))("refuses %s before any request is made", async (_label, id) => {
    expect(await code(loadAsset(id as string))).toBe("INVALID_ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the id before it looks at the API address", () => {
    expect(() => assetContentUrl("../x", "")).toThrowError(expect.objectContaining({ code: "INVALID_ID" }));
    expect(() => assetContentUrl("abc", "")).toThrowError(expect.objectContaining({ code: "BAD_API_BASE" }));
  });

  it.each(["abc", "a-b_c", "x".repeat(64), "550e8400-e29b-41d4-a716-446655440000", "ckx1y2z3a0000abcd", "A1"])("sends exactly one credentialed request for %s", async (id) => {
    const img = await loadAsset(id);
    expect(img).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`http://localhost:3001/canvas/assets/${id}/content`, { credentials: "include", cache: "no-store" });
  });
});

describe("the API address", () => {
  it.each([
    ["http://localhost:3001", "http://localhost:3001/canvas/assets/abc/content"],
    ["http://127.0.0.1:3001", "http://127.0.0.1:3001/canvas/assets/abc/content"],
    ["https://api.yourdomain.com", "https://api.yourdomain.com/canvas/assets/abc/content"],
    ["https://marketing.playmates.dev/api", "https://marketing.playmates.dev/api/canvas/assets/abc/content"], // the prefix is kept
    ["https://marketing.playmates.dev/api/", "https://marketing.playmates.dev/api/canvas/assets/abc/content"], // a trailing slash does not double
    ["https://marketing.playmates.dev/api///", "https://marketing.playmates.dev/api/canvas/assets/abc/content"],
    ["https://x.example/", "https://x.example/canvas/assets/abc/content"],
    ["HTTPS://X.EXAMPLE/api", "https://x.example/api/canvas/assets/abc/content"],
  ])("accepts %s and builds %s", (base, expected) => {
    expect(assetContentUrl("abc", base)).toBe(expected);
  });

  it.each([
    ["empty", ""],
    ["spaces", "   "],
    ["a relative path", "/api"],
    ["a protocol-relative address", "//evil.example"],
    ["no scheme", "api.example.com"],
    ["no scheme, with a path", "api.example.com/api"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/plain,x"],
    ["ftp", "ftp://x/api"],
    ["a single slash after the scheme", "http:/x"],
    ["no slashes after the scheme", "http:x"],
    ["backslashes", "https:\\\\x\\api"],
    ["a query", "https://x/api?x=1"],
    ["an empty query", "https://x/api?"],
    ["a hash", "https://x/api#h"],
    ["credentials", "https://user:pass@x/api"],
    ["a username only", "https://user@x/api"],
    ["surrounding spaces", " https://x/api "],
    ["a space inside", "https://x y/api"],
    ["no host", "https:///api"],
    ["a number", 5],
    ["null", null],
    // (undefined is not listed: as an argument it means "use the configured API_BASE", which the tests below set to bad values)
  ])("refuses %s as BAD_API_BASE", (_label, base) => {
    expect(() => assetContentUrl("abc", base as string)).toThrowError(expect.objectContaining({ code: "BAD_API_BASE" }));
  });

  describe("through the real configuration (NEXT_PUBLIC_API_URL)", () => {
    async function withBase(value: string | undefined) {
      vi.resetModules();
      if (value === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else vi.stubEnv("NEXT_PUBLIC_API_URL", value);
      return import("./canvas");
    }
    const original = process.env.NEXT_PUBLIC_API_URL;
    afterEach(() => {
      if (original === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = original;
    });

    it("unset: the same default the whole app uses", async () => {
      const mod = await withBase(undefined);
      await mod.loadAsset("abc");
      expect(fetchMock).toHaveBeenCalledWith("http://localhost:3001/canvas/assets/abc/content", expect.anything());
    });

    it("production style, with a prefix and a trailing slash: one slash only", async () => {
      const mod = await withBase("https://marketing.playmates.dev/api/");
      await mod.loadAsset("abc");
      expect(fetchMock).toHaveBeenCalledWith("https://marketing.playmates.dev/api/canvas/assets/abc/content", { credentials: "include", cache: "no-store" });
    });

    it.each([["empty (a build with the variable declared but not set)", ""], ["a relative path", "/api"], ["no scheme", "api.example.com"]])("%s: fails explicitly and sends nothing", async (_label, value) => {
      const mod = await withBase(value);
      const err = await mod.loadAsset("abc").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(mod.AssetLoadError);
      expect((err as AssetLoadError).code).toBe("BAD_API_BASE");
      expect((err as AssetLoadError).message).toMatch(/API address is not configured/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe("answers", () => {
  it("one expired access token: the shared refresh runs, then the same address is asked once more", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 })).mockResolvedValueOnce(json({ user: {} })).mockResolvedValueOnce(png());
    await loadAsset("abc");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [first, session, retry] = fetchMock.mock.calls;
    expect(session[0]).toBe("http://localhost:3001/auth/session");
    expect(retry[0]).toBe(first[0]);
    expect(retry[1]).toEqual({ credentials: "include", cache: "no-store" });
  });

  it("a second 401 is a failure, with no loop", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).includes("/auth/session") ? json({ user: {} }) : new Response("", { status: 401 })));
    expect(await code(loadAsset("abc"))).toBe("FAILED");
    const assetCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/canvas/assets/"));
    expect(assetCalls).toHaveLength(2);
  });

  it("404 is NOT_FOUND, other answers and a lost connection are FAILED, an undecodable image is FAILED", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    const missing = await loadAsset("abc").catch((e: AssetLoadError) => e);
    expect(missing).toMatchObject({ code: "NOT_FOUND", message: "This image no longer exists." });

    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await code(loadAsset("abc"))).toBe("FAILED");

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await code(loadAsset("abc"))).toBe("FAILED");

    decodeFails = true;
    const unreadable = await loadAsset("abc").catch((e: AssetLoadError) => e);
    expect(unreadable).toMatchObject({ code: "FAILED", message: "The image could not be read." });
  });
});

describe("design calls", () => {
  const last = () => fetchMock.mock.calls.at(-1) as [string, RequestInit];

  it("create sends an empty object, or just the name", async () => {
    fetchMock.mockImplementation(async () => json({ design: { id: "d1" } }, 201));
    await createDesign();
    expect(last()[0]).toBe("http://localhost:3001/canvas/designs");
    expect(last()[1]).toMatchObject({ method: "POST", body: "{}", credentials: "include" });
    // The API only creates a design from a JSON body (a request with no content type is refused with 415).
    expect(last()[1].headers).toMatchObject({ "Content-Type": "application/json" });
    await createDesign("Spring sale");
    expect(last()[1].body).toBe('{"name":"Spring sale"}');
    expect(last()[1].headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("get, save and delete address the design by an encoded id", async () => {
    fetchMock.mockImplementation(async () => json({ ok: true }));
    await getDesign("a/b?c");
    expect(last()[0]).toBe("http://localhost:3001/canvas/designs/a%2Fb%3Fc");
    await saveDesign("d1", { version: 3, document: { schemaVersion: 1, width: 1, height: 1, background: { color: "#FFFFFF" }, nodes: [] }, name: "A" });
    expect(last()[0]).toBe("http://localhost:3001/canvas/designs/d1");
    expect(last()[1].method).toBe("PUT");
    expect(JSON.parse(last()[1].body as string)).toEqual({ version: 3, document: { schemaVersion: 1, width: 1, height: 1, background: { color: "#FFFFFF" }, nodes: [] }, name: "A" });
    await deleteDesign("d1");
    expect(last()[1].method).toBe("DELETE");
    await listDesigns();
    expect(last()[0]).toBe("http://localhost:3001/canvas/designs");
  });

  it("a failed call carries the status and the server's message for the autosave to read", async () => {
    fetchMock.mockResolvedValue(json({ error: "This design was changed somewhere else.", code: "VERSION_CONFLICT" }, 409));
    const err = await saveDesign("d1", { version: 1, document: { schemaVersion: 1, width: 1, height: 1, background: { color: "#FFFFFF" }, nodes: [] } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, message: "This design was changed somewhere else.", data: { code: "VERSION_CONFLICT" } });
  });
});
