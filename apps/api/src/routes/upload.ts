import type { FastifyInstance } from "fastify";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_SIZE_BYTES,
  type StorageAdapter,
} from "../lib/storage.js";
import { withAuth, getUser } from "../lib/auth/withAuth.js";
import { compressForPlatform } from "../lib/compress.js";
import { prisma } from "../lib/prisma.js";
import { releaseMedia } from "../lib/mediaDelete.js";

const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/mov"];
const MAX_VIDEO_SIZE_BYTES = 100_000_000; // 100 MB (Instagram Reels limit)
// A PDF is a generated design (Path A, LinkedIn), never a publishable picture: it is stored as it is, not compressed.
const PDF_TYPE = "application/pdf";

export async function uploadRoutes(
  app: FastifyInstance,
  { storage }: { storage: StorageAdapter }
): Promise<void> {
  app.delete("/upload", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const { url } = req.body as { url?: string };
    if (!url || typeof url !== "string") {
      return reply.status(400).send({ error: "url is required" });
    }
    // Verify ownership before touching storage
    const record = await prisma.upload.findFirst({ where: { url, userId } });
    if (!record) return reply.status(404).send({ error: "Upload not found" });
    // Removed only when nothing uses it: a saved draft, a scheduled or published post, a duplicate, a Library item, a template (compose
    // calls this when the person removes a picture or leaves the page, so a file the draft they just saved holds must stay)
    try {
      await releaseMedia(storage, [url], [userId]);
    } catch {
      // Best-effort — don't fail if file is already gone
    }
    return reply.status(204).send();
  });

  app.post("/upload", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const data = await req.file();

    if (!data) {
      return reply.status(400).send({ error: "No file uploaded — send as multipart field 'file'" });
    }

    const isVideo = ALLOWED_VIDEO_TYPES.includes(data.mimetype);
    const isImage = ALLOWED_IMAGE_TYPES.includes(data.mimetype);
    const isPdf = data.mimetype === PDF_TYPE;
    // A generated design (Path A) is stored exactly as produced, so the file's extension and the format the draft
    // claims stay the same. It is not a validation bypass: the type and the 10 MB limit still apply, and sharp reads
    // the file to refuse one that is not the type it claims. Normal uploads still go through compression.
    const keepFormat = (req.query as { keep?: unknown } | undefined)?.keep === "1";

    if (!isImage && !isVideo && !isPdf) {
      return reply.status(400).send({
        error: `Unsupported file type: ${data.mimetype}. Allowed images: ${ALLOWED_IMAGE_TYPES.join(", ")}. Allowed videos: ${ALLOWED_VIDEO_TYPES.join(", ")}`,
      });
    }

    const raw = await data.toBuffer();

    if (isVideo) {
      if (raw.length > MAX_VIDEO_SIZE_BYTES) {
        return reply.status(400).send({
          error: `Video too large: ${(raw.length / 1_000_000).toFixed(0)} MB. Maximum is 100 MB.`,
        });
      }
      const url = await storage.upload(raw, data.mimetype);
      await prisma.upload.create({ data: { url, userId } });
      return reply.status(201).send({ url, type: "video", mimeType: data.mimetype });
    }

    // PDF path: a generated design (LinkedIn, Path A). Stored unchanged, never compressed: the PDF reader draws it.
    if (isPdf) {
      if (raw.length > MAX_IMAGE_SIZE_BYTES) {
        return reply.status(400).send({
          error: `File too large: ${(raw.length / 1_000_000).toFixed(2)} MB. Maximum is ${MAX_IMAGE_SIZE_BYTES / 1_000_000} MB.`,
        });
      }
      // The type is claimed by the client; the file itself must start with the PDF signature.
      if (raw.subarray(0, 5).toString("latin1") !== "%PDF-") {
        return reply.status(400).send({ error: "That file is not a PDF." });
      }
      const url = await storage.upload(raw, PDF_TYPE);
      await prisma.upload.create({ data: { url, userId } });
      return reply.status(201).send({ url, type: "pdf", mimeType: PDF_TYPE });
    }

    // Image path
    if (raw.length > MAX_IMAGE_SIZE_BYTES) {
      return reply.status(400).send({
        error: `File too large: ${(raw.length / 1_000_000).toFixed(2)} MB. Maximum is ${MAX_IMAGE_SIZE_BYTES / 1_000_000} MB.`,
      });
    }

    const keepMime = data.mimetype === "image/png" || data.mimetype === "image/jpeg";
    if (keepFormat && keepMime) {
      // The bytes are kept as they are (no re-encode), but the header must match the type the client claimed.
      const sharp = (await import("sharp")).default;
      const meta = await sharp(raw).metadata().catch(() => null);
      const expected = data.mimetype === "image/png" ? "png" : "jpeg";
      if (!meta || meta.format !== expected) {
        return reply.status(400).send({ error: `That file is not a ${expected.toUpperCase()} image.` });
      }
      const url = await storage.upload(raw, data.mimetype);
      await prisma.upload.create({ data: { url, userId } });
      return reply.status(201).send({ url, type: "image", mimeType: data.mimetype });
    }

    const { buffer, mimeType } = await compressForPlatform(raw, data.mimetype, "bluesky");
    const url = await storage.upload(buffer, mimeType);
    await prisma.upload.create({ data: { url, userId } });
    return reply.status(201).send({ url, type: "image", mimeType });
  });
}
