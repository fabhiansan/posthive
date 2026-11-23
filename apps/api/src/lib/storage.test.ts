import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalDiskStorage, StorageKeyError } from "./storage.js";

// Real files in a temp folder outside the repo. "outside" is a sibling folder with a file that must never be read, written or removed.
let base: string;
let root: string;
let outside: string;
let storage: LocalDiskStorage;
let canLink = true;

const exists = (p: string) => access(p).then(() => true, () => false);

beforeAll(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "posthive-storage-"));
  root = path.join(base, "uploads");
  outside = path.join(base, "outside");
  await mkdir(path.join(root, "folder"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, "ok.png"), "inside");
  await writeFile(path.join(root, "folder", "deep.png"), "deep");
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await writeFile(path.join(base, "sibling.txt"), "sibling");
  try {
    await symlink(outside, path.join(root, "linkdir"), "junction"); // a junction needs no privilege on Windows
    await symlink(path.join(outside, "secret.txt"), path.join(root, "linkfile.png"), "file");
  } catch {
    canLink = false; // no permission to make links here: the symlink cases are skipped and reported below
  }
  storage = new LocalDiskStorage(root);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const HOSTILE = [
  "/uploads/../sibling.txt",
  "/uploads/folder/../../sibling.txt",
  "/uploads/..",
  "/uploads/./ok.png",
  "/uploads//ok.png",
  "/uploads/folder//deep.png",
  "/uploads/..\\sibling.txt",
  "/uploads/folder\\..\\..\\sibling.txt",
  "/uploads/C:/Windows/win.ini",
  "/uploads/ok.png:stream",
  "/uploads/ok.png\0.txt",
  "/uploads/",
  "/uploads",
  "/etc/passwd",
  "ok.png",
  "../sibling.txt",
  "",
];

describe("LocalDiskStorage: nothing leaves the uploads folder", () => {
  it("serves and removes normal keys, in the folder and in a sub folder", async () => {
    expect((await storage.getBuffer("/uploads/ok.png")).toString()).toBe("inside");
    expect((await storage.getBuffer("/uploads/folder/deep.png")).toString()).toBe("deep");
    const url = await storage.upload(Buffer.from("new"), "image/png");
    expect(url).toMatch(/^\/uploads\/[\w.-]+$/);
    expect((await storage.getBuffer(url)).toString()).toBe("new");
    await storage.delete(url);
    await expect(storage.getBuffer(url)).rejects.toMatchObject({ code: "ENOENT" });
    await storage.delete(url); // already gone is not an error
  });

  it.each(HOSTILE)("getBuffer refuses %j", async (url) => {
    await expect(storage.getBuffer(url)).rejects.toBeInstanceOf(StorageKeyError);
  });

  it.each(HOSTILE)("delete refuses %j and removes nothing", async (url) => {
    await expect(storage.delete(url)).rejects.toBeInstanceOf(StorageKeyError);
    expect(await exists(path.join(base, "sibling.txt"))).toBe(true);
    expect(await exists(path.join(outside, "secret.txt"))).toBe(true);
    expect(await exists(path.join(root, "ok.png"))).toBe(true);
  });

  it("listFolder refuses a folder that climbs out, and lists a real one", async () => {
    for (const f of ["..", "../outside", "folder/..", "", "a\\b", "/abs"]) {
      await expect(storage.listFolder(f), f).rejects.toBeInstanceOf(StorageKeyError);
    }
    expect(await storage.listFolder("folder")).toEqual(["/uploads/folder/deep.png"]);
  });

  it("upload refuses a folder or a file name that climbs out, and writes nothing outside", async () => {
    await expect(storage.upload(Buffer.from("x"), "image/png", "../outside", "pwn.png")).rejects.toBeInstanceOf(StorageKeyError);
    await expect(storage.upload(Buffer.from("x"), "image/png", "..", "pwn.png")).rejects.toBeInstanceOf(StorageKeyError);
    expect(await exists(path.join(outside, "pwn.png"))).toBe(false);
    expect(await exists(path.join(base, "pwn.png"))).toBe(false);
  });

  it("a key with percent signs is a plain file name, never decoded", async () => {
    await expect(storage.getBuffer("/uploads/%2e%2e/sibling.txt")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await exists(path.join(base, "sibling.txt"))).toBe(true);
  });

  it("works before the uploads folder exists (nothing stored yet)", async () => {
    const fresh = new LocalDiskStorage(path.join(base, "not-yet"));
    await expect(fresh.getBuffer("/uploads/a.png")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fresh.getBuffer("/uploads/../a.png")).rejects.toBeInstanceOf(StorageKeyError);
    expect(await fresh.listFolder("nothing")).toEqual([]);
  });

  it("ownsUrl is only the /uploads/ prefix", () => {
    expect(storage.ownsUrl("/uploads/a.png")).toBe(true);
    expect(storage.ownsUrl("/other/a.png")).toBe(false);
    expect(storage.ownsUrl("https://x/uploads/a.png")).toBe(false);
  });
});

describe("LocalDiskStorage: symbolic links", () => {
  it("a link to a folder outside cannot be read through, listed or deleted through", async (ctx) => {
    if (!canLink) return ctx.skip();
    await expect(storage.getBuffer("/uploads/linkdir/secret.txt")).rejects.toBeInstanceOf(StorageKeyError);
    await expect(storage.delete("/uploads/linkdir/secret.txt")).rejects.toBeInstanceOf(StorageKeyError);
    await expect(storage.listFolder("linkdir")).rejects.toBeInstanceOf(StorageKeyError);
    await expect(storage.upload(Buffer.from("x"), "image/png", "linkdir", "pwn.png")).rejects.toBeInstanceOf(StorageKeyError);
    expect(await exists(path.join(outside, "secret.txt"))).toBe(true);
    expect(await exists(path.join(outside, "pwn.png"))).toBe(false);
  });

  it("a link to a file outside cannot be read or deleted", async (ctx) => {
    if (!canLink) return ctx.skip();
    await expect(storage.getBuffer("/uploads/linkfile.png")).rejects.toBeInstanceOf(StorageKeyError);
    await expect(storage.delete("/uploads/linkfile.png")).rejects.toBeInstanceOf(StorageKeyError);
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("an uploads folder that is itself reached through a link still works (the real path is the root)", async (ctx) => {
    if (!canLink) return ctx.skip();
    const via = path.join(base, "via");
    await symlink(root, via, "junction");
    const s = new LocalDiskStorage(via);
    expect((await s.getBuffer("/uploads/ok.png")).toString()).toBe("inside");
    await expect(s.getBuffer("/uploads/../sibling.txt")).rejects.toBeInstanceOf(StorageKeyError);
  });
});
