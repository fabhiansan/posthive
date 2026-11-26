import { describe, expect, it } from "vitest";
import { designExportOf, exportFormatsFor, formatFromMime } from "./designExport";

describe("formatFromMime", () => {
  it("maps the type the upload stored to the format the draft claims", () => {
    expect(formatFromMime("image/png")).toBe("png");
    expect(formatFromMime("image/jpeg")).toBe("jpeg");
    expect(formatFromMime("image/jpg")).toBe("jpeg");
    expect(formatFromMime("application/pdf")).toBe("pdf");
    expect(formatFromMime("IMAGE/PNG; charset=binary")).toBe("png");
    expect(formatFromMime("image/webp")).toBeNull();
  });
});

describe("exportFormatsFor", () => {
  it("gives LinkedIn a PDF, Instagram a JPEG, and both when the post has both", () => {
    expect(exportFormatsFor(["linkedin"])).toEqual(["pdf"]);
    expect(exportFormatsFor(["instagram"])).toEqual(["jpeg"]);
    expect(exportFormatsFor(["linkedin", "instagram"])).toEqual(["pdf", "jpeg"]);
  });

  it("gives a post with no known channel a PNG, never nothing", () => {
    expect(exportFormatsFor([])).toEqual(["png"]);
    expect(exportFormatsFor(["bluesky", "threads"])).toEqual(["png"]);
  });
});

describe("designExportOf", () => {
  const good = { instanceId: "i1", version: 3, files: [{ format: "pdf", mediaUrl: "/uploads/a.pdf" }] };

  it("reads the shape the server writes", () => {
    expect(designExportOf(good)).toEqual(good);
  });

  it("refuses anything that is not exactly that shape, so a stale or hand-written value is never shown", () => {
    expect(designExportOf(null)).toBeNull();
    expect(designExportOf({})).toBeNull();
    expect(designExportOf({ ...good, version: 0 })).toBeNull();
    expect(designExportOf({ ...good, files: [] })).toBeNull();
    expect(designExportOf({ ...good, files: [{ format: "gif", mediaUrl: "/uploads/a.gif" }] })).toBeNull();
    expect(designExportOf({ ...good, files: [{ format: "png", mediaUrl: 4 }] })).toBeNull();
  });
});
