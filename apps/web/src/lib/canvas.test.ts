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

describe("revisions and the template link (phase 4)", () => {
  const last = () => fetchMock.mock.calls.at(-1) as [string, RequestInit];

  it("publish names only the version, to the design's own address", async () => {
    fetchMock.mockImplementation(async () => json({ revision: { number: 1, designVersion: 3, createdAt: "2026-11-17T00:00:00Z" } }, 201));
    const { publishDesign } = await import("./canvas");
    await publishDesign("d1", 3);
    expect(last()[0]).toBe("http://localhost:3001/canvas/designs/d1/publish");
    expect(last()[1]).toMatchObject({ method: "POST", body: '{"version":3}', credentials: "include" });
    expect(last()[1].headers).toMatchObject({ "Content-Type": "application/json" }); // the API refuses anything but JSON
    expect(Object.keys(JSON.parse(last()[1].body as string))).toEqual(["version"]); // never a document, a manifest or a number
  });

  it("create-for-template is one POST with an empty object, to the template's own address (the server makes and links the design)", async () => {
    fetchMock.mockImplementation(async () => json({ design: { id: "d9", name: "Case Study", version: 1 } }, 201));
    const { createDesignForTemplate } = await import("./canvas");
    const res = await createDesignForTemplate("t/1?x");
    expect(res.design.id).toBe("d9");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(last()[0]).toBe("http://localhost:3001/canvas/templates/t%2F1%3Fx/design");
    expect(last()[1]).toMatchObject({ method: "POST", body: "{}", credentials: "include" });
    expect(last()[1].headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("attach and detach address the template by an encoded id", async () => {
    fetchMock.mockImplementation(async () => json({ ok: true }));
    const { attachDesign, detachDesign } = await import("./canvas");
    await attachDesign("t/1?x", "d1");
    expect(last()[0]).toBe("http://localhost:3001/canvas/templates/t%2F1%3Fx/design");
    expect(last()[1]).toMatchObject({ method: "PUT", body: '{"designId":"d1"}' });
    expect(last()[1].headers).toMatchObject({ "Content-Type": "application/json" });
    await detachDesign("t1");
    expect(last()[0]).toBe("http://localhost:3001/canvas/templates/t1/design");
    expect(last()[1].method).toBe("DELETE");
  });

  it.each(["NO_CHANGES", "INVALID_PUBLISH", "UNKNOWN_ASSET", "TEMPLATE_HAS_DESIGN", "DESIGN_LINKED", "DESIGN_NEEDS_REVISION", "SOURCE_REQUIRED", "VERSION_CONFLICT"])(
    "a refusal with the code %s reaches the page with its status, message and code",
    async (code) => {
      fetchMock.mockImplementation(async () => json({ error: `refused: ${code}`, code }, 409)); // a fresh Response each call: a body can be read once
      const { publishDesign, attachDesign, detachDesign } = await import("./canvas");
      for (const call of [() => publishDesign("d1", 1), () => attachDesign("t1", "d1"), () => detachDesign("t1")]) {
        const err = await call().catch((e: unknown) => e);
        expect(err).toMatchObject({ status: 409, message: `refused: ${code}`, data: { code } });
      }
    },
  );
});

describe("Marketing's designs: instances (phase 5)", () => {
  const last = () => fetchMock.mock.calls.at(-1) as [string, RequestInit];
  const body = () => JSON.parse(last()[1].body as string) as Record<string, unknown>;

  it("customize names only the template, as JSON, to the instances address", async () => {
    fetchMock.mockImplementation(async () => json({ instance: { id: "i1", name: "Case Study", version: 1, createdAt: "2026-11-18T00:00:00Z", baseRevision: { number: 2, createdAt: "2026-11-18T00:00:00Z" } } }, 201));
    const { createInstance } = await import("./canvas");
    const res = await createInstance("tpl-1");
    expect(res.instance.id).toBe("i1");
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances");
    expect(last()[1]).toMatchObject({ method: "POST", credentials: "include" });
    expect(last()[1].headers).toMatchObject({ "Content-Type": "application/json" }); // the API refuses anything but JSON
    expect(body()).toEqual({ templateId: "tpl-1" }); // never a revision, a kind, a workspace or an author
  });

  it("get and delete address the design by an encoded id", async () => {
    fetchMock.mockImplementation(async () => json({ ok: true }));
    const { getInstance, deleteInstance } = await import("./canvas");
    await getInstance("a/b?c");
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances/a%2Fb%3Fc");
    expect(last()[1]).toMatchObject({ credentials: "include" });
    await deleteInstance("i1");
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances/i1");
    expect(last()[1].method).toBe("DELETE");
  });

  it("save sends the whole set of changes, the version, and a name only when one is given", async () => {
    fetchMock.mockImplementation(async () => json({ version: 2 }));
    const { saveInstance } = await import("./canvas");
    await saveInstance("i1", { version: 1, overrides: [{ nodeId: "head", text: "Hello" }, { nodeId: "photo", assetId: "asset-2" }] });
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances/i1");
    expect(last()[1]).toMatchObject({ method: "PUT", credentials: "include" });
    expect(last()[1].headers).toMatchObject({ "Content-Type": "application/json" });
    expect(body()).toEqual({ version: 1, overrides: [{ nodeId: "head", text: "Hello" }, { nodeId: "photo", assetId: "asset-2" }] });
    await saveInstance("i1", { version: 2, overrides: [], name: "Spring launch" });
    expect(body()).toEqual({ version: 2, overrides: [], name: "Spring launch" }); // [] is sent, not left out: a missing list is never "no change"
  });

  it("the first page asks for no cursor and no limit; the next pages carry the cursor the server gave", async () => {
    fetchMock.mockImplementation(async () => json({ instances: [], nextCursor: null }));
    const { listInstances } = await import("./canvas");
    await listInstances();
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances");
    await listInstances(null);
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances");
    await listInstances("abc_DEF-123");
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances?cursor=abc_DEF-123");
    await listInstances("abc", 20);
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances?limit=20&cursor=abc");
  });

  it("a cursor is passed on exactly as the server wrote it, and cannot add a parameter or change the path", async () => {
    fetchMock.mockImplementation(async () => json({ instances: [], nextCursor: null }));
    const { listInstances } = await import("./canvas");
    await listInstances("a&limit=1000#x/../y");
    const url = new URL(last()[0]);
    expect(url.pathname).toBe("/canvas/instances");
    expect([...url.searchParams.keys()]).toEqual(["cursor"]);
    expect(url.searchParams.get("cursor")).toBe("a&limit=1000#x/../y"); // encoded, so it stays one value
  });

  it.each(["NO_CANVAS_REVISION", "INVALID_OVERRIDES", "DUPLICATE_NODE", "UNKNOWN_NODE", "LOCKED_NODE", "TEXT_TOO_LONG", "UNKNOWN_ASSET", "INVALID_NAME", "VERSION_CONFLICT", "INVALID_LIMIT", "INVALID_CURSOR"])(
    "a refusal with the code %s reaches the page with its status, message and code",
    async (code) => {
      fetchMock.mockImplementation(async () => json({ error: `refused: ${code}`, code }, code === "VERSION_CONFLICT" || code === "NO_CANVAS_REVISION" ? 409 : 400));
      const { createInstance, saveInstance, listInstances } = await import("./canvas");
      for (const call of [() => createInstance("t"), () => saveInstance("i", { version: 1, overrides: [] }), () => listInstances()]) {
        const err = await call().catch((e: unknown) => e);
        expect(err).toMatchObject({ message: `refused: ${code}`, data: { code } });
      }
    },
  );

  it("a 404 (another person's design, or one that is gone) carries its status, which the editor shows as 'doesn't exist'", async () => {
    fetchMock.mockImplementation(async () => json({ error: "Design not found" }, 404));
    const { getInstance } = await import("./canvas");
    expect(await getInstance("i1").catch((e: unknown) => e)).toMatchObject({ status: 404 });
  });
});

describe("which images a Marketing design draws (instanceSource.imageIds)", () => {
  const image = (id: string, assetId: string) => ({ id, type: "image", assetId });
  const record = (nodes: unknown[], overrides: unknown[]) => ({ document: { nodes }, overrides }) as never;

  // The first import of the hook file loads React and the UI kit; on a cold start that can pass vitest's 5 s default.
  it("is the images its revision draws plus the ones Marketing replaced them with, each once", { timeout: 30_000 }, async () => {
    const { instanceSource } = await import("../components/canvas/useCanvasBootstrap");
    const doc = [image("photo", "asset-1"), { id: "head", type: "text" }, image("logo", "asset-logo"), image("again", "asset-1")];
    expect(instanceSource.imageIds(record(doc, []))).toEqual(["asset-1", "asset-logo"]); // the base only, a repeat counted once
    expect(instanceSource.imageIds(record(doc, [{ nodeId: "photo", assetId: "asset-2" }]))).toEqual(["asset-1", "asset-logo", "asset-2"]);
    expect(instanceSource.imageIds(record(doc, [{ nodeId: "photo", assetId: "asset-1" }, { nodeId: "head", text: "Hi" }]))).toEqual(["asset-1", "asset-logo"]); // a replacement that is already drawn, and a text, add nothing
  });

  it("a design with no image asks for none", async () => {
    const { instanceSource } = await import("../components/canvas/useCanvasBootstrap");
    expect(instanceSource.imageIds(record([{ id: "head", type: "text" }], [{ nodeId: "head", text: "x" }]))).toEqual([]);
  });
});
