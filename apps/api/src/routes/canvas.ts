import type { FastifyInstance, FastifyReply } from "fastify";
import { withAuth, getUser, getWorkspaceId } from "../lib/auth/withAuth.js";
import { prisma } from "../lib/prisma.js";
import type { StorageAdapter } from "../lib/storage.js";
import { AssetRejected, CANVAS_PRIVATE_DIR, MAX_ASSET_BYTES, isPrivateAssetStorage, processAsset } from "../lib/canvasAssets.js";

const STORAGE_UNSUPPORTED = {
  error: "Canvas image assets need local storage (STORAGE_PROVIDER=local). R2 and Supabase private storage is not supported yet.",
  code: "CANVAS_STORAGE_UNSUPPORTED",
} as const;

export async function canvasRoutes(app: FastifyInstance, { storage }: { storage: StorageAdapter }): Promise<void> {
  const local = isPrivateAssetStorage(storage);
  if (!local) app.log.warn("Canvas image assets are disabled: they need STORAGE_PROVIDER=local (private delivery is only built for local disk).");

  // Fail closed, before auth or storage is touched: on any other provider the files could be public.
  const needsLocalStorage = async (_req: unknown, reply: FastifyReply) => {
    if (!local) return reply.status(501).send(STORAGE_UNSUPPORTED);
  };

  // Any workspace member may import: Marketing replaces images and Designers build with them.
  app.post(
    "/canvas/assets",
    { preHandler: [needsLocalStorage, withAuth], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id: userId } = getUser(req);
      const workspaceId = getWorkspaceId(req);

      const file = await req.file({ limits: { fileSize: MAX_ASSET_BYTES, files: 1 } });
      if (!file) return reply.status(400).send({ error: "No file uploaded. Send it as the multipart field 'file'." });
      let raw: Buffer;
      try {
        raw = await file.toBuffer();
      } catch {
        return reply.status(413).send({ error: "The file is larger than 10 MB." });
      }

      let asset;
      try {
        asset = await processAsset(raw);
      } catch (err) {
        if (err instanceof AssetRejected) {
          if (err.cause) req.log.warn({ err: err.cause }, "canvas asset could not be processed"); // the user gets a plain message; the real reason goes here
          return reply.status(400).send({ error: err.message, code: "ASSET_REJECTED" });
        }
        throw err;
      }

      const storageRef = await storage.upload(asset.png, "image/png", `${CANVAS_PRIVATE_DIR}/${workspaceId}`);
      try {
        const row = await prisma.designAsset.create({
          data: { workspaceId, storageRef, width: asset.width, height: asset.height, bytes: asset.png.length, sourceFormat: asset.sourceFormat, createdByUserId: userId },
          select: { id: true, width: true, height: true },
        });
        // Fields are picked one by one, not spread: the private storage path must not depend on the query's select.
        // The url is API-relative: the browser resolves it against the API base, never the web origin.
        return reply.status(201).send({ id: row.id, width: row.width, height: row.height, url: `/canvas/assets/${row.id}/content` });
      } catch (err) {
        await storage.delete(storageRef).catch(() => {}); // no row, so nothing would ever point at the file
        throw err;
      }
    },
  );

  app.get(
    "/canvas/assets/:id/content",
    { preHandler: [needsLocalStorage, withAuth], config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const workspaceId = getWorkspaceId(req);
      const { id } = req.params as { id: string };

      const asset = await prisma.designAsset.findFirst({ where: { id, workspaceId }, select: { storageRef: true } });
      if (!asset) return reply.status(404).send({ error: "Asset not found" });

      let png: Buffer;
      try {
        png = await storage.getBuffer(asset.storageRef);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return reply.status(404).send({ error: "Asset not found" });
        throw err;
      }

      // No max-age, ETag or Last-Modified: immutable bytes are not immutable authorization. After a member
      // is removed the browser has nothing to reuse, so the next request is refused.
      return reply
        .header("Cache-Control", "private, no-store")
        .header("Content-Type", "image/png")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", "inline")
        .send(png);
    },
  );
}
