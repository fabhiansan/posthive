import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { withAuth, withAuthOrToken, getUser, getWorkspaceId, requireTemplateManagerRole } from "../lib/auth/withAuth.js";
import { CATEGORIES, pillarFor } from "../lib/contentTypes.js";

// Template kit (docs/content-types.md): design slides + per-slide copy structure + caption draft.
// slides[i] describes mediaUrls[i]; Marketing types the copy for each slide in Compose.
const templateBody = z.object({
  name: z.string().trim().min(1).max(100),
  content: z.object({
    text: z.string().max(5000).default(""),
    commentText: z.string().max(2000).optional(),
    mediaUrls: z.array(z.string().min(1)).min(1, "Upload at least one design").max(20),
    altTexts: z.array(z.string()).optional(),
    mediaType: z.enum(["post", "reel", "story"]).optional(),
    category: z.enum(CATEGORIES),
    format: z.enum(["carousel", "poster"]),
    slides: z.array(z.object({
      label: z.string().trim().min(1).max(40),
      guide: z.string().max(500).default(""),
    })).max(20),
  }).superRefine((c, ctx) => {
    if (c.slides.length !== c.mediaUrls.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["slides"], message: "Each design needs exactly one slide entry" });
    }
    if (c.format === "poster" && c.mediaUrls.length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mediaUrls"], message: "A poster has exactly one design" });
    }
  }),
});

type TemplateBody = z.infer<typeof templateBody>;

const TEMPLATE_SELECT = { id: true, name: true, content: true, createdAt: true, updatedAt: true } as const;

function serializeContent(content: TemplateBody["content"]): string {
  // Pillar is derived, never trusted from the client
  return JSON.stringify({ ...content, pillar: pillarFor(content.category) });
}

// Uploads unclaimed for 24h are deleted by the orphan cron (index.ts) — claim template designs.
async function claimMedia(mediaUrls: string[], userId: string): Promise<void> {
  await prisma.upload.updateMany({
    where: { url: { in: mediaUrls }, userId },
    data: { claimedAt: new Date() },
  });
}

export async function templateRoutes(app: FastifyInstance): Promise<void> {

  // List all templates for the current workspace (every role can view)
  app.get("/templates", { preHandler: [withAuthOrToken] }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const templates = await prisma.template.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      select: TEMPLATE_SELECT,
    });
    return reply.send({ templates });
  });

  // Create a template — design team only (docs/role-access-matrix.md US-07)
  app.post("/templates", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);

    const forbidden = await requireTemplateManagerRole(userId, workspaceId);
    if (forbidden) return reply.status(403).send(forbidden);

    const parsed = templateBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const existing = await prisma.template.findFirst({
      where: { workspaceId, name: { equals: parsed.data.name, mode: "insensitive" } },
      select: { id: true },
    });
    if (existing) return reply.status(409).send({ error: `A template named "${parsed.data.name}" already exists.` });

    const template = await prisma.template.create({
      data: {
        userId,
        workspaceId,
        name: parsed.data.name,
        content: serializeContent(parsed.data.content),
      },
      select: TEMPLATE_SELECT,
    });
    await claimMedia(parsed.data.content.mediaUrls, userId);
    return reply.status(201).send({ template });
  });

  // Replace a template (name, designs, copy structure) — design team only
  app.patch("/templates/:id", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };

    const forbidden = await requireTemplateManagerRole(userId, workspaceId);
    if (forbidden) return reply.status(403).send(forbidden);

    const parsed = templateBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const template = await prisma.template.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!template) return reply.status(404).send({ error: "Not found" });

    const clash = await prisma.template.findFirst({
      where: { workspaceId, id: { not: id }, name: { equals: parsed.data.name, mode: "insensitive" } },
      select: { id: true },
    });
    if (clash) return reply.status(409).send({ error: `A template named "${parsed.data.name}" already exists.` });

    const updated = await prisma.template.update({
      where: { id },
      data: { name: parsed.data.name, content: serializeContent(parsed.data.content) },
      select: TEMPLATE_SELECT,
    });
    await claimMedia(parsed.data.content.mediaUrls, userId);
    return reply.send({ template: updated });
  });

  // Delete a template — design team only. Design files stay: posts made from
  // the template reference the same URLs.
  app.delete("/templates/:id", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };

    const forbidden = await requireTemplateManagerRole(userId, workspaceId);
    if (forbidden) return reply.status(403).send(forbidden);

    const template = await prisma.template.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!template) return reply.status(404).send({ error: "Not found" });

    await prisma.template.delete({ where: { id } });
    return reply.send({ ok: true });
  });
}
