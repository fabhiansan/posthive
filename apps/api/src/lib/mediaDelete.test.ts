import { describe, expect, it, vi } from "vitest";
import { attachUploads, BadMediaUrl, lockForCopy, lockUploads, MediaUnavailable, mediaProblem, referencedUrls, releaseMedia, withUploads } from "./mediaDelete.js";
import { fakeUploads } from "./fakeUploads.js";

// A small database with REAL row-lock semantics for the Upload table, so the two orders of a writer and a deleter are deterministic:
// a transaction that locks a url holds it until it commits, and another transaction that asks for it waits. Everything else (the
// reference scan, the post rows) is plain in-memory state read at the moment it is asked, like READ COMMITTED.

type Gate = { release: () => void };
function world(uploads: Array<{ url: string; userId: string; claimed?: boolean }>) {
  const rows = new Map(uploads.map((u) => [u.url, { url: u.url, userId: u.userId, claimedAt: u.claimed === false ? null : new Date() }]));
  const refs = new Set<string>(); // the urls some post/item/template references (committed)
  const held = new Map<string, Promise<void>>(); // url -> the lock's release promise
  const events: string[] = [];
  const unlinked: string[] = [];
  const stalls = new Map<string, Promise<void>>(); // named points where a test pauses a transaction

  async function acquire(urls: string[], release: Promise<void>, owner: string) {
    for (const u of [...urls].sort()) {
      if (!rows.has(u)) continue; // no row, nothing to lock
      while (held.has(u)) await held.get(u);
      let done!: () => void;
      const p = new Promise<void>((r) => (done = r));
      held.set(u, p);
      release.then(() => { held.delete(u); done(); });
      events.push(`${owner}:lock:${u}`);
    }
  }

  function client(owner: string, release: Promise<void>, writes: Array<() => void>) {
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("?");
        if (text.includes("FOR UPDATE")) {
          const urls = values[0] as string[];
          await acquire(urls, release, owner);
          return urls.filter((u) => rows.has(u)).map((u) => ({ ...rows.get(u)! }));
        }
        if (text.includes("unnest")) {
          await stalls.get(`${owner}:scan`);
          const urls = values[0] as string[];
          events.push(`${owner}:scan`);
          return urls.filter((u) => refs.has(u)).map((url) => ({ url }));
        }
        return [];
      },
      upload: {
        updateMany: async (a: { where: { url: { in: string[] }; userId?: string }; data: { claimedAt: Date } }) => {
          writes.push(() => a.where.url.in.forEach((u) => { const r = rows.get(u); if (r && (!a.where.userId || r.userId === a.where.userId)) r.claimedAt = a.data.claimedAt; }));
          return { count: a.where.url.in.length };
        },
        deleteMany: async (a: { where: { url: { in: string[] } } }) => {
          writes.push(() => a.where.url.in.forEach((u) => rows.delete(u)));
          return { count: a.where.url.in.length };
        },
      },
      template: { findMany: async () => [] },
      legacyTemplateMedia: { findMany: async () => [] },
      // the writer's own row: committed on commit
      post: { create: async (urls: string[]) => void writes.push(() => urls.forEach((u) => refs.add(u))) },
    };
    return tx;
  }

  const db = {
    $transaction: async <T>(fn: (tx: any) => Promise<T>, opts?: unknown): Promise<T> => {
      void opts;
      const owner = `t${events.length}`;
      let commit!: () => void;
      const release = new Promise<void>((r) => (commit = r));
      const writes: Array<() => void> = [];
      try {
        const out = await fn(client(owner, release, writes));
        writes.forEach((w) => w()); // commit: the writes become visible, then the locks go
        return out;
      } finally {
        commit();
      }
    },
  };
  const storage = { delete: vi.fn(async (u: string) => void unlinked.push(u)) };
  const stall = (key: string) => { let go!: () => void; stalls.set(key, new Promise<void>((r) => (go = r))); return { release: go } as Gate; };
  return { rows, refs, db, storage, events, unlinked, stall };
}

const attachPost = (w: ReturnType<typeof world>, urls: string[], userId: string) =>
  withUploads(urls, (tx) => attachUploads(tx, urls, { userId }), async (tx) => (tx as any).post.create(urls), w.db as any);

describe("attachUploads", () => {
  it("claims the caller's own rows and leaves a url in `keep` alone", async () => {
    const t = fakeUploads([{ url: "/uploads/a.png", userId: "u1", claimedAt: null }, { url: "/uploads/b.png", userId: "other", claimedAt: null }]);
    await attachUploads(t as any, ["/uploads/a.png", "/uploads/b.png"], { userId: "u1", keep: ["/uploads/b.png"] });
    expect(t.rows.get("/uploads/a.png")!.claimedAt).toBeInstanceOf(Date);
    expect(t.rows.get("/uploads/b.png")!.claimedAt).toBeNull();
  });
  it("another person's file, a stored path with no row, and an unknown address are refused", async () => {
    const t = fakeUploads([{ url: "/uploads/theirs.png", userId: "other", claimedAt: null }]);
    await expect(attachUploads(t as any, ["/uploads/theirs.png"], { userId: "u1" })).rejects.toBeInstanceOf(MediaUnavailable);
    await expect(attachUploads(t as any, ["/uploads/gone.png"], { userId: "u1" })).rejects.toBeInstanceOf(MediaUnavailable);
    await expect(attachUploads(t as any, ["https://example.com/a.png"], { userId: "u1" })).rejects.toBeInstanceOf(BadMediaUrl);
    await expect(attachUploads(t as any, ["../x"], { userId: "u1" })).rejects.toBeInstanceOf(BadMediaUrl);
    expect(t.rows.get("/uploads/theirs.png")!.claimedAt).toBeNull();
  });
  it("an outside address passes only when the caller allows it AND it is a safe address", async () => {
    const t = fakeUploads();
    await attachUploads(t as any, ["https://example.com/a.png"], { userId: "u1", external: ["https://example.com/a.png"] });
    await expect(attachUploads(t as any, ["https://127.0.0.1/a.png"], { userId: "u1", external: ["https://127.0.0.1/a.png"] })).rejects.toBeInstanceOf(BadMediaUrl);
    await expect(attachUploads(t as any, ["/uploads/../etc"], { userId: "u1", external: ["/uploads/../etc"] })).rejects.toBeInstanceOf(BadMediaUrl);
  });
  it("a url that has a row is an upload even if listed as external (the owner check still applies)", async () => {
    const t = fakeUploads([{ url: "https://example.com/a.png", userId: "other", claimedAt: null }]);
    await expect(attachUploads(t as any, ["https://example.com/a.png"], { userId: "u1", external: ["https://example.com/a.png"] })).rejects.toBeInstanceOf(MediaUnavailable);
  });
  it("locks every url in ONE statement, sorted, so two multi-file operations cannot deadlock", async () => {
    const t = fakeUploads([{ url: "/uploads/b.png", userId: "u1", claimedAt: null }, { url: "/uploads/a.png", userId: "u1", claimedAt: null }]);
    await attachUploads(t as any, ["/uploads/b.png", "/uploads/a.png"], { userId: "u1" });
    expect(t.calls("lock")).toHaveLength(1);
    expect(t.calls("lock")[0].args).toEqual(["/uploads/a.png", "/uploads/b.png"]);
  });
  it("nothing to attach does nothing, not even a query", async () => {
    const t = fakeUploads();
    await attachUploads(t as any, [], { userId: "u1" });
    expect(t.log).toEqual([]);
  });
});

describe("mediaProblem / lockForCopy / lockUploads", () => {
  it("maps the two media errors and nothing else", () => {
    expect(mediaProblem(new MediaUnavailable())).toMatchObject({ status: 409, body: { code: "MEDIA_UNAVAILABLE" } });
    expect(mediaProblem(new BadMediaUrl("x"))).toMatchObject({ status: 400, body: { code: "INVALID_MEDIA_URL" } });
    expect(mediaProblem(new Error("boom"))).toBeNull();
  });
  it("a copy fails when its source is gone once the files are locked, and passes when it is there", async () => {
    const t = fakeUploads([{ url: "/uploads/a.png", userId: "u1" }] as any);
    await expect(lockForCopy(t as any, ["/uploads/a.png"], async () => false)).rejects.toBeInstanceOf(MediaUnavailable);
    await expect(lockForCopy(t as any, ["/uploads/a.png"], async () => true)).resolves.toBeUndefined();
    expect(t.calls("lock")).toHaveLength(2);
    const none = fakeUploads();
    await lockForCopy(none as any, [], async () => false); // no files: nothing to protect, the source check is not needed
    expect(none.log).toEqual([]);
  });
  it("lockUploads with no urls asks the database nothing", async () => {
    const t = fakeUploads();
    expect((await lockUploads(t as any, [])).size).toBe(0);
    expect(t.log).toEqual([]);
  });
});

describe("releaseMedia: what may be deleted", () => {
  it("deletes an unreferenced file of an allowed owner: row first, unlink after commit", async () => {
    const w = world([{ url: "/uploads/a.png", userId: "u1" }]);
    expect(await releaseMedia(w.storage, ["/uploads/a.png"], ["u1"], { db: w.db as any })).toEqual(["/uploads/a.png"]);
    expect(w.rows.has("/uploads/a.png")).toBe(false);
    expect(w.unlinked).toEqual(["/uploads/a.png"]);
  });
  it("keeps a file something references (shared by a duplicate, a repeat, a library item, a published post...)", async () => {
    const w = world([{ url: "/uploads/a.png", userId: "u1" }]);
    w.refs.add("/uploads/a.png");
    expect(await releaseMedia(w.storage, ["/uploads/a.png"], ["u1"], { db: w.db as any })).toEqual([]);
    expect(w.rows.has("/uploads/a.png")).toBe(true);
    expect(w.storage.delete).not.toHaveBeenCalled();
  });
  it("never deletes somebody else's file, or a url with no Upload row", async () => {
    const w = world([{ url: "/uploads/theirs.png", userId: "other" }]);
    expect(await releaseMedia(w.storage, ["/uploads/theirs.png", "/uploads/norow.png", "https://example.com/x.png"], ["u1"], { db: w.db as any })).toEqual([]);
    expect(w.rows.has("/uploads/theirs.png")).toBe(true);
    expect(w.storage.delete).not.toHaveBeenCalled();
  });
  it("a hostile address never reaches storage.delete, whatever the owners are", async () => {
    const w = world([]);
    await releaseMedia(w.storage, ["/uploads/../../etc/passwd", "../x", "/etc/passwd"], ["u1"], { db: w.db as any });
    expect(w.storage.delete).not.toHaveBeenCalled();
  });
  it("the orphan cleaner (\"unclaimed\") removes only unclaimed rows, and CLAIMS one that is referenced instead of deleting it", async () => {
    const w = world([{ url: "/uploads/orphan.png", userId: "u1", claimed: false }, { url: "/uploads/used.png", userId: "u1", claimed: false }, { url: "/uploads/claimed.png", userId: "u1" }]);
    w.refs.add("/uploads/used.png");
    const out = await releaseMedia(w.storage, ["/uploads/orphan.png", "/uploads/used.png", "/uploads/claimed.png"], "unclaimed", { db: w.db as any });
    expect(out).toEqual(["/uploads/orphan.png"]);
    expect(w.rows.get("/uploads/used.png")!.claimedAt).toBeInstanceOf(Date);
    expect(w.rows.has("/uploads/claimed.png")).toBe(true);
  });
  it("a failing unlink is not an error (a file with no row is a leak, not a loss)", async () => {
    const w = world([{ url: "/uploads/a.png", userId: "u1" }]);
    w.storage.delete.mockRejectedValueOnce(new Error("EBUSY"));
    await expect(releaseMedia(w.storage, ["/uploads/a.png"], ["u1"], { db: w.db as any })).resolves.toEqual(["/uploads/a.png"]);
  });
  it("works through more than 100 files in chunks", async () => {
    const urls = Array.from({ length: 250 }, (_, i) => `/uploads/f${i}.png`);
    const w = world(urls.map((url) => ({ url, userId: "u1" })));
    expect(await releaseMedia(w.storage, urls, ["u1"], { db: w.db as any })).toHaveLength(250);
  });
});

describe("referencedUrls", () => {
  it("counts template previews, slides and legacy kit files as references", async () => {
    const tx = {
      $queryRaw: async () => [{ url: "/uploads/post.png" }],
      template: { findMany: async () => [{ previewUrl: "/uploads/p.png", slideUrls: ["/uploads/s1.png"] }] },
      legacyTemplateMedia: { findMany: async () => [{ url: "/uploads/legacy.png" }] },
    };
    expect([...(await referencedUrls(tx as any, ["/uploads/post.png", "/uploads/p.png", "/uploads/s1.png", "/uploads/legacy.png", "/uploads/free.png"]))].sort()).toEqual(
      ["/uploads/legacy.png", "/uploads/p.png", "/uploads/post.png", "/uploads/s1.png"],
    );
  });
});

describe("the protocol under both orders of a writer and a deleter (deterministic row locks)", () => {
  it("DELETER FIRST: the writer waits for the deleter's commit, finds the row gone, gets a clean 409 and creates NO reference", async () => {
    const w = world([{ url: "/uploads/a.png", userId: "u1" }]);
    const hold = w.stall("t0:scan"); // pause the deleter after it holds the lock, before it scans
    const deleting = releaseMedia(w.storage, ["/uploads/a.png"], ["u1"], { db: w.db as any });
    await vi.waitFor(() => expect(w.events).toContain("t0:lock:/uploads/a.png"));
    const writing = attachPost(w, ["/uploads/a.png"], "u1").then(() => "attached", (e) => e);
    await new Promise((r) => setTimeout(r, 30));
    expect(w.events.filter((e) => e.includes(":lock:"))).toHaveLength(1); // the writer is blocked, it did not get the lock
    hold.release();
    expect(await deleting).toEqual(["/uploads/a.png"]);
    expect(await writing).toBeInstanceOf(MediaUnavailable);
    expect(w.refs.size).toBe(0);
    expect(w.unlinked).toEqual(["/uploads/a.png"]);
  });

  it("WRITER FIRST: the deleter waits for the writer's commit, its scan sees the new reference, and the file is KEPT", async () => {
    const w = world([{ url: "/uploads/a.png", userId: "u1" }]);
    let proceed!: () => void;
    const gate = new Promise<void>((r) => (proceed = r));
    const writing = withUploads(["/uploads/a.png"], async (tx) => { await attachUploads(tx, ["/uploads/a.png"], { userId: "u1" }); await gate; }, async (tx) => (tx as any).post.create(["/uploads/a.png"]), w.db as any);
    await vi.waitFor(() => expect(w.events).toContain("t0:lock:/uploads/a.png"));
    const deleting = releaseMedia(w.storage, ["/uploads/a.png"], ["u1"], { db: w.db as any });
    await new Promise((r) => setTimeout(r, 30));
    expect(w.events.some((e) => e.endsWith(":scan"))).toBe(false); // the deleter has not scanned: it is waiting
    proceed();
    await writing;
    expect(await deleting).toEqual([]);
    expect(w.rows.has("/uploads/a.png")).toBe(true);
    expect(w.refs.has("/uploads/a.png")).toBe(true);
    expect(w.storage.delete).not.toHaveBeenCalled();
  });

  it("a COPY (repeat / duplicate / drip) racing a delete of its source: a missing source fails the copy, never a reference to a deleted file", async () => {
    const w = world([{ url: "/uploads/a.png", userId: "u1" }]);
    w.refs.add("/uploads/a.png"); // the source post references it
    let sourceExists = true;
    const hold = w.stall("t0:scan");
    // the deleter removes the SOURCE post first (so nothing references the file), then releases the media
    const deleting = (async () => { w.refs.delete("/uploads/a.png"); sourceExists = false; return releaseMedia(w.storage, ["/uploads/a.png"], ["u1"], { db: w.db as any }); })();
    await vi.waitFor(() => expect(w.events).toContain("t0:lock:/uploads/a.png"));
    const copying = withUploads(["/uploads/a.png"], (tx) => lockForCopy(tx, ["/uploads/a.png"], async () => sourceExists), async (tx) => (tx as any).post.create(["/uploads/a.png"]), w.db as any).then(() => "copied", (e) => e);
    hold.release();
    await deleting;
    expect(await copying).toBeInstanceOf(MediaUnavailable);
    expect(w.refs.has("/uploads/a.png")).toBe(false);
  });

  it("an attach racing the orphan cleaner: the cleaner either loses the race (file kept, claimed) or wins it (the attach gets 409)", async () => {
    const w = world([{ url: "/uploads/a.png", userId: "u1", claimed: false }]);
    const [cleaned, attached] = await Promise.all([
      releaseMedia(w.storage, ["/uploads/a.png"], "unclaimed", { db: w.db as any }),
      attachPost(w, ["/uploads/a.png"], "u1").then(() => "attached", (e) => e),
    ]);
    if (attached === "attached") {
      expect(cleaned).toEqual([]); // the writer was first: the cleaner saw the claim and the reference
      expect(w.rows.has("/uploads/a.png")).toBe(true);
    } else {
      expect(attached).toBeInstanceOf(MediaUnavailable);
      expect(cleaned).toEqual(["/uploads/a.png"]);
    }
    expect(w.rows.has("/uploads/a.png") ? w.unlinked : [w.refs.size]).toEqual(w.rows.has("/uploads/a.png") ? [] : [0]);
  });

  it("two multi-file operations in opposite order do not deadlock (sorted locks)", async () => {
    const w = world([{ url: "/uploads/a.png", userId: "u1" }, { url: "/uploads/b.png", userId: "u1" }]);
    const both = await Promise.race([
      Promise.all([attachPost(w, ["/uploads/a.png", "/uploads/b.png"], "u1"), attachPost(w, ["/uploads/b.png", "/uploads/a.png"], "u1"), releaseMedia(w.storage, ["/uploads/b.png", "/uploads/a.png"], ["u1"], { db: w.db as any })]).then(() => "done", () => "done"),
      new Promise((r) => setTimeout(() => r("deadlock"), 2000)),
    ]);
    expect(both).toBe("done");
  });

  it("CONTROL: a writer that does NOT take the lock can lose the file. This is the residual risk, shown so it is not hidden", async () => {
    const w = world([{ url: "/uploads/a.png", userId: "u1" }]);
    const hold = w.stall("t0:scan"); // the deleter has locked and is about to scan
    const deleting = releaseMedia(w.storage, ["/uploads/a.png"], ["u1"], { db: w.db as any });
    await vi.waitFor(() => expect(w.events).toContain("t0:lock:/uploads/a.png"));
    w.refs.add("/uploads/a.png"); // a non-participating writer commits its reference WITHOUT the lock, after the deleter locked
    // the deleter's scan runs now. A real database would show the row to the scan only if committed before the statement began; here the
    // writer committed during the pause and the scan is the next statement, so it would see it: model the true window instead:
    w.refs.delete("/uploads/a.png"); // the writer commits AFTER the scan, before the deleter's commit
    hold.release();
    const out = await deleting;
    w.refs.add("/uploads/a.png"); // now the unlocked writer's commit lands
    expect(out).toEqual(["/uploads/a.png"]);
    expect(w.rows.has("/uploads/a.png")).toBe(false); // the row is gone ...
    expect(w.refs.has("/uploads/a.png")).toBe(true); // ... and a post references it: LOST. Only a writer that takes the lock is protected.
  });
});
