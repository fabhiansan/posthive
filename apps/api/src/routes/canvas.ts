import type { FastifyInstance, FastifyReply } from "fastify";
import type { Prisma } from "@prisma/client";
import { getUser, getWorkspaceId } from "../lib/auth/withAuth.js";
// `withAuth` here is the gated one: the same authentication, plus the Canvas auth gate's outcome recording (lib/canvasAuthGate.ts).
import { canvasWithAuth as withAuth, registerCanvasAuthGate, type CanvasAuthGate } from "../lib/canvasAuthGate.js";
import { prisma } from "../lib/prisma.js";
import type { StorageAdapter } from "../lib/storage.js";
import { AssetRejected, CANVAS_PRIVATE_DIR, MAX_ASSET_BYTES, isPrivateAssetStorage, processAsset } from "../lib/canvasAssets.js";
import {
  BLANK_DOCUMENT,
  DEFAULT_DESIGN_NAME,
  EMPTY_OVERRIDES,
  LIMITS,
  RevisionUnreadable,
  attachBody,
  buildManifest,
  canvasDocument,
  createBody,
  createForTemplateBody,
  createInstanceBody,
  decodeCursor,
  designName,
  documentAssetIds,
  encodeCursor,
  firstIssue,
  hiddenMessage,
  parseLimit,
  publishBody,
  readOverrides,
  sameOverrides,
  saveBody,
  saveInstanceBody,
  validateOverrides,
  type CanvasDocumentJson,
  type OverrideEntry,
} from "../lib/canvas.js";
import { SOURCE_SELECT, hasFigmaSource, hasUsableSource, lockTemplate, sourceOf } from "../lib/templates.js";
import { ARCHIVED, INSTANCE, KIND, YOURS, contentEditorOnly, designerOnly, errorCode, invalidBody, isRefusal, jsonOnly, lockInstance, notFound, refuse, wellFormedId } from "../lib/canvasHttp.js";
import { reviewSummary } from "../lib/canvasReview.js";
import { latestForInstances, latestSubmission } from "../lib/canvasReviewDb.js";
import { userLimit } from "../lib/userRateLimit.js";
import { canvasReviewRoutes } from "./canvasReview.js";
import { canvasDesignRoutes } from "./canvasDesigns.js";

const STORAGE_UNSUPPORTED = {
  error: "Canvas image assets need local storage (STORAGE_PROVIDER=local). R2 and Supabase private storage is not supported yet.",
  code: "CANVAS_STORAGE_UNSUPPORTED",
} as const;

const DESIGN_LIST_MAX = 200;

// A design as the editor and the designer's list read it (never the document, except GET one): which template it is
// attached to, and its latest published revision, so the page can say whether Marketing could use it.
const SUMMARY = {
  id: true,
  name: true,
  version: true,
  updatedAt: true,
  template: { select: { id: true, category: true, published: true } },
  // shortcut: Prisma applies this nested take in memory, so it reads the number, version and date of every revision of the
  // listed designs (never their documents). Fine for a few revisions each; switch to a grouped query when designs have thousands.
  revisions: { orderBy: { number: "desc" }, take: 1, select: { number: true, designVersion: true, createdAt: true } },
} as const;
const withLatestRevision = <T extends { revisions: unknown[] }>({ revisions, ...design }: T) => ({ ...design, latestRevision: revisions[0] ?? null });

const json = (doc: CanvasDocumentJson) => doc as unknown as Prisma.InputJsonObject;
const overridesJson = (fields: OverrideEntry[]) => ({ ...EMPTY_OVERRIDES, fields }) as unknown as Prisma.InputJsonObject;

// A design in "My designs": no document and no overrides, which are only read when one is opened.
const INSTANCE_SUMMARY = { id: true, name: true, version: true, createdAt: true, updatedAt: true, archivedAt: true, overrides: true, baseRevision: { select: { number: true } } } as const;

const DESIGN_LINKED = refuse(409, "This design is already attached to a template.", "DESIGN_LINKED");

/** Locks one design's row until the transaction ends. Lock order everywhere: the template first, then the design. */
async function lockDesign(tx: Prisma.TransactionClient, id: string, workspaceId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Design" WHERE "id" = ${id} AND "workspaceId" = ${workspaceId} AND "kind" = ${KIND} FOR UPDATE`;
  return rows.length > 0;
}

/** Thrown inside a transaction to roll it back when the template changed under it; answered as a 409 outside. */
class TemplateChanged extends Error {}

/**
 * Rate limits, all Canvas routes: every route carries `userLimit` (one allowance per person per workspace, decided by the server
 * after authentication, never by a header or a token). What happens BEFORE authentication is the auth gate's job: it runs as
 * scope hooks registered here, so it covers every route of this plugin (and the review routes, registered below on the same app).
 * `gate: false` turns it off for a test that mocks authentication; production passes nothing and gets the default gate.
 */
export async function canvasRoutes(app: FastifyInstance, { storage, gate }: { storage: StorageAdapter; gate?: CanvasAuthGate | false }): Promise<void> {
  if (gate !== false) registerCanvasAuthGate(app, gate);
  const local = isPrivateAssetStorage(storage);
  if (!local) app.log.warn("Canvas image assets are disabled: they need STORAGE_PROVIDER=local (private delivery is only built for local disk).");

  // Fail closed, before auth or storage is touched: on any other provider the files could be public.
  const needsLocalStorage = async (_req: unknown, reply: FastifyReply) => {
    if (!local) return reply.status(501).send(STORAGE_UNSUPPORTED);
  };

  // Any workspace member may import: Marketing replaces images and Designers build with them.
  app.post(
    "/canvas/assets",
    { preHandler: [needsLocalStorage, withAuth], config: userLimit(30) },
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
    { preHandler: [needsLocalStorage, withAuth, wellFormedId("Asset")], config: userLimit(300) },
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
  // (designerOnly, notFound, jsonOnly and wellFormedId are in lib/canvasHttp.ts, shared with the review routes.) Creating
  // takes a JSON object: only `{}` (no name) means "Untitled design".

  app.get("/canvas/designs", { preHandler: [withAuth, designerOnly], config: userLimit(120) }, async (req, reply) => {
    // shortcut: the newest 200 designs, no paging (the page says when it shows that many); add paging when a workspace gets there.
    const designs = await prisma.design.findMany({
      where: { workspaceId: getWorkspaceId(req), kind: KIND },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: DESIGN_LIST_MAX,
      select: SUMMARY,
    });
    return reply.header("Cache-Control", "no-store").send({ designs: designs.map(withLatestRevision) });
  });

  app.post("/canvas/designs", { preHandler: [withAuth, designerOnly, jsonOnly], config: userLimit(30) }, async (req, reply) => {
    const parsed = createBody.safeParse(req.body); // no `?? {}`: a missing or null body is refused, not defaulted
    if (!parsed.success) return reply.status(400).send(invalidBody(parsed.error));
    const design = await prisma.design.create({
      data: { workspaceId: getWorkspaceId(req), kind: KIND, name: parsed.data.name ?? DEFAULT_DESIGN_NAME, document: json(BLANK_DOCUMENT), createdByUserId: getUser(req).id },
      select: SUMMARY,
    });
    return reply.status(201).send({ design: withLatestRevision(design) });
  });

  app.get("/canvas/designs/:id", { preHandler: [withAuth, designerOnly, wellFormedId("Design")], config: userLimit(120) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const design = await prisma.design.findFirst({ where: { id, workspaceId: getWorkspaceId(req), kind: KIND }, select: { ...SUMMARY, document: true } });
    if (!design) return notFound(reply);
    return reply.header("Cache-Control", "no-store").send({ design: withLatestRevision(design) });
  });

  // Autosave. The body names the version it was based on; the write only happens while that is still the stored
  // one, in a single UPDATE ... WHERE version = ?, so two designers (or two tabs) can never overwrite each other.
  app.put("/canvas/designs/:id", { preHandler: [withAuth, designerOnly, wellFormedId("Design"), jsonOnly], config: userLimit(120) }, async (req, reply) => {
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

  // A design that a template is made from cannot be deleted: unlink it first (that is refused while it is the template's
  // only source). Neither can one that Marketing made designs from: each of those pins one of its revisions, which this
  // delete would take with it. An unlinked design nobody used goes with its revisions. The foreign keys are the backstop
  // for a link or an instance made in between.
  const inUse = (count: number) => refuse(409, `Marketing has made ${count} ${count === 1 ? "design" : "designs"} from this design's published revisions, so it cannot be deleted.`, "DESIGN_IN_USE");
  // Instances count even when archived (an archived design still pins its revision). If there are none, a submission that
  // pins one of its revisions still protects it: the database says the same through DesignSubmission_baseRevisionId_fkey.
  const pinned = async (id: string, workspaceId: string) =>
    (await prisma.design.count({ where: { workspaceId, kind: INSTANCE, baseRevision: { designId: id } } })) ||
    (await prisma.designSubmission.count({ where: { workspaceId, baseRevision: { designId: id } } }));
  app.delete("/canvas/designs/:id", { preHandler: [withAuth, designerOnly, wellFormedId("Design")], config: userLimit(30) }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };
    if (await prisma.template.findFirst({ where: { designId: id, workspaceId }, select: { id: true } })) return reply.status(DESIGN_LINKED.status).send(DESIGN_LINKED.body);
    const used = await pinned(id, workspaceId);
    if (used > 0) return reply.status(409).send(inUse(used).body);
    let count: number;
    try {
      ({ count } = await prisma.design.deleteMany({ where: { id, workspaceId, kind: KIND } }));
    } catch (err) {
      if (errorCode(err) === "P2003") {
        // A template linked it, or Marketing made a design from it, just now. The phase 4 answer stays the default; the
        // instance is named only when one is really there, as the checks above would have.
        const made = await pinned(id, workspaceId);
        return reply.status(409).send(made > 0 ? inUse(made).body : DESIGN_LINKED.body);
      }
      throw err;
    }
    if (count === 0) return notFound(reply);
    return reply.send({ ok: true }); // the images stay: there is no asset clean-up yet
  });

  // ── Publishing a revision (phase 4) ─────────────────────────────────────────
  // A revision is an immutable copy of the saved design plus the manifest of the layers Marketing may change. The body
  // names only the version the editor saved: the document, the manifest, the number and the author all come from the
  // server. Revisions are only ever inserted, so a new one can never overwrite an earlier one. It does not make
  // anything visible to Marketing: that is the template's own Publish.
  app.post(
    "/canvas/designs/:id/publish",
    { preHandler: [withAuth, designerOnly, wellFormedId("Design"), jsonOnly], config: userLimit(10) },
    async (req, reply) => {
      const workspaceId = getWorkspaceId(req);
      const userId = getUser(req).id;
      const { id } = req.params as { id: string };

      const parsed = publishBody.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send(invalidBody(parsed.error));

      let outcome;
      try {
        outcome = await prisma.$transaction(async (tx) => {
          // The design's row stays locked until the end: a second publish waits, and what is read below is what is stored.
          if (!(await lockDesign(tx, id, workspaceId))) return refuse(404, "Design not found");
          const design = await tx.design.findFirst({ where: { id, workspaceId, kind: KIND }, select: { version: true, document: true } });
          if (!design) return refuse(404, "Design not found");
          if (design.version !== parsed.data.version) return refuse(409, "This design changed since the editor last saved it. Wait for the save to finish and try again.", "VERSION_CONFLICT");

          // The stored document is checked again, like on every save, because it is what gets frozen.
          const stored = canvasDocument.safeParse(design.document);
          if (!stored.success) return refuse(400, `The saved design is not valid: ${firstIssue(stored.error).message}`, "INVALID_DOCUMENT");
          const assetIds = documentAssetIds(stored.data);
          if (assetIds.length > 0 && (await tx.designAsset.count({ where: { id: { in: assetIds }, workspaceId } })) !== assetIds.length) {
            return refuse(400, "An image in this design is not available in this workspace.", "UNKNOWN_ASSET");
          }

          const { manifest, hidden } = buildManifest(stored.data);
          if (hidden.length > 0) return refuse(400, hiddenMessage(hidden), "INVALID_PUBLISH");

          if (await tx.designRevision.findFirst({ where: { designId: id, designVersion: design.version }, select: { id: true } })) {
            return refuse(409, "Nothing changed since the last revision. Change the design first.", "NO_CHANGES");
          }
          const latest = await tx.designRevision.findFirst({ where: { designId: id }, orderBy: { number: "desc" }, select: { number: true } });
          const revision = await tx.designRevision.create({
            data: { designId: id, number: (latest?.number ?? 0) + 1, designVersion: design.version, document: design.document as Prisma.InputJsonValue, manifest: manifest as unknown as Prisma.InputJsonObject, createdByUserId: userId },
            select: { number: true, designVersion: true, createdAt: true },
          });
          return { revision };
        });
      } catch (err) {
        if (errorCode(err) === "P2002") return reply.status(409).send({ error: "Nothing changed since the last revision. Change the design first.", code: "NO_CHANGES" }); // the unique key is the backstop
        throw err;
      }
      if (isRefusal(outcome)) return reply.status(outcome.status).send(outcome.body);
      return reply.status(201).send(outcome);
    },
  );

  // ── Attaching a design to a template (phase 4) ──────────────────────────────
  // Template-first: the Master Template page creates or picks the design. Both rows are locked, the template first and
  // then the design, so two requests can never attach the same design to two templates. The unique index on
  // Template.designId stays as the database's own backstop.
  const CAN_STRAND = "This template is published and has no Figma link or Canvas revision yet. Publish a revision of the design first, or unpublish the template.";

  // "Create Canvas design" on the template page: the design is made and attached in ONE transaction, so a failure leaves
  // no unlinked design behind. A new design has no revision, so R4 applies to it exactly as to a design with none. The
  // body has no fields: the document is blank and the name is the template's category, both chosen here, never sent.
  app.post("/canvas/templates/:id/design", { preHandler: [withAuth, designerOnly, wellFormedId("Template"), jsonOnly], config: userLimit(30) }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const userId = getUser(req).id;
    const { id } = req.params as { id: string };
    const parsed = createForTemplateBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(invalidBody(parsed.error));

    // Thrown, never returned, once the design exists: a returned refusal would COMMIT the design that was just created. A throw rolls
    // it back, and the 409 is answered below, outside the transaction.
    let outcome;
    try {
      outcome = await prisma.$transaction(async (tx) => {
        if (!(await lockTemplate(tx, id, workspaceId))) return refuse(404, "Template not found");
        const template = await tx.template.findFirst({ where: { id, workspaceId }, select: { ...SOURCE_SELECT, category: true } });
        if (!template) return refuse(404, "Template not found");
        if (template.designId) return refuse(409, "This template already has a Canvas design. Remove it first to attach another.", "TEMPLATE_HAS_DESIGN");
        if (template.published && !hasUsableSource(sourceOf(template))) return refuse(409, CAN_STRAND, "DESIGN_NEEDS_REVISION");

        const name = designName.safeParse(template.category ?? "");
        const design = await tx.design.create({
          data: { workspaceId, kind: KIND, name: name.success ? name.data : DEFAULT_DESIGN_NAME, document: json(BLANK_DOCUMENT), createdByUserId: userId },
          select: { id: true, name: true, version: true },
        });
        // Where the link is written (guarded by `designId: null`); if it matches nothing the template changed under the lock's feet.
        const { count } = await tx.template.updateMany({ where: { id, workspaceId, designId: null }, data: { designId: design.id } });
        if (count === 0) throw new TemplateChanged();
        return { design };
      });
    } catch (err) {
      if (err instanceof TemplateChanged) return reply.status(409).send({ error: "This template was changed while its design was being created. Reload the page and try again.", code: "TEMPLATE_CHANGED" });
      throw err;
    }
    if (isRefusal(outcome)) return reply.status(outcome.status).send(outcome.body);
    return reply.status(201).send(outcome);
  });

  app.put("/canvas/templates/:id/design", { preHandler: [withAuth, designerOnly, wellFormedId("Template"), jsonOnly], config: userLimit(30) }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };
    const parsed = attachBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(invalidBody(parsed.error));
    const { designId } = parsed.data;

    let outcome;
    try {
      outcome = await prisma.$transaction(async (tx) => {
        if (!(await lockTemplate(tx, id, workspaceId))) return refuse(404, "Template not found");
        if (!(await lockDesign(tx, designId, workspaceId))) return refuse(404, "Design not found");
        const template = await tx.template.findFirst({ where: { id, workspaceId }, select: SOURCE_SELECT });
        if (!template) return refuse(404, "Template not found");
        if (template.designId) return refuse(409, "This template already has a Canvas design. Remove it first to attach another.", "TEMPLATE_HAS_DESIGN");
        // Checked again now that both locks are held: a request that linked this design a moment ago has committed.
        if (await tx.template.findFirst({ where: { designId }, select: { id: true } })) return DESIGN_LINKED;
        const revision = await tx.designRevision.findFirst({ where: { designId }, select: { id: true } });
        // R4: a published template with nothing to show must not become one that Marketing can no longer see.
        if (template.published && !hasUsableSource(sourceOf(template)) && !revision) return refuse(409, CAN_STRAND, "DESIGN_NEEDS_REVISION");
        const { count } = await tx.template.updateMany({ where: { id, workspaceId, designId: null }, data: { designId } });
        if (count === 0) return refuse(409, "This template already has a Canvas design. Remove it first to attach another.", "TEMPLATE_HAS_DESIGN");
        return { designId };
      });
    } catch (err) {
      if (errorCode(err) === "P2002") return reply.status(DESIGN_LINKED.status).send(DESIGN_LINKED.body); // two attaches raced past the locks: the unique index decided
      throw err;
    }
    if (isRefusal(outcome)) return reply.status(outcome.status).send(outcome.body);
    return reply.send(outcome);
  });

  // Detaching keeps the design and its revisions. A published template cannot lose the Canvas revision that is its only source.
  app.delete("/canvas/templates/:id/design", { preHandler: [withAuth, designerOnly, wellFormedId("Template")], config: userLimit(30) }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };
    const outcome = await prisma.$transaction(async (tx) => {
      if (!(await lockTemplate(tx, id, workspaceId))) return refuse(404, "Template not found");
      const template = await tx.template.findFirst({ where: { id, workspaceId }, select: SOURCE_SELECT });
      if (!template) return refuse(404, "Template not found");
      if (!template.designId) return refuse(404, "This template has no Canvas design.");
      // R2: it had a usable source (its revision) and, without a Figma link, would have none.
      if (template.published && hasUsableSource(sourceOf(template)) && !hasFigmaSource(template.linkUrl)) {
        return refuse(409, "This template is published and its Canvas design is its only source. Add a Figma link first, or unpublish the template.", "SOURCE_REQUIRED");
      }
      await tx.template.updateMany({ where: { id, workspaceId }, data: { designId: null } });
      return { ok: true as const };
    });
    if (isRefusal(outcome)) return reply.status(outcome.status).send(outcome.body);
    return reply.send(outcome);
  });

  // ── Marketing's designs: instances (phase 5) ────────────────────────────────
  // An instance is a Design row of kind "instance". It has no document: it pins ONE published revision (baseRevisionId,
  // chosen here, never by the client, and never changed) and stores only `overrides`, the text and images that revision's
  // manifest lets Marketing change. The base revision and its document are never copied or modified, and the effective
  // document (base + overrides) is composed in memory by the editor; nothing here ever stores it. Content editors only
  // (owner, admin, member): a designer makes templates, not designs from them. An instance is PERSONAL: every query names
  // its creator, so another person's instance, an admin's included, is a plain 404.
  //
  // Unpublishing a template is NOT a way to take back designs Marketing already made. Creating needs a template that is
  // Published right now; once an instance exists it is unaffected by anything the design team does to the template
  // afterwards (unpublish, detach, delete, a newer revision), because it pins an immutable revision.
  //
  // Phase 6: a design that has been submitted for review is never hard-deleted. Deleting it archives it instead (archivedAt),
  // and an archived design is frozen: edits, new submissions and the editor's own read answer 404 DESIGN_ARCHIVED. Its
  // submission history stays readable by its owner (routes/canvasReview.ts).
  const NO_REVISION = refuse(409, "This template has no published Canvas design to customize.", "NO_CANVAS_REVISION");

  // Customize a template. ONE transaction, with the same lock order as every other writer of a template (the Template row,
  // then its Design), so that it cannot race an unpublish: whichever takes the Template lock first wins, and the other
  // waits and then re-reads. Creation first: valid, the unpublish waits. Unpublish first: creation re-reads it as unpublished
  // (404). The revision is read while the Design is locked, and is the one the instance is created pinned to.
  app.post("/canvas/instances", { preHandler: [withAuth, contentEditorOnly, jsonOnly], config: userLimit(30) }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const userId = getUser(req).id;
    const parsed = createInstanceBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(invalidBody(parsed.error));
    const { templateId } = parsed.data;

    let outcome;
    try {
      outcome = await prisma.$transaction(async (tx) => {
        if (!(await lockTemplate(tx, templateId, workspaceId))) return refuse(404, "Template not found");
        // Read only now, under the lock: a Draft, and a template unpublished a moment ago, are the same 404.
        const template = await tx.template.findFirst({ where: { id: templateId, workspaceId, published: true, category: { not: null } }, select: { designId: true, category: true } });
        if (!template) return refuse(404, "Template not found");
        if (!template.designId) return NO_REVISION; // a Figma-only or legacy template, or one whose design was just detached
        if (!(await lockDesign(tx, template.designId, workspaceId))) return NO_REVISION;
        const revision = await tx.designRevision.findFirst({ where: { designId: template.designId }, orderBy: { number: "desc" }, select: { id: true, number: true, createdAt: true } });
        if (!revision) return NO_REVISION;

        const name = designName.safeParse(template.category ?? "");
        const instance = await tx.design.create({
          data: { workspaceId, kind: INSTANCE, name: name.success ? name.data : DEFAULT_DESIGN_NAME, overrides: overridesJson([]), baseRevisionId: revision.id, createdByUserId: userId },
          select: { id: true, name: true, version: true, createdAt: true },
        });
        return { instance: { ...instance, baseRevision: { number: revision.number, createdAt: revision.createdAt } } };
      });
    } catch (err) {
      if (errorCode(err) === "P2003") return reply.status(NO_REVISION.status).send(NO_REVISION.body); // the revision's design went away in between
      throw err;
    }
    if (isRefusal(outcome)) return reply.status(outcome.status).send(outcome.body);
    return reply.status(201).send(outcome);
  });

  // My designs, newest first by CREATION time (an autosave changes updatedAt, so that could not be a stable order).
  app.get("/canvas/instances", { preHandler: [withAuth, contentEditorOnly], config: userLimit(120) }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const userId = getUser(req).id;
    const { limit: rawLimit, cursor: rawCursor, archived: rawArchived } = req.query as { limit?: unknown; cursor?: unknown; archived?: unknown };
    const limit = parseLimit(rawLimit);
    if (limit === null) return reply.status(400).send({ error: `limit must be a whole number from 1 to 100`, code: "INVALID_LIMIT" });
    const boundary = rawCursor === undefined ? null : decodeCursor(rawCursor);
    if (rawCursor !== undefined && boundary === null) return reply.status(400).send({ error: "cursor is not valid. Start again from the first page.", code: "INVALID_CURSOR" });
    // Active designs by default; ?archived=1 lists the archived ones (their history stays readable).
    if (rawArchived !== undefined && rawArchived !== "0" && rawArchived !== "1") return reply.status(400).send({ error: "archived must be 0 or 1", code: "INVALID_ARCHIVED" });

    const mine = { workspaceId, kind: INSTANCE, createdByUserId: userId, archivedAt: rawArchived === "1" ? { not: null } : null };
    const after = boundary ? new Date(boundary.t) : null;
    const rows = await prisma.design.findMany({
      where: boundary && after ? { AND: [mine, { OR: [{ createdAt: { lt: after } }, { createdAt: after, id: { lt: boundary.i } }] }] } : mine,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1, // one more than the page, only to know whether there is a next one
      select: INSTANCE_SUMMARY,
    });
    const page = rows.slice(0, limit);
    // From the last row actually returned, never from the extra one: the next page starts strictly after it.
    const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;
    // Each design's review state: the newest submission of the whole page in one query. The overrides were read only to compare
    // them with it, and are not sent. shortcut: a page reads up to 100 override sets; the version check skips the comparison
    // for a design saved since nothing, and a damaged set reads as empty here (it fails closed where it is written).
    const latest = await latestForInstances(page.map((i) => i.id));
    const instances = page.map(({ overrides, ...i }) => ({ ...i, review: reviewSummary(latest.get(i.id) ?? null, { version: i.version, name: i.name, overrides: readOverrides(overrides) ?? [] }) }));
    return reply.header("Cache-Control", "no-store").send({ instances, nextCursor });
  });

  // One of mine, ready to draw: its overrides, and the base revision's document and manifest.
  app.get("/canvas/instances/:id", { preHandler: [withAuth, contentEditorOnly, wellFormedId("Design")], config: userLimit(120) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await prisma.design.findFirst({
      where: YOURS(id, getWorkspaceId(req), getUser(req).id),
      select: { id: true, name: true, version: true, createdAt: true, updatedAt: true, archivedAt: true, overrides: true, baseRevision: { select: { number: true, createdAt: true, document: true, manifest: true } } },
    });
    if (!row) return notFound(reply);
    // The editor never gets an archived design; its history is read through /canvas/instances/:id/submissions.
    if (row.archivedAt) return reply.status(ARCHIVED.status).send(ARCHIVED.body);
    const overrides = readOverrides(row.overrides);
    // The check constraint and the foreign key make both of these impossible; a row that has them is damaged, not missing.
    if (!row.baseRevision || !overrides) throw new Error(`Design ${id} is not a valid instance.`);
    const { baseRevision, archivedAt: _active, ...rest } = row;
    const latest = await latestSubmission(prisma, id);
    const review = reviewSummary(latest, { version: row.version, name: row.name, overrides });
    // What was last submitted, so the editor can tell at once (as the person types, before anything is saved) whether there is
    // more to submit. It is the person's own design: nothing here is the reviewer's or anyone else's.
    const submitted = latest ? { name: latest.name, overrides: readOverrides(latest.overrides) ?? [] } : null;
    return reply.header("Cache-Control", "no-store").send({
      instance: { ...rest, overrides, review, submitted, baseRevision: { number: baseRevision.number, createdAt: baseRevision.createdAt }, document: baseRevision.document, manifest: baseRevision.manifest },
    });
  });

  // Autosave of an instance. The body is the COMPLETE override set (not a patch): a field left out goes back to the base
  // revision's value. It is checked against the pinned revision's stored manifest and document, never against the client.
  app.put("/canvas/instances/:id", { preHandler: [withAuth, contentEditorOnly, wellFormedId("Design"), jsonOnly], config: userLimit(120) }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const userId = getUser(req).id;
    const { id } = req.params as { id: string };

    const parsed = saveInstanceBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(invalidBody(parsed.error));
    const { version, overrides, name } = parsed.data;

    // shortcut: each save reads the base revision's document (typically tens of KB, at most about 0.9 MB) by primary key.
    // Revisions are immutable, so a cache keyed by revision id would be exactly right if saves ever show up in profiling.
    const row = await prisma.design.findFirst({
      where: YOURS(id, workspaceId, userId),
      select: { version: true, name: true, overrides: true, archivedAt: true, baseRevision: { select: { document: true, manifest: true } } },
    });
    if (!row) return notFound(reply);
    if (row.archivedAt) return reply.status(ARCHIVED.status).send(ARCHIVED.body); // frozen: the database refuses the update too (Design_archived_frozen)
    const stored = readOverrides(row.overrides);
    if (!row.baseRevision || !stored) throw new Error(`Design ${id} is not a valid instance.`);

    let checked;
    try {
      checked = validateOverrides(row.baseRevision, overrides);
    } catch (err) {
      if (err instanceof RevisionUnreadable) throw new Error(`The revision behind design ${id} cannot be read: ${err.message}`); // fails closed: nothing is written
      throw err;
    }
    if (!checked.ok) return reply.status(400).send({ error: checked.error, code: checked.code });

    if (row.version !== version) return reply.status(409).send({ error: "This design was changed somewhere else.", code: "VERSION_CONFLICT" });
    // Nothing to write: the same set (already normalized and checked when it was stored) under the same name. R3: no version bump.
    if (sameOverrides(checked.fields, stored) && (name === undefined || name === row.name)) return reply.send({ version });

    // Images: each one must be an asset of this workspace, like a designer's. Every image in the set is asked about, not only
    // the new ones: one query, and an image that was valid when it was stored is still valid.
    const assetIds = [...new Set(checked.fields.flatMap((f) => ("assetId" in f ? [f.assetId] : [])))];
    if (assetIds.length > 0 && (await prisma.designAsset.count({ where: { id: { in: assetIds }, workspaceId } })) !== assetIds.length) {
      return reply.status(400).send({ error: "An image in this design is not available in this workspace.", code: "UNKNOWN_ASSET" });
    }

    // Only overrides, the name and the version are ever written; the pinned revision, the kind, the owner and the dates never are.
    const { count } = await prisma.design.updateMany({
      where: { ...YOURS(id, workspaceId, userId), version, archivedAt: null }, // archived between the read and here: no row, not an edit
      data: { overrides: overridesJson(checked.fields), ...(name === undefined ? {} : { name }), version: { increment: 1 } },
    });
    if (count === 0) {
      const exists = await prisma.design.findFirst({ where: YOURS(id, workspaceId, userId), select: { archivedAt: true } });
      if (!exists) return notFound(reply);
      if (exists.archivedAt) return reply.status(ARCHIVED.status).send(ARCHIVED.body);
      return reply.status(409).send({ error: "This design was changed somewhere else.", code: "VERSION_CONFLICT" });
    }
    return reply.send({ version: version + 1 });
  });

  // Deleting one of my designs. A design that was NEVER submitted is deleted for good. One that has at least one submission,
  // pending or decided, is ARCHIVED instead: it can no longer be edited or submitted, and its submissions and reviews stay
  // exactly as they were (the foreign key from DesignSubmission refuses the delete in the database too). ONE transaction that
  // takes the instance's row lock first, the lock submit takes, so a submission cannot appear between the count and the delete.
  // Asking again for an archived design answers the same: it is archived. 404 only for one that is not mine or is not there.
  app.delete("/canvas/instances/:id", { preHandler: [withAuth, contentEditorOnly, wellFormedId("Design")], config: userLimit(30) }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const userId = getUser(req).id;
    const { id } = req.params as { id: string };
    const attempt = () =>
      prisma.$transaction(async (tx) => {
        const locked = await lockInstance(tx, id, workspaceId, userId);
        if (!locked) return refuse(404, "Design not found");
        if (locked.archivedAt) return { ok: true as const, archived: true as const };
        if ((await tx.designSubmission.count({ where: { instanceId: id } })) === 0) {
          await tx.design.deleteMany({ where: YOURS(id, workspaceId, userId) });
          return { ok: true as const }; // the images stay: there is no asset clean-up yet
        }
        await tx.design.updateMany({ where: { ...YOURS(id, workspaceId, userId), archivedAt: null }, data: { archivedAt: new Date() } });
        return { ok: true as const, archived: true as const };
      });
    let outcome;
    try {
      outcome = await attempt();
    } catch (err) {
      if (errorCode(err) !== "P2003") throw err;
      outcome = await attempt(); // the foreign key refused the delete: a submission exists after all, so this time it archives
    }
    if (isRefusal(outcome)) return reply.status(outcome.status).send(outcome.body);
    return reply.send(outcome);
  });

  await canvasReviewRoutes(app);
  await canvasDesignRoutes(app, { storage });
}
