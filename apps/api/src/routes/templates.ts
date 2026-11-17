import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { withAuth, withAuthOrToken, getUser, getWorkspaceId, getWorkspaceRole, requireTemplateManagerRole } from "../lib/auth/withAuth.js";
import { pillarFor } from "../lib/contentTypes.js";
import type { StorageAdapter } from "../lib/storage.js";
import { LIBRARY_SELECT, SOURCE_SELECT, hasCanvasSource, hasFigmaSource, hasUsableSource, isLibraryVisible, lockTemplate, sourceOf, toLibraryTemplate, withoutTemplateMedia } from "../lib/templates.js";
import { templateBody, type TemplateBody } from "../lib/templateBody.js";

function templateData(t: TemplateBody) {
  return {
    name: t.category,
    category: t.category,
    // Pillar is derived, never trusted from the client
    pillar: pillarFor(t.category),
    linkUrl: t.linkUrl,
    previewUrl: t.previewUrl,
    format: t.format,
    slides: t.slides,
    platforms: t.platforms,
  };
}

const statusBody = z.object({ published: z.boolean() });

const previewsOf = (t: { previewUrl: string | null }) => (t.previewUrl ? [t.previewUrl] : []);

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

const duplicate = (category: string) => ({ error: `A template for ${category} already exists. Edit that template instead.` });

// What Marketing can see depends on a template having something to show: a Figma link or a published Canvas revision.
// R1: a template is published only if it has one. R2: a published template that has one cannot lose its last one.
// A published template that already has none (the status migration published every row) is left as it is.
const INCOMPLETE = {
  error: "Add a Figma link or publish a Canvas revision of its design before publishing this template.",
  code: "TEMPLATE_INCOMPLETE",
} as const;
const SOURCE_REQUIRED = {
  error: "This template is published and this is its only source. Add a Figma link or publish a Canvas revision first, or unpublish the template.",
  code: "SOURCE_REQUIRED",
} as const;

export async function templateRoutes(
  app: FastifyInstance,
  { storage }: { storage: StorageAdapter },
): Promise<void> {

  // Files the caller just uploaded may be attached; anything else (another user's or
  // another workspace's file) may not — deleting the template would delete that file.
  async function ownsUploads(urls: string[], userId: string): Promise<boolean> {
    if (!urls.length) return true;
    const owned = await prisma.upload.count({ where: { url: { in: urls }, userId } });
    return owned === new Set(urls).size;
  }

  // Uploads unclaimed for 24h are deleted by the orphan cron (index.ts) — claim template files.
  async function claimUploads(urls: string[]): Promise<void> {
    if (urls.length) await prisma.upload.updateMany({ where: { url: { in: urls } }, data: { claimedAt: new Date() } });
  }

  // Remove files a template no longer uses. Legacy kit files stay (posts share them).
  async function removeFiles(urls: string[]): Promise<void> {
    const free = await withoutTemplateMedia(urls);
    if (!free.length) return;
    await Promise.allSettled(free.map((url) => storage.delete(url)));
    await prisma.upload.deleteMany({ where: { url: { in: free } } });
  }

  // List the workspace's design templates. The design team sees drafts too; every other role sees only what was
  // published, so a draft never reaches Compose, the drawer or the review dialog (they all read this list).
  // Rows without a category are legacy caption templates, removed by the cleanup migration.
  app.get("/templates", { preHandler: [withAuthOrToken] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const role = await getWorkspaceRole(userId, workspaceId);
    const templates = await prisma.template.findMany({
      where: { workspaceId, category: { not: null }, ...(role === "designer" ? {} : { published: true }) },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: LIBRARY_SELECT,
    });
    const library = templates.map(toLibraryTemplate);
    if (role === "designer") return reply.send({ templates: library });
    // Everyone else is told whether a template is made in Canvas (canvasRevision, for the card and the reference) but not
    // which design it is: no page of theirs uses the id, and every route that takes one is for the design team only.
    // The row is checked with its design id first, so it is only removed after the visibility rule has read it.
    return reply.send({ templates: library.filter(isLibraryVisible).map(({ designId, ...rest }) => rest) });
  });

  // Create a template — design team only (docs/role-access-matrix.md US-07). It starts as a draft.
  app.post("/templates", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);

    const forbidden = await requireTemplateManagerRole(userId, workspaceId);
    if (forbidden) return reply.status(403).send(forbidden);

    const parsed = templateBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid template" });
    const body = parsed.data;

    const existing = await prisma.template.findFirst({ where: { workspaceId, category: body.category }, select: { id: true } });
    if (existing) return reply.status(409).send(duplicate(body.category));

    const files = previewsOf(body);
    if (!(await ownsUploads(files, userId))) return reply.status(400).send({ error: "Upload the preview image again." });

    try {
      const template = await prisma.template.create({
        data: { userId, workspaceId, ...templateData(body) },
        select: LIBRARY_SELECT,
      });
      await claimUploads(files);
      return reply.status(201).send({ template: toLibraryTemplate(template) });
    } catch (err) {
      if (isUniqueViolation(err)) return reply.status(409).send(duplicate(body.category));
      throw err;
    }
  });

  // Replace a template (content type, link, preview); — design team only
  app.patch("/templates/:id", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };

    const forbidden = await requireTemplateManagerRole(userId, workspaceId);
    if (forbidden) return reply.status(403).send(forbidden);

    const parsed = templateBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid template" });
    const body = parsed.data;

    const current = await prisma.template.findFirst({
      where: { id, workspaceId },
      select: { id: true, category: true, previewUrl: true },
    });
    if (!current) return reply.status(404).send({ error: "Not found" });

    // Only a category change can create a duplicate (legacy duplicates are cleaned up separately)
    if (body.category !== current.category) {
      const clash = await prisma.template.findFirst({
        where: { workspaceId, category: body.category, id: { not: id } },
        select: { id: true },
      });
      if (clash) return reply.status(409).send(duplicate(body.category));
    }

    const kept = new Set(previewsOf(current));
    const added = previewsOf(body).filter((url) => !kept.has(url));
    if (!(await ownsUploads(added, userId))) return reply.status(400).send({ error: "Upload the preview image again." });

    let template;
    try {
      if (hasFigmaSource(body.linkUrl)) {
        template = await prisma.template.update({ where: { id }, data: templateData(body), select: LIBRARY_SELECT });
      } else {
        // The edit leaves the template without a Figma link (R2): under the template's lock, a published template must
        // still have its Canvas revision, unless it had no source to lose in the first place.
        const outcome = await prisma.$transaction(async (tx) => {
          if (!(await lockTemplate(tx, id, workspaceId))) return "missing" as const;
          const before = await tx.template.findFirst({ where: { id, workspaceId }, select: SOURCE_SELECT });
          if (!before) return "missing" as const;
          if (before.published && hasUsableSource(sourceOf(before)) && !hasCanvasSource(sourceOf(before).canvasRevision)) return "required" as const;
          return tx.template.update({ where: { id }, data: templateData(body), select: LIBRARY_SELECT });
        });
        if (outcome === "missing") return reply.status(404).send({ error: "Not found" });
        if (outcome === "required") return reply.status(409).send(SOURCE_REQUIRED);
        template = outcome;
      }
    } catch (err) {
      if (isUniqueViolation(err)) return reply.status(409).send(duplicate(body.category));
      throw err;
    }
    await claimUploads(added);
    const next = new Set(previewsOf(body));
    await removeFiles(previewsOf(current).filter((url) => !next.has(url)));
    return reply.send({ template: toLibraryTemplate(template) });
  });

  // Publish a template to Marketing, or take it back to a draft — design team only.
  app.patch("/templates/:id/status", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };

    const forbidden = await requireTemplateManagerRole(userId, workspaceId);
    if (forbidden) return reply.status(403).send(forbidden);

    const parsed = statusBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "published must be true or false" });

    if (parsed.data.published) {
      // R1: publishing needs a source. Checked under the template's lock, so a request that removes the source at the
      // same moment (an edit, or unlinking the design) runs before or after this one, never between its check and write.
      const outcome = await prisma.$transaction(async (tx) => {
        if (!(await lockTemplate(tx, id, workspaceId))) return "missing" as const;
        const current = await tx.template.findFirst({ where: { id, workspaceId }, select: SOURCE_SELECT });
        if (!current) return "missing" as const;
        if (!hasUsableSource(sourceOf(current))) return "incomplete" as const;
        await tx.template.updateMany({ where: { id, workspaceId }, data: { published: true } });
        return tx.template.findFirst({ where: { id, workspaceId }, select: LIBRARY_SELECT });
      });
      if (outcome === "missing" || outcome === null) return reply.status(404).send({ error: "Not found" });
      if (outcome === "incomplete") return reply.status(409).send(INCOMPLETE);
      return reply.send({ template: toLibraryTemplate(outcome) });
    }

    // Back to a draft: always allowed, and it touches nothing but the status (the design, its revisions and images stay).
    const { count } = await prisma.template.updateMany({ where: { id, workspaceId }, data: { published: false } });
    if (count === 0) return reply.status(404).send({ error: "Not found" });

    const template = await prisma.template.findFirst({ where: { id, workspaceId }, select: LIBRARY_SELECT });
    if (!template) return reply.status(404).send({ error: "Not found" });
    return reply.send({ template: toLibraryTemplate(template) });
  });

  // Delete a template and its files — design team only. Posts never reference
  // design template files; legacy kit files stay protected (withoutTemplateMedia).
  app.delete("/templates/:id", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };

    const forbidden = await requireTemplateManagerRole(userId, workspaceId);
    if (forbidden) return reply.status(403).send(forbidden);

    const template = await prisma.template.findFirst({
      where: { id, workspaceId },
      select: { id: true, previewUrl: true },
    });
    if (!template) return reply.status(404).send({ error: "Not found" });

    await prisma.template.delete({ where: { id } });
    await removeFiles(previewsOf(template));
    return reply.send({ ok: true });
  });
}
