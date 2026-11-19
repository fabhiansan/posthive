// The person's own photo: Change photo and Remove on My Profile. Real multipart bodies, real sharp, a real folder on disk for
// the storage; only the database is replaced. The checks are on what the person ends up with: a square 400 x 400 picture
// that is really a picture, their old file gone, and nobody else's photo touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDiskStorage } from "../lib/storage.js";

type Row = { id: string; email: string; name: string; avatarUrl: string | null; timezone: string };
const h = vi.hoisted(() => ({ users: [] as Array<{ id: string; email: string; name: string; avatarUrl: string | null; timezone: string }>, userId: "me" }));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    user: {
      // a row is copied on the way out, as a database does: the route's "before" must not change when the row is updated
      findUnique: vi.fn(async (a: { where: { id: string } }) => {
        const u = h.users.find((x) => x.id === a.where.id);
        return u ? { ...u } : null;
      }),
      update: vi.fn(async (a: { where: { id: string }; data: Partial<Row> }) => {
        const u = h.users.find((x) => x.id === a.where.id)!;
        Object.assign(u, a.data);
        return { ...u };
      }),
    },
  },
}));
vi.mock("../lib/auth/withAuth.js", () => ({
  withAuth: async () => {},
  getUser: () => ({ id: h.userId }),
}));

import { isOurPhoto, profilePhotoRoutes } from "./profilePhoto.js";

let dir: string;
let app: FastifyInstance;

const picture = (w: number, h2: number, format: "png" | "jpeg" | "webp" = "png") =>
  sharp({ create: { width: w, height: h2, channels: 3, background: "#3366cc" } })[format]().toBuffer();

/** A multipart body with one file field, built by hand (as canvas.test.ts does) so the test needs no form-data package. */
function upload(file: Buffer, filename = "me.png", type = "image/png") {
  const boundary = "----avatartest";
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
  const payload = Buffer.concat([head, file, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { method: "POST" as const, url: "/user/avatar", payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

const filesIn = (folder: string) => {
  const d = path.join(dir, folder);
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};
const me = () => h.users.find((u) => u.id === "me")!;

/** The address the API is reached at: whatever the developer's .env says must not change what these tests expect. */
const BASE = "http://localhost:3001";

beforeAll(async () => {
  vi.stubEnv("PUBLIC_API_URL", BASE);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-routes-"));
  app = Fastify();
  await app.register(multipart);
  await app.register(profilePhotoRoutes, { storage: new LocalDiskStorage(dir) });
  await app.ready();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  h.userId = "me";
  h.users = [
    { id: "me", email: "me@x.co", name: "Me", avatarUrl: null, timezone: "UTC" },
    { id: "other", email: "other@x.co", name: "Other", avatarUrl: "http://localhost:3001/uploads/avatars/other-photo.webp", timezone: "UTC" },
  ];
  fs.rmSync(path.join(dir, "avatars"), { recursive: true, force: true });
});

describe("POST /user/avatar", () => {
  it("a good picture becomes a square 400 x 400 WebP, is saved as the person's photo, and the answer carries it", async () => {
    const res = await app.inject(upload(await picture(900, 600)));
    expect(res.statusCode).toBe(200);
    const url = res.json().user.avatarUrl as string;
    expect(url).toMatch(/^http:\/\/localhost:3001\/uploads\/avatars\/[0-9a-f-]+\.webp$/);
    expect(me().avatarUrl).toBe(url);
    const file = path.join(dir, "avatars", path.basename(url));
    const meta = await sharp(fs.readFileSync(file)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 400, 400]);
  });

  it("when the API is served under a path (PUBLIC_API_URL ends in /backend), the saved address keeps it and the old file is still found and deleted", async () => {
    vi.stubEnv("PUBLIC_API_URL", "https://posthive.example.com/backend");
    try {
      const first = (await app.inject(upload(await picture(500, 500)))).json().user.avatarUrl as string;
      expect(first).toMatch(/^https:\/\/posthive\.example\.com\/backend\/uploads\/avatars\/[0-9a-f-]+\.webp$/);
      expect(filesIn("avatars")).toHaveLength(1);
      await app.inject(upload(await picture(500, 500)));
      expect(filesIn("avatars")).toHaveLength(1); // the first file did not stay behind
      expect(filesIn("avatars")).not.toContain(path.basename(first));
    } finally {
      vi.stubEnv("PUBLIC_API_URL", BASE);
    }
  });

  it("the answer is the same shape as PATCH /user/profile, and never carries a password hash or anything else", async () => {
    const body = (await app.inject(upload(await picture(500, 500)))).json();
    expect(Object.keys(body.user).sort()).toEqual(["avatarUrl", "email", "id", "name", "timezone"]);
  });

  it("a new photo replaces the old one: the old file is deleted, and only one file is left", async () => {
    const first = (await app.inject(upload(await picture(500, 500)))).json().user.avatarUrl as string;
    const second = (await app.inject(upload(await picture(600, 600, "jpeg"), "b.jpg", "image/jpeg"))).json().user.avatarUrl as string;
    expect(second).not.toBe(first);
    expect(filesIn("avatars")).toEqual([path.basename(second)]);
  });

  it("a file that is not a JPG, PNG or WebP picture is refused by its type", async () => {
    const res = await app.inject(upload(Buffer.from("GIF89a"), "x.gif", "image/gif"));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "That file isn't a JPG, PNG or WebP picture.", code: "BAD_TYPE" });
    expect(me().avatarUrl).toBeNull();
  });

  it("a text file named like a picture is refused by what it holds, not by its name or its header", async () => {
    const res = await app.inject(upload(Buffer.from("this is not a picture, it is a note"), "me.png", "image/png"));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("BAD_IMAGE");
    expect(me().avatarUrl).toBeNull();
    expect(filesIn("avatars")).toEqual([]);
  });

  it("a real GIF sent as image/png is refused: the bytes are what count", async () => {
    const gif = await sharp({ create: { width: 500, height: 500, channels: 3, background: "#fff" } }).gif().toBuffer();
    const res = await app.inject(upload(gif, "me.png", "image/png"));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("BAD_TYPE");
  });

  it("a picture under 400 x 400 is refused with the size the page promises", async () => {
    const res = await app.inject(upload(await picture(399, 800)));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "The picture is smaller than 400 × 400 px. Use a bigger one.", code: "TOO_SMALL" });
    const exact = await app.inject(upload(await picture(400, 400)));
    expect(exact.statusCode).toBe(200); // exactly 400 x 400 is enough
  });

  it("a file over 5 MB is refused before it is read as a picture", async () => {
    const res = await app.inject(upload(Buffer.alloc(5_000_001, 1)));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "The picture is larger than 5 MB.", code: "TOO_BIG" });
    expect(me().avatarUrl).toBeNull();
  });

  it("no file at all says what to do", async () => {
    const res = await app.inject({ method: "POST", url: "/user/avatar", payload: "", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
  });

  it("uploading never touches another person's photo or file", async () => {
    await app.inject(upload(await picture(500, 500)));
    expect(h.users.find((u) => u.id === "other")!.avatarUrl).toBe("http://localhost:3001/uploads/avatars/other-photo.webp");
  });

  it("a Google or LinkedIn picture that was the photo is replaced without trying to delete somebody else's address", async () => {
    me().avatarUrl = "https://lh3.googleusercontent.com/a/photo=s96-c";
    const res = await app.inject(upload(await picture(500, 500)));
    expect(res.statusCode).toBe(200);
    expect(me().avatarUrl).toMatch(/\/uploads\/avatars\//);
  });
});

describe("DELETE /user/avatar", () => {
  it("removes the photo and its file, and says so with the person", async () => {
    await app.inject(upload(await picture(500, 500)));
    expect(filesIn("avatars")).toHaveLength(1);
    const res = await app.inject({ method: "DELETE", url: "/user/avatar" });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.avatarUrl).toBeNull();
    expect(me().avatarUrl).toBeNull();
    expect(filesIn("avatars")).toEqual([]);
  });

  it("removing when there is no photo is fine, not an error", async () => {
    const res = await app.inject({ method: "DELETE", url: "/user/avatar" });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.avatarUrl).toBeNull();
  });

  it("a photo that is a Google address is cleared from the profile and nothing is deleted from storage", async () => {
    me().avatarUrl = "https://lh3.googleusercontent.com/a/photo=s96-c";
    const res = await app.inject({ method: "DELETE", url: "/user/avatar" });
    expect(res.json().user.avatarUrl).toBeNull();
  });

  it("only the signed-in person's own photo is removed", async () => {
    await app.inject({ method: "DELETE", url: "/user/avatar" });
    expect(h.users.find((u) => u.id === "other")!.avatarUrl).toMatch(/other-photo/);
  });
});

// avatarUrl is a plain column that other code fills (a Supabase user's metadata, a provider's picture). The delete on Remove and on a
// new upload must therefore only ever touch a file of exactly the shape this route makes.
describe("which addresses are ever deleted", () => {
  const UUID = "9d3c7d03-d7bb-45fe-afe8-662ad1be90e3";

  it.each([
    [`http://localhost:3001/uploads/avatars/${UUID}.webp`],
    [`https://posthive.example.com/backend/uploads/avatars/${UUID}.webp`],
    [`https://pub-abc.r2.dev/avatars/${UUID}.webp`],
    [`https://x.supabase.co/storage/v1/object/public/media/avatars/${UUID}.webp`],
  ])("%s is ours", (url) => expect(isOurPhoto(url)).toBe(true));

  it.each([
    ["a path that climbs out of the folder", `/uploads/avatars/../../.env`],
    ["a climb with a real uuid at the end", `/uploads/avatars/../../../avatars/${UUID}.webp`],
    ["an encoded dot", `/uploads/avatars/%2e%2e/%2e%2e/secret.webp`],
    ["an encoded slash", `/uploads/avatars%2f..%2fsecret/${UUID}.webp`],
    ["a backslash", `/uploads/avatars\\${UUID}.webp`],
    ["another folder", `/uploads/profile-pics/${UUID}.webp`],
    ["a file that is not a uuid", `/uploads/avatars/secret.webp`],
    ["another extension", `/uploads/avatars/${UUID}.png`],
    ["a template file", `/uploads/templates/${UUID}/design.fig`],
    ["a Google picture", `https://lh3.googleusercontent.com/a/photo=s96-c`],
    ["nothing", ``],
  ])("%s is NOT ours: %s", (_why, url) => expect(isOurPhoto(url)).toBe(false));

  it("Remove does not delete a file when avatarUrl was filled with a traversal path by something else", async () => {
    fs.mkdirSync(path.join(dir, "keep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "keep", "important.txt"), "do not delete");
    me().avatarUrl = "http://localhost:3001/uploads/avatars/../keep/important.txt";
    const res = await app.inject({ method: "DELETE", url: "/user/avatar" });
    expect(res.statusCode).toBe(200);
    expect(me().avatarUrl).toBeNull(); // the column is cleared...
    expect(fs.existsSync(path.join(dir, "keep", "important.txt"))).toBe(true); // ...and the file outside is untouched
  });

  it("a new upload does not delete a file when the old avatarUrl is a traversal path", async () => {
    fs.mkdirSync(path.join(dir, "keep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "keep", "important.txt"), "do not delete");
    me().avatarUrl = "http://localhost:3001/uploads/avatars/../keep/important.txt";
    const res = await app.inject(upload(await picture(500, 500)));
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(dir, "keep", "important.txt"))).toBe(true);
  });
});
