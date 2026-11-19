import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import type { ZodError } from "zod";
import { withAuth, getUser, getWorkspaceId, requireContentEditorRole, requireTemplateManagerRole } from "../lib/auth/withAuth.js";
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

const STORAGE_UNSUPPORTED = {
  error: "Canvas image assets need local storage (STORAGE_PROVIDER=local). R2 and Supabase private storage is not supported yet.",
  code: "CANVAS_STORAGE_UNSUPPORTED",
} as const;

const KIND = "template"; // the designer's working copies
const INSTANCE = "instance"; // what Marketing makes from a published template (phase 5)
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
const INSTANCE_SUMMARY = { id: true, name: true, version: true, createdAt: true, updatedAt: true, baseRevision: { select: { number: true } } } as const;

/** The same refusal as a status and a body, so a transaction can hand it back and the route can send it after the transaction ends. */
type Refusal = { status: number; body: { error: string; code?: string } };
const refuse = (status: number, error: string, code?: string): Refusal => ({ status, body: code ? { error, code } : { error } });
const isRefusal = (x: unknown): x is Refusal => typeof x === "object" && x !== null && "status" in x && "body" in x;
const errorCode = (err: unknown): string | undefined => (typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined);

const DESIGN_LINKED = refuse(409, "This design is already attached to a template.", "DESIGN_LINKED");

/** Locks one design's row until the transaction ends. Lock order everywhere: the template first, then the design. */
async function lockDesign(tx: Prisma.TransactionClient, id: string, workspaceId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Design" WHERE "id" = ${id} AND "workspaceId" = ${workspaceId} AND "kind" = ${KIND} FOR UPDATE`;
  return rows.length > 0;
}

/** A body the schema refused: which part it was decides the code, so the editor can say what to fix. */
function invalidBody(error: ZodError) {
  const { field, message } = firstIssue(error);
  return { error: message, code: field === "document" ? "INVALID_DOCUMENT" : field === "name" ? "INVALID_NAME" : field === "overrides" ? "INVALID_OVERRIDES" : "INVALID_REQUEST" };
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
  const wellFormedId = (what: "Design" | "Asset" | "Template") => async (req: FastifyRequest, reply: FastifyReply) => {
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
    return reply.header("Cache-Control", "no-store").send({ designs: designs.map(withLatestRevision) });
  });

  app.post("/canvas/designs", { preHandler: [withAuth, designerOnly, jsonOnly], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = createBody.safeParse(req.body); // no `?? {}`: a missing or null body is refused, not defaulted
    if (!parsed.success) return reply.status(400).send(invalidBody(parsed.error));
    const design = await prisma.design.create({
      data: { workspaceId: getWorkspaceId(req), kind: KIND, name: parsed.data.name ?? DEFAULT_DESIGN_NAME, document: json(BLANK_DOCUMENT), createdByUserId: getUser(req).id },
      select: SUMMARY,
    });
    return reply.status(201).send({ design: withLatestRevision(design) });
  });

  app.get("/canvas/designs/:id", { preHandler: [withAuth, designerOnly, wellFormedId("Design")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const design = await prisma.design.findFirst({ where: { id, workspaceId: getWorkspaceId(req), kind: KIND }, select: { ...SUMMARY, document: true } });
    if (!design) return notFound(reply);
    return reply.header("Cache-Control", "no-store").send({ design: withLatestRevision(design) });
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

  // A design that a template is made from cannot be deleted: unlink it first (that is refused while it is the template's
  // only source). Neither can one that Marketing made designs from: each of those pins one of its revisions, which this
  // delete would take with it. An unlinked design nobody used goes with its revisions. The foreign keys are the backstop
  // for a link or an instance made in between.
  const inUse = (count: number) => refuse(409, `Marketing has made ${count} ${count === 1 ? "design" : "designs"} from this design's published revisions, so it cannot be deleted.`, "DESIGN_IN_USE");
  const pinned = (id: string, workspaceId: string) => prisma.design.count({ where: { workspaceId, kind: INSTANCE, baseRevision: { designId: id } } });
  app.delete("/canvas/designs/:id", { preHandler: [withAuth, designerOnly, wellFormedId("Design")] }, async (req, reply) => {
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
    { preHandler: [withAuth, designerOnly, wellFormedId("Design"), jsonOnly], config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
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
  app.post("/canvas/templates/:id/design", { preHandler: [withAuth, designerOnly, wellFormedId("Template"), jsonOnly], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const userId = getUser(req).id;
    const { id } = req.params as { id: string };
    const parsed = createForTemplateBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(invalidBody(parsed.error));

    const outcome = await prisma.$transaction(async (tx) => {
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
      // Where the link is written (guarded by `designId: null`); if this throws, the design above is rolled back with it.
      const { count } = await tx.template.updateMany({ where: { id, workspaceId, designId: null }, data: { designId: design.id } });
      if (count === 0) throw new Error("The template changed while its design was being created.");
      return { design };
    });
    if (isRefusal(outcome)) return reply.status(outcome.status).send(outcome.body);
    return reply.status(201).send(outcome);
  });

  app.put("/canvas/templates/:id/design", { preHandler: [withAuth, designerOnly, wellFormedId("Template"), jsonOnly], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
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
  app.delete("/canvas/templates/:id/design", { preHandler: [withAuth, designerOnly, wellFormedId("Template")] }, async (req, reply) => {
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
  const contentEditorOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    const forbidden = await requireContentEditorRole(getUser(req).id, getWorkspaceId(req));
    if (forbidden) return reply.status(403).send(forbidden);
  };
  const NO_REVISION = refuse(409, "This template has no published Canvas design to customize.", "NO_CANVAS_REVISION");
  const YOURS = (id: string, workspaceId: string, userId: string) => ({ id, workspaceId, kind: INSTANCE, createdByUserId: userId });

  // Customize a template. ONE transaction, with the same lock order as every other writer of a template (the Template row,
  // then its Design), so that it cannot race an unpublish: whichever takes the Template lock first wins, and the other
  // waits and then re-reads. Creation first: valid, the unpublish waits. Unpublish first: creation re-reads it as unpublished
  // (404). The revision is read while the Design is locked, and is the one the instance is created pinned to.
  app.post("/canvas/instances", { preHandler: [withAuth, contentEditorOnly, jsonOnly], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
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
  app.get("/canvas/instances", { preHandler: [withAuth, contentEditorOnly] }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const userId = getUser(req).id;
    const { limit: rawLimit, cursor: rawCursor } = req.query as { limit?: unknown; cursor?: unknown };
    const limit = parseLimit(rawLimit);
    if (limit === null) return reply.status(400).send({ error: `limit must be a whole number from 1 to 100`, code: "INVALID_LIMIT" });
    const boundary = rawCursor === undefined ? null : decodeCursor(rawCursor);
    if (rawCursor !== undefined && boundary === null) return reply.status(400).send({ error: "cursor is not valid. Start again from the first page.", code: "INVALID_CURSOR" });

    const mine = { workspaceId, kind: INSTANCE, createdByUserId: userId };
    const after = boundary ? new Date(boundary.t) : null;
    const rows = await prisma.design.findMany({
      where: boundary && after ? { AND: [mine, { OR: [{ createdAt: { lt: after } }, { createdAt: after, id: { lt: boundary.i } }] }] } : mine,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1, // one more than the page, only to know whether there is a next one
      select: INSTANCE_SUMMARY,
    });
    const instances = rows.slice(0, limit);
    // From the last row actually returned, never from the extra one: the next page starts strictly after it.
    const nextCursor = rows.length > limit ? encodeCursor(instances[instances.length - 1]) : null;
    return reply.header("Cache-Control", "no-store").send({ instances, nextCursor });
  });

  // One of mine, ready to draw: its overrides, and the base revision's document and manifest.
  app.get("/canvas/instances/:id", { preHandler: [withAuth, contentEditorOnly, wellFormedId("Design")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await prisma.design.findFirst({
      where: YOURS(id, getWorkspaceId(req), getUser(req).id),
      select: { id: true, name: true, version: true, createdAt: true, updatedAt: true, overrides: true, baseRevision: { select: { number: true, createdAt: true, document: true, manifest: true } } },
    });
    if (!row) return notFound(reply);
    const overrides = readOverrides(row.overrides);
    // The check constraint and the foreign key make both of these impossible; a row that has them is damaged, not missing.
    if (!row.baseRevision || !overrides) throw new Error(`Design ${id} is not a valid instance.`);
    const { baseRevision, ...rest } = row;
    return reply.header("Cache-Control", "no-store").send({
      instance: { ...rest, overrides, baseRevision: { number: baseRevision.number, createdAt: baseRevision.createdAt }, document: baseRevision.document, manifest: baseRevision.manifest },
    });
  });

  // Autosave of an instance. The body is the COMPLETE override set (not a patch): a field left out goes back to the base
  // revision's value. It is checked against the pinned revision's stored manifest and document, never against the client.
  app.put("/canvas/instances/:id", { preHandler: [withAuth, contentEditorOnly, wellFormedId("Design")], config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
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
      select: { version: true, name: true, overrides: true, baseRevision: { select: { document: true, manifest: true } } },
    });
    if (!row) return notFound(reply);
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
      where: { ...YOURS(id, workspaceId, userId), version },
      data: { overrides: overridesJson(checked.fields), ...(name === undefined ? {} : { name }), version: { increment: 1 } },
    });
    if (count === 0) {
      const exists = await prisma.design.findFirst({ where: YOURS(id, workspaceId, userId), select: { id: true } });
      if (!exists) return notFound(reply);
      return reply.status(409).send({ error: "This design was changed somewhere else.", code: "VERSION_CONFLICT" });
    }
    return reply.send({ version: version + 1 });
  });

  app.delete("/canvas/instances/:id", { preHandler: [withAuth, contentEditorOnly, wellFormedId("Design")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { count } = await prisma.design.deleteMany({ where: YOURS(id, getWorkspaceId(req), getUser(req).id) });
    if (count === 0) return notFound(reply);
    return reply.send({ ok: true }); // the images stay: there is no asset clean-up yet
  });
}
