/**
 * Read-only report for the design-template cleanup (run BEFORE the second
 * template migration, which deletes rows). Nothing is written.
 *
 * 1. Templates kept / deleted: per workspace + category the most recently
 *    updated row is kept; rows without a workspace or a known category and
 *    older duplicates are deleted. Deleted rows are printed in full so they
 *    can be restored by hand.
 * 2. Posts that use legacy template media (designer files copied into the
 *    post by the old template kit), scheduled ones first — fix these by hand.
 * 3. Posts with per-slide copy / templateId, and media URLs shared by 2+ posts
 *    that are NOT protected by LegacyTemplateMedia.
 *
 * Usage (from apps/api, DATABASE_URL pointing at the target database):
 *   npx tsx scripts/template-migration-report.ts
 *   npx tsx scripts/template-migration-report.ts --json > report.json
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { CATEGORIES } from "../src/lib/contentTypes.js";

const prisma = new PrismaClient();
const asJson = process.argv.includes("--json");

type TemplateRow = { id: string; workspaceId: string | null; name: string; category: string | null; content: string; updatedAt: Date };
type PostRow = { id: string; workspaceId: string | null; status: string; approvalStatus: string | null; scheduledFor: Date | null; content: string };

function parse(content: string): Record<string, unknown> {
  try { return JSON.parse(content) as Record<string, unknown>; } catch { return {}; }
}
const mediaOf = (c: Record<string, unknown>) =>
  Array.isArray(c.mediaUrls) ? (c.mediaUrls as unknown[]).filter((u): u is string => typeof u === "string" && u !== "") : [];

// Scheduled posts publish soonest, so they come first
const STATUS_ORDER = ["pending", "running", "draft", "failed", "done"];
const statusRank = (s: string) => (STATUS_ORDER.indexOf(s) === -1 ? STATUS_ORDER.length : STATUS_ORDER.indexOf(s));

async function main() {
  const report = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

    // ── 1. Templates ────────────────────────────────────────────────────────
    const templates = await tx.template.findMany({
      select: { id: true, workspaceId: true, name: true, category: true, content: true, updatedAt: true },
    }) as TemplateRow[];

    // Same rule as the cleanup migration: category column, else the legacy JSON category (exact match)
    const legacyCategory = (c: unknown) => (CATEGORIES as readonly unknown[]).includes(c) ? (c as string) : null;
    const withCategory = templates.map((t) => ({ ...t, effective: t.category ?? legacyCategory(parse(t.content).category) }));
    const newest = new Map<string, (typeof withCategory)[number]>();
    for (const t of withCategory) {
      if (!t.workspaceId || !t.effective) continue;
      const key = `${t.workspaceId}|${t.effective}`;
      const cur = newest.get(key);
      if (!cur || t.updatedAt > cur.updatedAt || (+t.updatedAt === +cur.updatedAt && t.id > cur.id)) newest.set(key, t);
    }
    const keptIds = new Set([...newest.values()].map((t) => t.id));
    const kept = withCategory.filter((t) => keptIds.has(t.id));
    const deleted = withCategory
      .filter((t) => !keptIds.has(t.id))
      .map((t) => ({
        ...t,
        reason: !t.workspaceId ? "no workspace" : !t.effective ? "no known category (caption template or unreadable)" : "older duplicate",
      }));

    // ── 2. Posts using legacy template media ────────────────────────────────
    const legacyRows = await tx.legacyTemplateMedia.findMany({ select: { url: true } });
    const legacy = new Set([...legacyRows.map((r) => r.url), ...templates.flatMap((t) => mediaOf(parse(t.content)))]);

    const affected: { id: string; workspaceId: string | null; status: string; inReview: boolean; scheduledFor: Date | null; urls: string[] }[] = [];
    let slidesCount = 0;
    let templateIdCount = 0;
    const usage = new Map<string, number>();

    let cursor: string | undefined;
    for (;;) {
      const page = await tx.postJob.findMany({
        take: 1000,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
        select: { id: true, workspaceId: true, status: true, approvalStatus: true, scheduledFor: true, content: true },
      }) as PostRow[];
      if (!page.length) break;
      for (const p of page) {
        const c = parse(p.content);
        const media = mediaOf(c);
        const urls = media.filter((u) => legacy.has(u));
        if (urls.length) {
          affected.push({ id: p.id, workspaceId: p.workspaceId, status: p.status, inReview: p.approvalStatus === "pending", scheduledFor: p.scheduledFor, urls });
        }
        if (Array.isArray(c.slides) && c.slides.length) slidesCount++;
        if (typeof c.templateId === "string") templateIdCount++;
        for (const u of new Set(media)) usage.set(u, (usage.get(u) ?? 0) + 1);
      }
      cursor = page[page.length - 1].id;
    }
    affected.sort((a, b) => statusRank(a.status) - statusRank(b.status) || +(a.scheduledFor ?? 0) - +(b.scheduledFor ?? 0));

    // ── 3. Shared media not covered by LegacyTemplateMedia ─────────────────
    const unprotectedShared = [...usage.entries()]
      .filter(([url, n]) => n >= 2 && !legacy.has(url))
      .map(([url, posts]) => ({ url, posts }));

    return {
      templates: {
        total: templates.length,
        kept: kept.map(({ id, workspaceId, effective, updatedAt }) => ({ id, workspaceId, category: effective, updatedAt })),
        deleted: deleted.map(({ effective, ...row }) => ({ ...row, category: effective })),
      },
      legacyMediaUrls: legacy.size,
      legacyMediaRows: legacyRows.length,
      postsUsingLegacyMedia: affected,
      postsWithSlides: slidesCount,
      postsWithTemplateId: templateIdCount,
      unprotectedSharedMedia: unprotectedShared,
    };
  }, { timeout: 120_000 });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const { templates } = report;
  console.log(`\n== 1. Templates: ${templates.total} total, ${templates.kept.length} kept, ${templates.deleted.length} to delete ==`);
  for (const t of templates.kept) console.log(`  KEEP    ${t.id}  ws=${t.workspaceId}  ${t.category}  (updated ${t.updatedAt.toISOString()})`);
  for (const t of templates.deleted) {
    console.log(`  DELETE  ${t.id}  ws=${t.workspaceId}  ${t.category ?? "-"}  [${t.reason}]  name="${t.name}"`);
    console.log(`          content: ${t.content}`);
  }
  if (report.legacyMediaRows < report.legacyMediaUrls) {
    console.log(`  NOTE: ${report.legacyMediaUrls - report.legacyMediaRows} legacy media URL(s) are not in LegacyTemplateMedia yet; the cleanup migration inserts them before deleting.`);
  }

  console.log(`\n== 2. Posts using legacy template media: ${report.postsUsingLegacyMedia.length} ==`);
  for (const p of report.postsUsingLegacyMedia) {
    const when = p.scheduledFor && +p.scheduledFor > 0 ? p.scheduledFor.toISOString() : "-";
    console.log(`  ${p.status.padEnd(8)}${p.inReview ? " (in review)" : ""}  ${p.id}  ws=${p.workspaceId}  scheduled=${when}  files=${p.urls.length}`);
  }

  console.log(`\n== 3. Other ==`);
  console.log(`  Posts with per-slide copy: ${report.postsWithSlides}`);
  console.log(`  Posts with templateId:     ${report.postsWithTemplateId}`);
  console.log(`  Media shared by 2+ posts and not protected: ${report.unprotectedSharedMedia.length}`);
  for (const m of report.unprotectedSharedMedia) console.log(`    ${m.posts} posts  ${m.url}`);
  console.log("");
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
