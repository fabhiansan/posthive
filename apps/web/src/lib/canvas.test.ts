// Loading a design's images is the one place stored data meets a credentialed request. These tests pin that the
// request can only ever go to <API base>/canvas/assets/<valid id>/content, and that a bad id or a bad API base is
// refused before anything is sent. Node environment, a stubbed fetch, no DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../../canvas/src/limits";
import { ASSET_ID, AssetLoadError, STORAGE_UNSUPPORTED_MESSAGE, assetContentUrl, canvasProblem, createDesign, deleteDesign, getDesign, listDesigns, loadAsset, saveDesign } from "./canvas";

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

  // Phase 7: a server whose storage cannot serve private images answers 501 CANVAS_STORAGE_UNSUPPORTED. That was a retryable
  // "FAILED" ("check your connection", with a Try again that could never work); it is its own, final code now.
  it("501 (the server's storage cannot serve images) is UNSUPPORTED: not a connection problem, and asked for once, not retried", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: "CANVAS_STORAGE_UNSUPPORTED" }), { status: 501 }));
    const err = await loadAsset("abc").catch((e: AssetLoadError) => e);
    expect(err).toMatchObject({ code: "UNSUPPORTED", message: STORAGE_UNSUPPORTED_MESSAGE });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no refresh, no second attempt
    expect(STORAGE_UNSUPPORTED_MESSAGE).not.toMatch(/connection/i);
    // the wording the user chose, and nothing technical in it
    expect(STORAGE_UNSUPPORTED_MESSAGE).toBe("Image previews are unavailable in this environment. You can continue editing, but image layers may appear as placeholders.");
  });
});

describe("canvasProblem: a plain sentence for a failed Canvas call", () => {
  const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

  it("a lost connection (fetch's own TypeError, no status) says the person seems to be offline", () => {
    expect(canvasProblem(new TypeError("Failed to fetch"))).toMatch(/offline/i);
    expect(canvasProblem(new TypeError("Load failed"))).toMatch(/offline/i); // Safari's wording
    expect(canvasProblem(new TypeError("NetworkError when attempting to fetch resource."))).toMatch(/offline/i); // Firefox's
    expect(canvasProblem(new TypeError("fetch failed"))).toMatch(/offline/i); // Node's (server-side rendering)
    expect(canvasProblem(new TypeError("The network connection was lost."))).toMatch(/offline/i); // Safari's other wording
  });

  it("429 and 503 (the limits and the sign-in gate, which send Retry-After) and 5xx each have their own sentence, never the raw text", () => {
    expect(canvasProblem(apiError(429, "Rate limit exceeded — slow down and try again shortly"))).toMatch(/too fast/i);
    expect(canvasProblem(apiError(503, "Sign-in is busy — try again in a moment"))).toMatch(/busy/i);
    expect(canvasProblem(apiError(500, "Internal Server Error"))).toMatch(/problem on its side/i);
    expect(canvasProblem(apiError(502, "Bad Gateway"))).toMatch(/problem on its side/i);
  });

  it("a 501 is the server saying on purpose that it cannot do this (an upload on storage that is not local): the person gets the one plain sentence, never the server's text and never 'a problem on its side'", () => {
    const sent = "Canvas image assets need local storage (STORAGE_PROVIDER=local). R2 and Supabase private storage is not supported yet.";
    const shown = canvasProblem(apiError(501, sent), "The image could not be added.");
    expect(shown).toBe(STORAGE_UNSUPPORTED_MESSAGE); // the fixed sentence, so neither the setting's name nor "a problem on its side" can appear
    expect(canvasProblem(apiError(501, "501 error"))).toBe(STORAGE_UNSUPPORTED_MESSAGE); // whatever the body said, or did not
    expect(canvasProblem(apiError(500, "Internal Server Error"))).toMatch(/problem on its side/i); // only 501 is special
  });

  it("a TypeError that is not a network failure is a bug in the page, not 'offline': it gets the generic sentence", () => {
    expect(canvasProblem(new TypeError("Cannot read properties of undefined (reading 'name')"), "The image could not be added.")).toBe("The image could not be added.");
    expect(canvasProblem(new TypeError("x is not a function"))).toBe("Something went wrong. Try again.");
    // a bug that merely MENTIONS fetch or network is still a bug, not a lost connection
    expect(canvasProblem(new TypeError("Cannot read properties of undefined (reading 'fetch')"))).toBe("Something went wrong. Try again.");
    expect(canvasProblem(new TypeError("network.connect is not a function"))).toBe("Something went wrong. Try again.");
  });

  it("what the server says on purpose (a 400 or 409) is kept: it says what to fix", () => {
    expect(canvasProblem(apiError(409, "This design was changed somewhere else."))).toBe("This design was changed somewhere else.");
    expect(canvasProblem(apiError(400, "The name is too long."))).toBe("The name is too long.");
  });

  it("apiFetch's own empty '404 error' text is replaced by the caller's fallback, and a plain Error without a status keeps its words", () => {
    expect(canvasProblem(apiError(404, "404 error"), "The design could not be deleted.")).toBe("The design could not be deleted.");
    expect(canvasProblem(new Error("The file is larger than 10 MB."), "x")).toBe("The file is larger than 10 MB."); // ours, says what it means
    expect(canvasProblem("a string", "fallback")).toBe("fallback");
    expect(canvasProblem(undefined)).toBe("Something went wrong. Try again.");
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

describe("design review (phase 6)", () => {
  const last = () => fetchMock.mock.calls.at(-1) as [string, RequestInit];
  const body = () => JSON.parse(last()[1].body as string) as Record<string, unknown>;

  it("submitting names the saved version and, only when there is one, the note: never a document, overrides or revision", async () => {
    fetchMock.mockImplementation(async () => json({ submission: { id: "s1", number: 1, createdAt: "x" }, review: { id: "r1", status: "pending" } }, 201));
    const { submitInstance } = await import("./canvas");
    await submitInstance("i1", 3);
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances/i1/submit");
    expect(last()[1]).toMatchObject({ method: "POST", credentials: "include" });
    expect(last()[1].headers).toMatchObject({ "Content-Type": "application/json" }); // the API refuses anything but JSON
    expect(body()).toEqual({ version: 3 });
    await submitInstance("i1", 3, "For the launch");
    expect(body()).toEqual({ version: 3, note: "For the launch" });
    await submitInstance("i1", 3, ""); // an empty note is no note
    expect(body()).toEqual({ version: 3 });
  });

  it("the design's id is encoded, so it cannot change the path", async () => {
    fetchMock.mockImplementation(async () => json({ submissions: [], nextCursor: null }));
    const { listSubmissions, getSubmission, submitInstance } = await import("./canvas");
    await listSubmissions("a/b?c");
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances/a%2Fb%3Fc/submissions");
    await listSubmissions("i1", "2");
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances/i1/submissions?cursor=2");
    await getSubmission("i1", 4);
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances/i1/submissions/4");
    await submitInstance("a/b", 1).catch(() => {});
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances/a%2Fb/submit");
  });

  it("the archived list is asked for with archived=1, next to a cursor, and active is the default", async () => {
    fetchMock.mockImplementation(async () => json({ instances: [], nextCursor: null }));
    const { listInstances } = await import("./canvas");
    await listInstances(null, undefined, true);
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances?archived=1");
    await listInstances("c1", undefined, true);
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances?cursor=c1&archived=1");
    await listInstances("c1", undefined, false);
    expect(last()[0]).toBe("http://localhost:3001/canvas/instances?cursor=c1");
  });

  it("the design team's calls: the summary, a queue view with its cursor, one review, and a decision with an optional comment", async () => {
    fetchMock.mockImplementation(async () => json({ reviews: [], nextCursor: null, pending: 0, latestSubmittedAt: null, ok: true }));
    const { reviewSummaryCount, listReviews, getReview, decideReview } = await import("./canvas");
    await reviewSummaryCount();
    expect(last()[0]).toBe("http://localhost:3001/canvas/reviews/summary");
    await listReviews("pending");
    expect(last()[0]).toBe("http://localhost:3001/canvas/reviews?status=pending");
    await listReviews("decided", "abc_1");
    expect(last()[0]).toBe("http://localhost:3001/canvas/reviews?status=decided&cursor=abc_1");
    await getReview("r/1");
    expect(last()[0]).toBe("http://localhost:3001/canvas/reviews/r%2F1");
    await decideReview("r1", "approve");
    expect(last()[0]).toBe("http://localhost:3001/canvas/reviews/r1/decision");
    expect(last()[1]).toMatchObject({ method: "POST", credentials: "include" });
    expect(body()).toEqual({ decision: "approve" });
    await decideReview("r1", "request_changes", "Shorter");
    expect(body()).toEqual({ decision: "request_changes", comment: "Shorter" });
  });

  it("archiving answers with archived: true, and a plain delete without it", async () => {
    const { deleteInstance } = await import("./canvas");
    fetchMock.mockImplementation(async () => json({ ok: true, archived: true }));
    expect(await deleteInstance("i1")).toEqual({ ok: true, archived: true });
    fetchMock.mockImplementation(async () => json({ ok: true }));
    expect((await deleteInstance("i1")).archived).toBeUndefined();
  });

  it.each(["NO_CHANGES", "NO_REVIEWER", "VERSION_CONFLICT", "UNKNOWN_ASSET", "NOT_PENDING", "DESIGN_ARCHIVED"])("a refusal with the code %s reaches the page with its status and code", async (code) => {
    fetchMock.mockImplementation(async () => json({ error: `refused: ${code}`, code }, code === "DESIGN_ARCHIVED" ? 404 : 409));
    const { submitInstance, decideReview } = await import("./canvas");
    for (const call of [() => submitInstance("i", 1), () => decideReview("r", "approve")]) {
      expect(await call().catch((e: unknown) => e)).toMatchObject({ message: `refused: ${code}`, data: { code } });
    }
  });
});

describe("liveReview and canSubmitReview", () => {
  const base = (over: Partial<import("./canvas").ReviewSummary> = {}): import("./canvas").ReviewSummary => ({
    latestReviewStatus: "approved", hasChangesSinceSubmitted: false, submissionNumber: 1, submittedVersion: 2, workingVersion: 2, submittedAt: "x", latestReviewId: "r1", comment: null, decidedAt: "y", ...over,
  });
  const head = (text: string) => ({ nodeId: "head", text });
  // the engine's own comparison, as the editor passes it
  const same = (a: readonly { nodeId: string }[], b: readonly { nodeId: string }[]) => JSON.stringify(a) === JSON.stringify(b);

  it("nothing submitted: the server's facts, untouched (no changes to report)", async () => {
    const { liveReview } = await import("./canvas");
    const r = base({ latestReviewStatus: null, submissionNumber: null });
    expect(liveReview(r, null, { name: "N", overrides: [head("x")] }, same)).toBe(r);
  });

  it("an edit sets the changes flag and NEVER touches the answer; reverting clears the flag; a rename counts", async () => {
    const { liveReview } = await import("./canvas");
    const submitted = { name: "N", overrides: [head("A")] };
    for (const status of ["pending", "approved", "changes_requested"] as const) {
      const r = base({ latestReviewStatus: status });
      expect(liveReview(r, submitted, { name: "N", overrides: [head("A")] }, same)).toMatchObject({ latestReviewStatus: status, hasChangesSinceSubmitted: false });
      expect(liveReview(r, submitted, { name: "N", overrides: [head("B")] }, same)).toMatchObject({ latestReviewStatus: status, hasChangesSinceSubmitted: true });
      expect(liveReview(r, submitted, { name: "Renamed", overrides: [head("A")] }, same)).toMatchObject({ latestReviewStatus: status, hasChangesSinceSubmitted: true });
    }
    // A, then B, then A again (typed locally, before any save): back to no changes
    const r = base();
    expect(liveReview(r, submitted, { name: "N", overrides: [head("B")] }, same).hasChangesSinceSubmitted).toBe(true);
    expect(liveReview(r, submitted, { name: "N", overrides: [head("A")] }, same).hasChangesSinceSubmitted).toBe(false);
  });

  it("does not change what it was given", async () => {
    const { liveReview } = await import("./canvas");
    const r = base();
    const before = JSON.stringify(r);
    liveReview(r, { name: "N", overrides: [] }, { name: "X", overrides: [head("A")] }, same);
    expect(JSON.stringify(r)).toBe(before);
  });

  it("can submit when nothing was submitted, or when there are changes; not otherwise (the same rule as the API's)", async () => {
    const { canSubmitReview } = await import("./canvas");
    expect(canSubmitReview({ latestReviewStatus: null, hasChangesSinceSubmitted: false })).toBe(true);
    for (const s of ["pending", "approved", "changes_requested"] as const) {
      expect(canSubmitReview({ latestReviewStatus: s, hasChangesSinceSubmitted: false }), s).toBe(false);
      expect(canSubmitReview({ latestReviewStatus: s, hasChangesSinceSubmitted: true }), s).toBe(true);
    }
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
