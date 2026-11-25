import type { FastifyInstance } from "fastify";
import { getUser, getWorkspaceId } from "../lib/auth/withAuth.js";
import { canvasWithAuth as withAuth } from "../lib/canvasAuthGate.js"; // the gated withAuth, see lib/canvasAuthGate.ts
import { prisma } from "../lib/prisma.js";
import type { StorageAdapter } from "../lib/storage.js";
import { parseLimit } from "../lib/canvas.js";
import { INSTANCE, contentEditorOnly, wellFormedId } from "../lib/canvasHttp.js";
import { DesignImageRejected, MAX_DESIGN_PNG_BYTES, approvedSubmission, checkDesignPng, cursorsAvailable, designFolder, readDesignPng, signCursor, verifyCursor } from "../lib/canvasDesigns.js";
import { userLimit } from "../lib/userRateLimit.js";
import { isPrivateAssetStorage } from "../lib/canvasAssets.js";

/**
 * Approved Canvas designs for Add Content (phase 7, T7). Marketing only (owner, admin, member), and only its OWN approved submissions in
 * the active workspace: the person and the workspace come from the session, never from the request. See lib/canvasDesigns.ts for what
 * is and is not established about the picture.
 */
const STORAGE_UNSUPPORTED = {
  error: "Approved design pictures need local storage (STORAGE_PROVIDER=local). R2 and Supabase storage is not supported yet.",
  code: "CANVAS_STORAGE_UNSUPPORTED",
} as const;

export async function canvasDesignRoutes(app: FastifyInstance, { storage }: { storage: StorageAdapter }): Promise<void> {
  // Every approved version of my designs (archived ones too), newest first, in pages. A draft, a pending review, "changes requested" and a
  // superseded submission are not approved and never appear. No document is sent.
  app.get("/canvas/approved", { preHandler: [withAuth, contentEditorOnly], config: userLimit(120) }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const userId = getUser(req).id;
    const { limit: rawLimit, cursor: rawCursor } = req.query as { limit?: unknown; cursor?: unknown };
    const limit = parseLimit(rawLimit);
    if (limit === null) return reply.status(400).send({ error: "limit must be a whole number from 1 to 100", code: "INVALID_LIMIT" });
    // No signing key, no list: an unsigned cursor is never issued instead
    if (!cursorsAvailable()) return reply.status(503).send({ error: "Approved designs are not available right now.", code: "CURSOR_UNAVAILABLE" });
    const boundary = rawCursor === undefined ? null : verifyCursor(rawCursor, workspaceId, userId);
    if (rawCursor !== undefined && !boundary) return reply.status(400).send({ error: "cursor is not valid. Start again from the first page.", code: "INVALID_CURSOR" });

    // The owner and the workspace are in EVERY query, whatever the cursor says (defence in depth behind the signature)
    const mine = { workspaceId, status: "approved", submission: { workspaceId, instance: { kind: INSTANCE, workspaceId, createdByUserId: userId } } };
    const after = boundary ? new Date(boundary.t) : null;
    const rows = await prisma.designReviewRequest.findMany({
      where: boundary && after ? { AND: [mine, { OR: [{ createdAt: { lt: after } }, { createdAt: after, id: { lt: boundary.i } }] }] } : mine,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: { id: true, createdAt: true, decidedAt: true, submission: { select: { id: true, number: true, name: true, instanceId: true, createdAt: true, instance: { select: { archivedAt: true } } } } },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return reply.header("Cache-Control", "no-store").send({
      designs: page.map((r) => ({
        submissionId: r.submission.id,
        instanceId: r.submission.instanceId,
        number: r.submission.number,
        name: r.submission.name,
        submittedAt: r.submission.createdAt,
        approvedAt: r.decidedAt,
        archived: r.submission.instance.archivedAt !== null,
      })),
      nextCursor: rows.length > limit && last ? signCursor(last, workspaceId, userId) : null,
    });
  });

  // The picture of one approved design of mine, stored UNCHANGED (a PNG, no re-encoding, no conversion). The shared POST /upload would turn
  // it into a JPEG or WebP and shrink it, so it could never be checked against the approved size. The file goes to the submission's own
  // folder and an Upload row of this person, so the post that attaches it holds it like any other picture (lib/mediaDelete.ts).
  app.post("/canvas/submissions/:id/image", { preHandler: [withAuth, contentEditorOnly, wellFormedId("Submission")], config: userLimit(10) }, async (req, reply) => {
    if (!isPrivateAssetStorage(storage)) return reply.status(501).send(STORAGE_UNSUPPORTED);
    const workspaceId = getWorkspaceId(req);
    const userId = getUser(req).id;
    const { id } = req.params as { id: string };
    const submission = await approvedSubmission(prisma, id, workspaceId, userId);
    if (!submission) return reply.status(404).send({ error: "Approved design not found" });

    // The app-wide multipart limit is 100 MB for videos and per-call limits do not lower it. Read the stream ourselves and stop at 10 MB,
    // before Buffer.concat can allocate the larger body. Only one file part is accepted; text fields are refused by the parser.
    let raw: Buffer | undefined;
    let fileCount = 0;
    try {
      for await (const file of req.files({ limits: { fields: 0 } })) {
        if (++fileCount > 1) {
          file.file.resume(); // drain the extra part; never buffer it
          return reply.status(400).send({ error: "Send exactly one PNG file." });
        }
        // Consume the file INSIDE the multipart iterator: asking for the next part before consuming this stream deadlocks.
        raw = await readDesignPng(file.file);
      }
    } catch (err) {
      if (err instanceof DesignImageRejected) return reply.status(413).send({ error: err.message, code: err.code });
      return reply.status(400).send({ error: "Send exactly one PNG file as the multipart field 'file'." });
    }
    if (!raw) return reply.status(400).send({ error: "No file uploaded. Send it as the multipart field 'file'." });
    try {
      checkDesignPng(raw, submission); // from the bytes, never from the file name or the content type
    } catch (err) {
      if (err instanceof DesignImageRejected) return reply.status(400).send({ error: err.message, code: err.code });
      throw err;
    }

    const url = await storage.upload(raw, "image/png", designFolder(id));
    try {
      await prisma.upload.create({ data: { url, userId } });
    } catch (err) {
      await storage.delete(url).catch(() => {}); // no row, so nothing would ever point at the file
      throw err;
    }
    return reply.status(201).send({ url, bytes: raw.length });
  });
}
