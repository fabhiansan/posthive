import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { withAuth, withAuthOrToken, getUser, getWorkspaceId, getWorkspaceRole, requireTemplateManagerRole } from "../lib/auth/withAuth.js";
import { pillarFor } from "../lib/contentTypes.js";
import type { StorageAdapter } from "../lib/storage.js";
import { LIBRARY_SELECT, SOURCE_SELECT, hasCanvasSource, hasFigmaSource, hasUsableSource, isLibraryVisible, lockTemplate, slideColumns, slideImagesOf, sourceOf, toLibraryTemplate, type SlideImage } from "../lib/templates.js";
import { MediaUnavailable, attachUploads, releaseMedia } from "../lib/mediaDelete.js";
import { templateBody, type TemplateBody } from "../lib/templateBody.js";

/** A parsed body once the slide list is known: the parser leaves it out when the request did not send one. */
type ResolvedBody = Omit<TemplateBody, "slideImages"> & { slideImages: SlideImage[] };

function templateData(t: ResolvedBody) {
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
    ...slideColumns(t.slideImages),
    captionGuideline: t.captionGuideline,
  };
}

const statusBody = z.object({ published: z.boolean() });

/** Every file a template holds: its preview and its slide images. */
const filesOf = (t: { previewUrl: string | null; slideUrls?: string[] }) => [...(t.previewUrl ? [t.previewUrl] : []), ...(t.slideUrls ?? [])];
/** The files a request body asks the template to hold. */
const bodyFiles = (t: ResolvedBody) => filesOf({ previewUrl: t.previewUrl, slideUrls: t.slideImages.map((s) => s.url) });

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

  // Remove files a template no longer uses. A file a post, a Library item, another template or a legacy kit still uses stays (releaseMedia
  // looks everywhere, under the Upload row lock). Only the design team's own uploads go: the person acting, or whoever uploaded the file
  // when it was attached (a template is kept by the team).
  async function removeFiles(urls: string[], userId: string, workspaceId: string): Promise<void> {
    if (!urls.length) return;
    try {
      const team = await prisma.workspaceMember.findMany({ where: { workspaceId }, select: { userId: true } });
      await releaseMedia(storage, urls, [userId, ...team.map((m) => m.userId)]);
    } catch {
      // best effort: a file left behind is a leak, never a reason to fail the request
    }
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
    const body = { ...parsed.data, slideImages: parsed.data.slideImages ?? [] };

    const existing = await prisma.template.findFirst({ where: { workspaceId, category: body.category }, select: { id: true } });
    if (existing) return reply.status(409).send(duplicate(body.category));

    const files = bodyFiles(body);
    if (!(await ownsUploads(files, userId))) return reply.status(400).send({ error: "Upload the images again." });

    try {
      // the files are locked, checked (uploads of this person that still exist) and claimed in the transaction that stores the template
      const template = await prisma.$transaction(async (tx) => {
        await attachUploads(tx, files, { userId });
        return tx.template.create({ data: { userId, workspaceId, ...templateData(body) }, select: LIBRARY_SELECT });
      }, { timeout: 30_000 });
      return reply.status(201).send({ template: toLibraryTemplate(template) });
    } catch (err) {
      if (err instanceof MediaUnavailable) return reply.status(400).send({ error: "Upload the images again." });
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

    const current = await prisma.template.findFirst({
      where: { id, workspaceId },
      select: { id: true, category: true, previewUrl: true, slideUrls: true, slideLabels: true },
    });
    if (!current) return reply.status(404).send({ error: "Not found" });

    // An editor from before slide images (a tab left open across a deploy) sends no list: a carousel keeps its slides, so
    // the edit neither clears them nor deletes their files. A list that is sent, even an empty one, is the new list.
    // (The parser leaves the list undefined for a carousel only; every other format already has [].)
    const slideImages = parsed.data.slideImages ?? slideImagesOf(current);
    const body = { ...parsed.data, slideImages, slides: slideImages.length > 0 ? slideImages.length : parsed.data.slides };

    // Only a category change can create a duplicate (legacy duplicates are cleaned up separately)
    if (body.category !== current.category) {
      const clash = await prisma.template.findFirst({
        where: { workspaceId, category: body.category, id: { not: id } },
        select: { id: true },
      });
      if (clash) return reply.status(409).send(duplicate(body.category));
    }

    const kept = new Set(filesOf(current));
    const added = bodyFiles(body).filter((url) => !kept.has(url));
    if (!(await ownsUploads(added, userId))) return reply.status(400).send({ error: "Upload the images again." });

    let template;
    try {
      if (hasFigmaSource(body.linkUrl)) {
        template = await prisma.$transaction(async (tx) => {
          await attachUploads(tx, added, { userId });
          return tx.template.update({ where: { id }, data: templateData(body), select: LIBRARY_SELECT });
        }, { timeout: 30_000 });
      } else {
        // The edit leaves the template without a Figma link (R2): under the template's lock, a published template must
        // still have its Canvas revision, unless it had no source to lose in the first place.
        const outcome = await prisma.$transaction(async (tx) => {
          if (!(await lockTemplate(tx, id, workspaceId))) return "missing" as const;
          const before = await tx.template.findFirst({ where: { id, workspaceId }, select: SOURCE_SELECT });
          if (!before) return "missing" as const;
          if (before.published && hasUsableSource(sourceOf(before)) && !hasCanvasSource(sourceOf(before).canvasRevision)) return "required" as const;
          await attachUploads(tx, added, { userId });
          return tx.template.update({ where: { id }, data: templateData(body), select: LIBRARY_SELECT });
        }, { timeout: 30_000 });
        if (outcome === "missing") return reply.status(404).send({ error: "Not found" });
        if (outcome === "required") return reply.status(409).send(SOURCE_REQUIRED);
        template = outcome;
      }
    } catch (err) {
      if (err instanceof MediaUnavailable) return reply.status(400).send({ error: "Upload the images again." });
      if (isUniqueViolation(err)) return reply.status(409).send(duplicate(body.category));
      throw err;
    }
    const next = new Set(bodyFiles(body));
    await removeFiles(filesOf(current).filter((url) => !next.has(url)), userId, workspaceId);
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
  // design template files; a file a post or a Library item still uses stays (releaseMedia).
  app.delete("/templates/:id", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };

    const forbidden = await requireTemplateManagerRole(userId, workspaceId);
    if (forbidden) return reply.status(403).send(forbidden);

    const template = await prisma.template.findFirst({
      where: { id, workspaceId },
      select: { id: true, previewUrl: true, slideUrls: true },
    });
    if (!template) return reply.status(404).send({ error: "Not found" });

    await prisma.template.delete({ where: { id } });
    await removeFiles(filesOf(template), userId, workspaceId);
    return reply.send({ ok: true });
  });

  // How many posts the design team's dialogs can name before it unpublishes or deletes a template: the posts of the same
  // category in the workspace, and the ones of them waiting for approval. These are counts, not the posts: the drafts of
  // Marketing are not shown to the design team, but how many there are is what tells it what the action reaches. A post
  // never points at a template (it only carries its category), so "uses this template" means "is of this category",
  // including posts made before the template existed. Design team only, like every other action on a template.
  // shortcut: the category is part of the post's stored JSON (the quarter plan reads it the same way), so this is a text
  // match over the workspace's posts; a category column and an index are the upgrade when posts per workspace get large.
  app.get("/templates/:id/usage", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };

    const forbidden = await requireTemplateManagerRole(userId, workspaceId);
    if (forbidden) return reply.status(403).send(forbidden);

    const template = await prisma.template.findFirst({ where: { id, workspaceId }, select: { category: true } });
    if (!template?.category) return reply.status(404).send({ error: "Not found" });

    // the stored JSON is compact: `"category":"Case Study"`. An import may write it in other letters, and "AMA" is Ask Me Anything (normalizeCategory).
    const spellings = template.category === "Ask Me Anything" ? [template.category, "AMA"] : [template.category];
    const named = spellings.map((c) => ({ content: { contains: `"category":${JSON.stringify(c)}`, mode: "insensitive" as const } }));
    const ofCategory = { workspaceId, OR: named };
    const [created, inReview] = await Promise.all([
      prisma.postJob.count({ where: ofCategory }),
      // the same rule as the Posts page's "In review" filter (lib/jobFilters.ts)
      prisma.postJob.count({ where: { AND: [ofCategory, { status: "draft", approvalStatus: "pending" }] } }),
    ]);
    return reply.send({ created, inReview });
  });
}
