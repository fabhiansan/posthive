import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The lock protocol (mediaDelete.ts) protects only the writers that join it. This test lists every source file that writes a row which
// can hold a media address, and fails when a new one appears that is neither a protocol member nor a listed exemption. It cannot make a
// future writer correct; it makes a forgotten one visible.

const SRC = path.resolve(__dirname, "..");
const WRITE = /\b(?:postJob|libraryItem|template|legacyTemplateMedia)\.(?:create|createMany|update|updateMany|upsert)\b/;

const MEMBERS = ["lib/dripCron.ts", "routes/jobs.ts", "routes/library.ts", "routes/mcp.ts", "routes/publicApi.ts", "routes/templates.ts", "runner/jobRunner.ts"];
const EXEMPT: Record<string, string> = {
  "lib/worker.ts": "only sets a status; never a media address",
  "routes/import.ts": "writes mediaUrls: [] (an import carries no pictures)",
  "routes/canvas.ts": "sets Template.designId (the link to a Canvas design); never a media address",
};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && name !== ".vitest") sources(full, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const writers = sources(SRC)
  .map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join("/"), text: readFileSync(f, "utf8") }))
  .filter((f) => WRITE.test(f.text));

describe("every writer of a row that can hold a media address", () => {
  it("is a member of the lock protocol or a listed exemption", () => {
    const unknown = writers.filter((w) => !MEMBERS.includes(w.rel) && !(w.rel in EXEMPT)).map((w) => w.rel);
    expect(unknown, `new writer(s) of media-bearing rows: join lib/mediaDelete.ts (attachUploads / lockForCopy) or list them here with a reason`).toEqual([]);
  });

  it("members really import the protocol", () => {
    for (const rel of MEMBERS) {
      const w = writers.find((x) => x.rel === rel);
      expect(w, `${rel} no longer writes: remove it from MEMBERS`).toBeTruthy();
      expect(w!.text, rel).toMatch(/mediaDelete\.js/);
      expect(w!.text, rel).toMatch(/\b(?:attachUploads|lockForCopy)\b/);
    }
  });

  it("exemptions still hold: they do not write media addresses", () => {
    expect(readFileSync(path.join(SRC, "lib/worker.ts"), "utf8")).not.toMatch(/mediaUrls/);
    expect(readFileSync(path.join(SRC, "routes/import.ts"), "utf8")).toMatch(/mediaUrls:\s*\[\]/);
  });

  it("every deleter goes through releaseMedia: nothing calls storage.delete on a media url directly", () => {
    const direct = sources(SRC)
      .map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join("/"), text: readFileSync(f, "utf8") }))
      .filter((f) => /\b(?:storage|storageAdapter|adapter)\.delete\(/.test(f.text))
      .map((f) => f.rel);
    // Each direct caller is listed with what it deletes, so a new one is noticed. None deletes a post, Library or template image.
    const ALLOWED: Record<string, string> = {
      "lib/mediaDelete.ts": "the protocol itself, after the Upload row is gone",
      "lib/cleanupCron.ts": "orphaned avatar files in profile-pics/ and avatars/",
      "routes/accounts.ts": "a disconnected account avatar",
      "routes/profilePhoto.ts": "a user profile photo",
      "routes/canvas.ts": "a private Canvas asset whose row was never written",
      "routes/canvasDesigns.ts": "the picture of an approved design, removed only when ITS OWN Upload row could not be written in the same request (nothing can reference it yet)",
    };
    expect(direct.filter((r) => !(r in ALLOWED)).sort()).toEqual([]);
  });
});
