import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import type { ZodError } from "zod";
import { withAuth, getUser, getWorkspaceId, requireTemplateManagerRole } from "../lib/auth/withAuth.js";
import { prisma } from "../lib/prisma.js";
import type { StorageAdapter } from "../lib/storage.js";
import { AssetRejected, CANVAS_PRIVATE_DIR, MAX_ASSET_BYTES, isPrivateAssetStorage, processAsset } from "../lib/canvasAssets.js";
import { BLANK_DOCUMENT, DEFAULT_DESIGN_NAME, LIMITS, createBody, documentAssetIds, firstIssue, saveBody, type CanvasDocumentJson } from "../lib/canvas.js";

const STORAGE_UNSUPPORTED = {
  error: "Canvas image assets need local storage (STORAGE_PROVIDER=local). R2 and Supabase private storage is not supported yet.",
  code: "CANVAS_STORAGE_UNSUPPORTED",
} as const;

const KIND = "template"; // the designer's working copies; instances come with the Marketing phase
const SUMMARY = { id: true, name: true, version: true, updatedAt: true } as const; // a list never carries documents
const DESIGN_LIST_MAX = 200;

const json = (doc: CanvasDocumentJson) => doc as unknown as Prisma.InputJsonObject;

/** A body the schema refused: which part it was decides the code, so the editor can say what to fix. */
function invalidBody(error: ZodError) {
  const { field, message } = firstIssue(error);
  return { error: message, code: field === "document" ? "INVALID_DOCUMENT" : field === "name" ? "INVALID_NAME" : "INVALID_REQUEST" };
}

export async function canvasRoutes(app: FastifyInstance, { storage }: { storage: StorageAdapter }): Promise<void> {
  const local = isPrivateAssetStorage(storage);
  if (!local) app.log.warn("Canvas image assets are disabled: they need STORAGE_PROVIDER=local (private delivery is only built for local disk).");

  // Fail closed, before auth or storage is touched: on any other provider the files could be public.
  const needsLocalStorage = async (_req: unknown, reply: FastifyReply) => {
    if (!local) return reply.status(501).send(STORAGE_UNSUPPORTED);
  };

  // An id that is not shaped like an id cannot name anything, so it is the same 404 as an unknown one, and nothing is
  // queried. Without this a NUL in the path (/canvas/designs/a%00b, /canvas/assets/a%00b/content) reaches PostgreSQL,
  // which refuses it (error 22021), and the caller gets a 500. Always after the auth (and role) checks on purpose: a
  // stranger learns nothing about what an id looks like. Real ids (cuid, uuid) all match LIMITS.id.
  const wellFormedId = (what: "Design" | "Asset") => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!LIMITS.id.test((req.params as { id: string }).id)) return reply.status(404).send({ error: `${what} not found` });
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
    { preHandler: [needsLocalStorage, withAuth, wellFormedId("Asset")], config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
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

  // ── Designs (phase 3) ───────────────────────────────────────────────────────
  // The designer's saved working copies. Designer only. Every query names the workspace and the kind, so another
  // workspace's id is a 404, and nothing in a request decides the kind, the workspace or the author. They work on
  // every storage provider: only image *bytes* need local disk, and a document holds just asset ids.
  const designerOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    const forbidden = await requireTemplateManagerRole(getUser(req).id, getWorkspaceId(req));
    if (forbidden) return reply.status(403).send(forbidden);
  };
  const notFound = (reply: FastifyReply) => reply.status(404).send({ error: "Design not found" });

  // Creating takes a JSON object. A request with no body, a form or multipart post (no preflight, so a cross-site page
  // can send one) or a bare `null` must not quietly become a blank design: only `{}` (no name) means "Untitled design".
  const jsonOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return reply.status(415).send({ error: "Send this request as JSON (Content-Type: application/json).", code: "UNSUPPORTED_MEDIA_TYPE" });
  };

  app.get("/canvas/designs", { preHandler: [withAuth, designerOnly] }, async (req, reply) => {
    // shortcut: the newest 200 designs, no paging (the page says when it shows that many); add paging when a workspace gets there.
    const designs = await prisma.design.findMany({
      where: { workspaceId: getWorkspaceId(req), kind: KIND },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: DESIGN_LIST_MAX,
      select: SUMMARY,
    });
    return reply.header("Cache-Control", "no-store").send({ designs });
  });

  app.post("/canvas/designs", { preHandler: [withAuth, designerOnly, jsonOnly], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = createBody.safeParse(req.body); // no `?? {}`: a missing or null body is refused, not defaulted
    if (!parsed.success) return reply.status(400).send(invalidBody(parsed.error));
    const design = await prisma.design.create({
      data: { workspaceId: getWorkspaceId(req), kind: KIND, name: parsed.data.name ?? DEFAULT_DESIGN_NAME, document: json(BLANK_DOCUMENT), createdByUserId: getUser(req).id },
      select: SUMMARY,
    });
    return reply.status(201).send({ design });
  });

  app.get("/canvas/designs/:id", { preHandler: [withAuth, designerOnly, wellFormedId("Design")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const design = await prisma.design.findFirst({ where: { id, workspaceId: getWorkspaceId(req), kind: KIND }, select: { ...SUMMARY, document: true } });
    if (!design) return notFound(reply);
    return reply.header("Cache-Control", "no-store").send({ design });
  });

  // Autosave. The body names the version it was based on; the write only happens while that is still the stored
  // one, in a single UPDATE ... WHERE version = ?, so two designers (or two tabs) can never overwrite each other.
  app.put("/canvas/designs/:id", { preHandler: [withAuth, designerOnly, wellFormedId("Design")], config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };

    const parsed = saveBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(invalidBody(parsed.error));
    const { version, document, name } = parsed.data;

    // Every save, not only a publish: an image layer may only point at an asset of this workspace.
    const assetIds = documentAssetIds(document);
    if (assetIds.length > 0) {
      const owned = await prisma.designAsset.count({ where: { id: { in: assetIds }, workspaceId } });
      if (owned !== assetIds.length) return reply.status(400).send({ error: "An image in this design is not available in this workspace.", code: "UNKNOWN_ASSET" });
    }

    const { count } = await prisma.design.updateMany({
      where: { id, workspaceId, kind: KIND, version },
      data: { document: json(document), ...(name === undefined ? {} : { name }), version: { increment: 1 } },
    });
    if (count === 0) {
      const exists = await prisma.design.findFirst({ where: { id, workspaceId, kind: KIND }, select: { id: true } });
      if (!exists) return notFound(reply);
      return reply.status(409).send({ error: "This design was changed somewhere else.", code: "VERSION_CONFLICT" }); // the editor asks for the latest design itself
    }
    // The new version is known without reading it back: the UPDATE only matched the version that was sent. A
    // second read could return a later save by someone else, and the editor would then take it for its own.
    return reply.send({ version: version + 1 });
  });

  app.delete("/canvas/designs/:id", { preHandler: [withAuth, designerOnly, wellFormedId("Design")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { count } = await prisma.design.deleteMany({ where: { id, workspaceId: getWorkspaceId(req), kind: KIND } });
    if (count === 0) return notFound(reply);
    return reply.send({ ok: true }); // the images stay: there is no asset clean-up yet
  });
}
