// How the images of a design end up when some cannot be loaded: gone, a broken setup, a storage that cannot serve them (501), or a lost
// connection. The flags decide what the editor says (a grey box, the one storage sentence, or a retry), so each ending is pinned here.
// (The editors' toasts that read these flags need the real stage and are checked in the browser.)
import { beforeEach, describe, expect, it, vi } from "vitest";

// A plain function, not vi.fn(): vitest's spy attaches its own handler to a rejected promise a mock returns, which reports an unhandled
// rejection that has nothing to do with the code under test.
const h = vi.hoisted(() => ({ impl: (async () => undefined) as (id: string) => Promise<unknown> }));
vi.mock("@/lib/canvas", async (importActual) => ({ ...(await importActual<typeof import("@/lib/canvas")>()), loadAsset: (id: string) => h.impl(id) }));
vi.mock("./CanvasBoot", () => ({ useBootReport: () => () => {} }));

import { AssetLoadError } from "@/lib/canvas";
import { loadImages } from "./useCanvasBootstrap";

const img = (id: string) => ({ id }) as unknown as HTMLImageElement;
const fails = (code: ConstructorParameters<typeof AssetLoadError>[0]) => Promise.reject(new AssetLoadError(code, "x"));

const using = (impl: (id: string) => Promise<unknown>) => { h.impl = impl; };

describe("loadImages", () => {
  it("every image loaded: nothing missing, no flag", async () => {
    using(async (id: string) => img(id));
    const out = await loadImages(["a", "b"]);
    expect([...out.images.keys()].sort()).toEqual(["a", "b"]);
    expect(out).toMatchObject({ missing: [], badBase: false, noStorage: false, failed: false });
  });

  it("a storage that cannot serve images (501): the images are missing for good, noStorage is set, and failed (the flag a retry hangs on) is not", async () => {
    using(() => fails("UNSUPPORTED"));
    const out = await loadImages(["a", "b"]);
    expect(out).toMatchObject({ noStorage: true, failed: false, badBase: false });
    expect(out.missing.sort()).toEqual(["a", "b"]);
  });

  it("an image id that is not valid is missing for good with no flag at all: nothing to retry and nothing to say about the server", async () => {
    using(() => fails("INVALID_ID"));
    const out = await loadImages(["a"]);
    expect(out).toMatchObject({ missing: ["a"], badBase: false, noStorage: false, failed: false });
  });

  it("a lost connection or a server error (FAILED) offers a retry and is not 'missing'; a gone image (NOT_FOUND) is missing and offers none", async () => {
    using((id: string) => (id === "gone" ? fails("NOT_FOUND") : id === "flaky" ? fails("FAILED") : Promise.resolve(img(id))));
    const out = await loadImages(["ok", "gone", "flaky"]);
    expect(out).toMatchObject({ failed: true, noStorage: false, badBase: false, missing: ["gone"] });
    expect([...out.images.keys()]).toEqual(["ok"]);
  });

  it("a missing API address is missing for good and says so; a mix of endings keeps each flag", async () => {
    using((id: string) => (id === "base" ? fails("BAD_API_BASE") : id === "store" ? fails("UNSUPPORTED") : fails("FAILED")));
    const out = await loadImages(["base", "store", "flaky"]);
    expect(out).toMatchObject({ badBase: true, noStorage: true, failed: true });
    expect(out.missing.sort()).toEqual(["base", "store"]);
  });

  it("an error that is not an AssetLoadError is treated as a failure that may pass on a retry (and never rejects)", async () => {
    using(() => Promise.reject(new Error("boom")));
    await expect(loadImages(["a"])).resolves.toMatchObject({ failed: true, missing: [], noStorage: false });
  });
});
