import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { figmaLinkError } from "./figmaLink.js";

// Design templates (docs/content-types.md): the reference design for one content type
// (Pillar + Category). Posts never copy template files; they only carry pillar/category.

// The public API and MCP build their responses from this select. It must not change: it is their contract.
export const TEMPLATE_SELECT = {
  id: true,
  name: true,
  pillar: true,
  category: true,
  linkUrl: true,
  previewUrl: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The latest published Canvas revision of a template's design (none when it has no design or no revision yet). */
const LATEST_REVISION = { select: { revisions: { orderBy: { number: "desc" }, take: 1, select: { number: true } } } } as const;

/** What the Template Library page gets: the select above, the status, the format, who made it and its Canvas design. */
export const LIBRARY_SELECT = {
  ...TEMPLATE_SELECT,
  published: true,
  format: true,
  slides: true,
  platforms: true,
  designId: true,
  design: LATEST_REVISION,
  user: { select: { name: true } },
} as const;

/** A library row as the page reads it: the author's name, not the user record; the Canvas design as its id and latest revision number. */
export function toLibraryTemplate<T extends { user: { name: string | null } | null; design?: { revisions: { number: number }[] } | null }>({ user, design, ...rest }: T) {
  return { ...rest, canvasRevision: design?.revisions[0]?.number ?? null, createdBy: user?.name ?? null };
}

// ── What counts as a source ─────────────────────────────────────────────────
// A template is made from a Figma link, a Canvas design that has a published revision, or both. MIRRORED by
// apps/web/src/lib/templates.ts, with the same test vectors: KEEP IDENTICAL, so the page never claims a source the API refuses.

/** A stored link that is a real Figma design link. Null, blank and any other URL (https://example.com) are not a source. */
export const hasFigmaSource = (linkUrl: unknown): boolean => typeof linkUrl === "string" && linkUrl.trim() !== "" && figmaLinkError(linkUrl) === null;

/** A linked Canvas design with at least one published revision. */
export const hasCanvasSource = (canvasRevision: number | null | undefined): boolean => canvasRevision != null;

export const hasUsableSource = (t: { linkUrl?: string | null; canvasRevision?: number | null }): boolean => hasFigmaSource(t.linkUrl) || hasCanvasSource(t.canvasRevision);

/** What a template's source check reads, inside the locked transaction of every operation that can add or remove a source. */
export const SOURCE_SELECT = { id: true, linkUrl: true, published: true, designId: true, design: LATEST_REVISION } as const;

/** A SOURCE_SELECT row as the helpers above read it. */
export const sourceOf = (t: { linkUrl: string | null; design?: { revisions: { number: number }[] } | null }) => ({ linkUrl: t.linkUrl, canvasRevision: t.design?.revisions[0]?.number ?? null });

/**
 * Locks one template's row until the transaction ends, so two requests that change what a template is made from run one
 * after the other, each reading the other's result. Resolves false when there is no such template in the workspace.
 * Lock order everywhere: the template first, then its design.
 */
export async function lockTemplate(tx: Prisma.TransactionClient, id: string, workspaceId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Template" WHERE "id" = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  return rows.length > 0;
}

/**
 * The internal Marketing library lists a template unless it points at a Canvas design and has neither a real Figma link
 * nor a published revision. The routes never produce such a row (publishing and linking refuse it); this keeps one from
 * reaching Marketing if it ever appears. Templates without a design are never touched by it, legacy rows included.
 */
export const isLibraryVisible = (t: { designId?: string | null; linkUrl?: string | null; canvasRevision?: number | null }): boolean =>
  t.designId == null || hasFigmaSource(t.linkUrl) || hasCanvasSource(t.canvasRevision);

// ── The public API and MCP ──────────────────────────────────────────────────
// They return Figma references only. A template that has a Canvas design is returned only through a real Figma link
// (a Canvas-only template waits for the Marketing phase); a template without a design is returned exactly as before.

/** TEMPLATE_SELECT plus the design id, for the visibility check only: no response carries it. */
export const EXTERNAL_SELECT = { ...TEMPLATE_SELECT, designId: true } as const;

export type ExternalTemplate = Prisma.TemplateGetPayload<{ select: typeof EXTERNAL_SELECT }>;

export const isExternallyVisible = (t: { designId?: string | null; linkUrl?: string | null }): boolean => t.designId == null || hasFigmaSource(t.linkUrl);

const EXTERNAL_BATCH = 100;

/**
 * The published templates the public API and MCP may return, in their existing order (newest change first, then id), at
 * most `limit` of them (all of them when there is none). Reads in batches with a keyset boundary taken from the last row
 * it read, until it has enough eligible rows or runs out, so rows it must skip never use up the limit and nothing is
 * cut off by a scan cap. (Prisma's own `cursor` would return nothing if the cursor row were deleted mid-scan.)
 */
export async function listExternalTemplates(workspaceId: string, limit?: number): Promise<ExternalTemplate[]> {
  // The caller passes a whole number (the REST route validates it) or none; 0 is "no rows", never a reason to query.
  const max = limit === undefined ? Infinity : limit;
  if (!(max >= 1)) return [];
  const base = { workspaceId, category: { not: null }, published: true };
  const out: ExternalTemplate[] = [];
  let boundary: { updatedAt: Date; id: string } | null = null;
  for (;;) {
    const rows: ExternalTemplate[] = await prisma.template.findMany({
      where: boundary ? { AND: [base, { OR: [{ updatedAt: { lt: boundary.updatedAt } }, { updatedAt: boundary.updatedAt, id: { lt: boundary.id } }] }] } : base,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: EXTERNAL_BATCH,
      select: EXTERNAL_SELECT,
    });
    for (const t of rows) {
      if (!isExternallyVisible(t)) continue;
      out.push(t);
      if (out.length >= max) return out;
    }
    if (rows.length < EXTERNAL_BATCH) return out;
    const last = rows[rows.length - 1];
    boundary = { updatedAt: last.updatedAt, id: last.id };
  }
}

/** One published template for the public API and MCP, or null when it is missing, a draft, or not for them (a Canvas-only one). */
export async function findExternalTemplate(id: string, workspaceId: string): Promise<ExternalTemplate | null> {
  const t = await prisma.template.findFirst({ where: { id, workspaceId, category: { not: null }, published: true }, select: EXTERNAL_SELECT });
  return t && isExternallyVisible(t) ? t : null;
}

/**
 * Drops URLs still used by a design template or by a legacy template kit. Posts made
 * from a legacy kit share its design files, so post cleanup (delete, edit, after
 * publish, failed-job cleanup) must never remove them.
 */
export async function withoutTemplateMedia(urls: string[]): Promise<string[]> {
  if (!urls.length) return urls;
  const [templates, legacy] = await Promise.all([
    prisma.template.findMany({
      where: { previewUrl: { in: urls } },
      select: { previewUrl: true },
    }),
    prisma.legacyTemplateMedia.findMany({ where: { url: { in: urls } }, select: { url: true } }),
  ]);
  const inUse = new Set(legacy.map((l) => l.url));
  for (const t of templates) {
    if (t.previewUrl) inUse.add(t.previewUrl);
  }
  return urls.filter((url) => !inUse.has(url));
}

/** Storage URLs are relative for local disk; API clients need absolute ones. */
export function absoluteUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = (process.env.PUBLIC_API_URL ?? process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`).replace(/\/$/, "");
  return `${base}${url}`;
}

type TemplateFiles = {
  linkUrl: string | null;
  previewUrl: string | null;
};

/** The design reference returned by the public API and MCP (absolute URLs). */
export function designReference(t: TemplateFiles) {
  return {
    linkUrl: t.linkUrl,
    previewUrl: t.previewUrl ? absoluteUrl(t.previewUrl) : null,
  };
}
