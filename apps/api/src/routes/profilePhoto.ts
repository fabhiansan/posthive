// The person's own photo on My Profile: Change photo and Remove. The picture is read by sharp (what the bytes really are,
// not what the file is called), cropped square, shrunk to 400 x 400 and stored as WebP in the `avatars` folder.
// Every query is scoped to the signed-in user, never to an id the browser sends.
import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { getUser, withAuth } from "../lib/auth/withAuth.js";
import type { StorageAdapter } from "../lib/storage.js";

/** The page says "up to 5 MB" and "at least 400 x 400 px"; these are the same numbers. */
export const PHOTO_MAX_BYTES = 5_000_000;
export const PHOTO_MIN_SIDE = 400;
export const PHOTO_SIDE = 400;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const FOLDER = "avatars";

const refuse = (code: string, error: string) => ({ error, code });

/** What the browser is shown for the person: the same fields as PATCH /user/profile. */
const userBody = (u: { id: string; email: string; name: string; avatarUrl: string | null; timezone: string }) => ({
  id: u.id, email: u.email, name: u.name, avatarUrl: u.avatarUrl, timezone: u.timezone,
});

const apiBase = () => process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
/** The web draws avatarUrl as it is (not through assetUrl), so a path on local disk is saved as a full address. */
const publicUrl = (stored: string) => (stored.startsWith("http") ? stored : `${apiBase()}${stored}`);
/** The inverse: the address the storage hands out again, to delete the file. */
const storedPath = (url: string) => (url.startsWith(`${apiBase()}/uploads/`) ? url.slice(apiBase().length) : url);

/**
 * Only an address of exactly the shape this route makes is ever deleted: `.../avatars/<uuid>.webp` and nothing else. avatarUrl
 * is a plain column that other code paths fill (a Supabase user's metadata, a provider's picture), so it is not trusted: a value
 * with `..`, an encoded dot or a different file name could otherwise point the delete at another file.
 */
const PHOTO_SHAPE = /\/avatars\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.webp$/;
const PATH_TRICKS = /\.\.|%2e|%2f|%5c|\\/i;
export const isOurPhoto = (url: string): boolean => PHOTO_SHAPE.test(url) && !PATH_TRICKS.test(url);

export async function profilePhotoRoutes(app: FastifyInstance, { storage }: { storage: StorageAdapter }): Promise<void> {
  /**
   * Removes the person's previous photo from storage. Only a file of ours in `avatars` goes: a Google or LinkedIn
   * picture is somebody else's address, and a file the person did not upload here is not touched.
   */
  async function dropFile(url: string | null): Promise<void> {
    if (!url || !isOurPhoto(url)) return;
    const path = storedPath(url);
    if (!storage.ownsUrl(path)) return;
    try {
      await storage.delete(path);
    } catch {
      // best effort: a file that is already gone is not a reason to fail the request
    }
  }

  app.post("/user/avatar", { preHandler: [withAuth], config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const file = await req.file({ limits: { fileSize: PHOTO_MAX_BYTES, files: 1 } });
    if (!file) return reply.status(400).send(refuse("NO_FILE", "Choose a picture to upload."));
    if (!PHOTO_TYPES.has(file.mimetype)) return reply.status(400).send(refuse("BAD_TYPE", "That file isn't a JPG, PNG or WebP picture."));

    // multipart stops reading at the limit and throws; the person is told the size, not "internal error"
    let raw: Buffer;
    try {
      raw = await file.toBuffer();
    } catch {
      return reply.status(413).send(refuse("TOO_BIG", "The picture is larger than 5 MB."));
    }

    // lazy-load sharp: libvips only loads on the first real upload
    const sharp = (await import("sharp")).default;
    let cropped: Buffer;
    try {
      const image = sharp(raw, { limitInputPixels: 100_000_000 });
      const meta = await image.metadata();
      if (!meta.format || !["jpeg", "png", "webp"].includes(meta.format)) {
        return reply.status(400).send(refuse("BAD_TYPE", "That file isn't a JPG, PNG or WebP picture."));
      }
      if ((meta.width ?? 0) < PHOTO_MIN_SIDE || (meta.height ?? 0) < PHOTO_MIN_SIDE) {
        return reply.status(400).send(refuse("TOO_SMALL", `The picture is smaller than ${PHOTO_MIN_SIDE} × ${PHOTO_MIN_SIDE} px. Use a bigger one.`));
      }
      // .rotate() applies the camera's orientation before the crop, so a phone photo is not turned on its side
      cropped = await image.rotate().resize(PHOTO_SIDE, PHOTO_SIDE, { fit: "cover", position: "attention" }).webp({ quality: 85 }).toBuffer();
    } catch {
      return reply.status(400).send(refuse("BAD_IMAGE", "We couldn't read that picture. Try a different file."));
    }

    const before = await prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } });
    const url = publicUrl(await storage.upload(cropped, "image/webp", FOLDER));
    const updated = await prisma.user.update({ where: { id: userId }, data: { avatarUrl: url } });
    await dropFile(before?.avatarUrl ?? null);
    return reply.send({ user: userBody(updated) });
  });

  app.delete("/user/avatar", { preHandler: [withAuth], config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const before = await prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } });
    const updated = await prisma.user.update({ where: { id: userId }, data: { avatarUrl: null } });
    await dropFile(before?.avatarUrl ?? null);
    return reply.send({ user: userBody(updated) });
  });
}
