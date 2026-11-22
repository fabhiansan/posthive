// Canvas routes. Assets (phase 2): privacy headers, workspace isolation, fail-closed storage, and that the storage
// path never reaches a client. Designs (phase 3): designer-only access, workspace isolation, strict validation,
// the optimistic lock. Real LocalDiskStorage over a temp directory; prisma and auth are mocked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface DesignRow {
  id: string;
  workspaceId: string;
  kind: string;
  name: string;
  document?: unknown; // null/absent for an instance
  version: number;
  createdByUserId: string | null;
  updatedAt: Date;
  // Phase 5 (instances only)
  createdAt?: Date;
  overrides?: unknown;
  baseRevisionId?: string | null;
  // Phase 6 (instances only): set when a submitted design is archived
  archivedAt?: Date | null;
}

/** A review snapshot, as the database holds one (insert only). */
interface SubmissionRow {
  id: string;
  workspaceId: string;
  instanceId: string;
  number: number;
  instanceVersion: number;
  name: string;
  note: string | null;
  baseRevisionId: string;
  overrides: unknown;
  document: unknown;
  submittedByUserId: string;
  createdAt: Date;
}
interface ReviewRow {
  id: string;
  workspaceId: string;
  submissionId: string;
  status: string;
  pendingInstanceId: string | null;
  comment: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

interface TemplateRow {
  id: string;
  workspaceId: string;
  category: string;
  linkUrl: string | null;
  published: boolean;
  designId: string | null;
}
interface RevisionRow {
  id: string;
  designId: string;
  number: number;
  designVersion: number;
  document: unknown;
  manifest: unknown;
  createdByUserId: string | null;
  createdAt: Date;
}

const h = vi.hoisted(() => ({
  authed: true,
  workspace: "ws-1" as string | null,
  role: "designer" as string | null,
  rows: [] as Array<{ id: string; workspaceId: string; storageRef: string }>,
  designs: [] as DesignRow[],
  templates: [] as TemplateRow[],
  revisions: [] as RevisionRow[],
  submissions: [] as SubmissionRow[],
  reviews: [] as ReviewRow[],
  // Submissions another connection committed while a transaction ran: a rollback of THIS transaction must not undo them.
  outsideSubmissions: [] as SubmissionRow[],
  // People of the workspace (for "is there a designer?") and the accounts that exist (for names).
  members: [] as Array<{ workspaceId: string; userId: string; role: string }>,
  users: [] as Array<{ id: string; name: string }>,
  clock: 0,
  createFails: false,
  // What ran, in order. "tx:" and "out:" say whether a read happened inside a $transaction; "lock:" is a FOR UPDATE.
  log: [] as string[],
  inTx: false,
  // Makes the next write to the template's designId fail the way the unique index does (Prisma error P2002).
  attachRaces: false,
  // While a transaction runs: true only inside a call made through the transaction's own client, and the designs a call
  // made through the plain client (outside the transaction) created, which a rollback must NOT undo, like in PostgreSQL.
  viaTx: false,
  outsideDesigns: [] as DesignRow[],
  // The signed-in user (an instance is personal to its creator).
  userId: "user-1",
  // Called right after a lock is taken. A test uses it to be "the other transaction" that committed while this one waited
  // for the lock: it changes the store, and whatever the route reads AFTER the lock must see that.
  onLock: null as null | ((which: "template" | "design" | "instance") => void),
}));

// What a Prisma `where` on a Design can say: equality, `lt` for the keyset boundary, a relation filter, AND and OR.
type Cond = {
  id?: string | { lt: string };
  workspaceId?: string;
  kind?: string;
  version?: number;
  createdByUserId?: string;
  createdAt?: Date | { lt: Date };
  baseRevision?: { designId: string };
  // Phase 6: `null` is "not archived", `{ not: null }` is "archived".
  archivedAt?: null | { not: null };
  AND?: Cond[];
  OR?: Cond[];
};
type Where = Cond;
// A `where` key the double does not understand must FAIL the test, not be ignored: a filter that is silently dropped here (an
// `archivedAt` forgotten on a route) would pass every test and leak archived rows in production.
const KNOWN_KEYS = new Set(["id", "workspaceId", "kind", "version", "createdByUserId", "createdAt", "baseRevision", "archivedAt", "AND", "OR"]);
const rejectUnknown = (w: object, what: string) => {
  for (const k of Object.keys(w)) if (!KNOWN_KEYS.has(k)) throw new Error(`the test double does not understand \`${k}\` in a ${what} where: add it, or the filter is silently ignored`);
};
const nul = (v: unknown) => typeof v === "string" && v.includes("\u0000");
// PostgreSQL refuses a NUL in text (error 22021) and Prisma throws it: a test double that quietly matched nothing
// would hide a 500 that the real database causes. Checked against the real dev database.
const refuseNul = (...values: unknown[]) => {
  if (values.some(nul)) throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
};
const matches = (d: DesignRow, w: Cond): boolean => {
  rejectUnknown(w, "design");
  refuseNul(w.id);
  const archivedOk = w.archivedAt === undefined || (w.archivedAt === null ? (d.archivedAt ?? null) === null : (d.archivedAt ?? null) !== null);
  const idOk = w.id === undefined || (typeof w.id === "string" ? d.id === w.id : d.id < w.id.lt);
  const at = (d.createdAt ?? new Date(0)).getTime();
  const createdOk = w.createdAt === undefined || (w.createdAt instanceof Date ? at === w.createdAt.getTime() : at < w.createdAt.lt.getTime());
  const baseOk = w.baseRevision === undefined || h.revisions.some((r) => r.id === d.baseRevisionId && r.designId === w.baseRevision!.designId);
  return (
    idOk &&
    createdOk &&
    baseOk &&
    archivedOk &&
    (w.workspaceId === undefined || d.workspaceId === w.workspaceId) &&
    (w.kind === undefined || d.kind === w.kind) &&
    (w.version === undefined || d.version === w.version) &&
    (w.createdByUserId === undefined || d.createdByUserId === w.createdByUserId) &&
    (w.AND === undefined || w.AND.every((c) => matches(d, c))) &&
    (w.OR === undefined || w.OR.some((c) => matches(d, c)))
  );
};
// The database's own rules for a Design row (the migration's Design_shape_check): a template has its document and none of the
// instance columns; an instance has no document and has both its base revision and its overrides.
const shapeError = (d: DesignRow): string | null => {
  const hasDoc = d.document !== undefined && d.document !== null;
  const base = d.baseRevisionId ?? null;
  const ov = d.overrides ?? null;
  // Design_archive_check: only an instance can be archived.
  if (d.archivedAt && d.kind !== "instance") return `new row for relation "Design" violates check constraint "Design_archive_check" (${d.kind})`;
  if (d.kind === "template" && hasDoc && base === null && ov === null) return null;
  if (d.kind === "instance" && !hasDoc && base !== null && ov !== null) return null;
  return `new row for relation "Design" violates check constraint "Design_shape_check" (${d.kind})`;
};
/** The database's foreign keys that point at a Design: a template, a pinning instance, or a submission. */
const designReferenced = (d: DesignRow): string | null => {
  if (h.designs.some((i) => i.kind === "instance" && h.revisions.some((r) => r.id === i.baseRevisionId && r.designId === d.id))) return "Design_baseRevisionId_fkey";
  if (h.submissions.some((s) => s.instanceId === d.id)) return "DesignSubmission_instanceId_fkey"; // NO ACTION: a submitted instance cannot be hard-deleted
  if (h.submissions.some((s) => h.revisions.some((r) => r.id === s.baseRevisionId && r.designId === d.id))) return "DesignSubmission_baseRevisionId_fkey";
  return null;
};
const fkError = (name: string) => Object.assign(new Error(`Foreign key constraint failed on the field: \`${name}\``), { code: "P2003" });
const triggerError = (what: string) => Object.assign(new Error(what), { code: "P2010" });

type Spec = true | { select?: Record<string, unknown>; take?: number; orderBy?: unknown };
const pick = (row: object, select: Record<string, unknown>) => Object.fromEntries(Object.entries(select).filter(([, on]) => on).map(([k]) => [k, (row as Record<string, unknown>)[k]]));
/** Revisions of a design, as a nested `revisions: { orderBy: number desc, take, select }` asks for them. */
const revisionsOf = (designId: string, spec: Spec) =>
  h.revisions
    .filter((r) => r.designId === designId)
    .sort((a, b) => b.number - a.number)
    .slice(0, typeof spec === "object" && spec.take ? spec.take : undefined)
    .map((r) => pick(r, (typeof spec === "object" && spec.select) || { number: true }));
/** What Prisma's `select` does: only the named fields come back; a relation is resolved from the other stores. */
const selectFrom = (row: DesignRow, select: Record<string, Spec>) =>
  Object.fromEntries(
    Object.entries(select)
      .filter(([, spec]) => spec)
      .map(([k, spec]) => {
        if (k === "template") {
          const t = h.templates.find((x) => x.designId === row.id);
          return [k, t ? pick(t, (spec as { select: Record<string, unknown> }).select) : null];
        }
        if (k === "revisions") return [k, revisionsOf(row.id, spec)];
        if (k === "baseRevision") {
          const r = h.revisions.find((x) => x.id === row.baseRevisionId);
          return [k, r ? pick(r, (spec as { select: Record<string, unknown> }).select) : null];
        }
        if (k === "archivedAt") return [k, row.archivedAt ?? null]; // a column, NULL until archived
        return [k, (row as unknown as Record<string, unknown>)[k]];
      }),
  );
const selectTemplate = (t: TemplateRow, select: Record<string, Spec>) =>
  Object.fromEntries(
    Object.entries(select)
      .filter(([, spec]) => spec)
      .map(([k, spec]) => (k === "design" ? [k, t.designId ? { revisions: revisionsOf(t.designId, (spec as { select: { revisions: Spec } }).select.revisions) } : null] : [k, (t as unknown as Record<string, unknown>)[k]])),
  );
const trace = (op: string) => h.log.push(`${h.inTx ? "tx" : "out"}:${op}`);

// ── The phase 6 tables ──
type Sel = Record<string, unknown>;
const pickRow = (row: object, select: Sel) => Object.fromEntries(Object.entries(select).filter(([, on]) => on).map(([k]) => [k, (row as Record<string, unknown>)[k] ?? null]));
const sub = (spec: unknown) => (spec as { select: Sel }).select;

type SubWhere = { instanceId?: string; workspaceId?: string; number?: number | { lt: number }; baseRevision?: { designId: string } };
const subMatches = (s: SubmissionRow, w: SubWhere): boolean => {
  for (const k of Object.keys(w)) if (!["instanceId", "workspaceId", "number", "baseRevision"].includes(k)) throw new Error(`the test double does not understand \`${k}\` in a submission where`);
  return (
    (w.instanceId === undefined || s.instanceId === w.instanceId) &&
    (w.workspaceId === undefined || s.workspaceId === w.workspaceId) &&
    (w.number === undefined || (typeof w.number === "number" ? s.number === w.number : s.number < w.number.lt)) &&
    (w.baseRevision === undefined || h.revisions.some((r) => r.id === s.baseRevisionId && r.designId === w.baseRevision!.designId))
  );
};
const projectSubmission = (s: SubmissionRow, select: Sel): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(select)
      .filter(([, on]) => on)
      .map(([k, spec]) => {
        if (k === "review") {
          const r = h.reviews.find((x) => x.submissionId === s.id);
          return [k, r ? projectReview(r, sub(spec)) : null];
        }
        if (k === "baseRevision") {
          const r = h.revisions.find((x) => x.id === s.baseRevisionId);
          return [k, r ? pickRow(r, sub(spec)) : null];
        }
        if (k === "instance") {
          const d = h.designs.find((x) => x.id === s.instanceId);
          return [k, d ? { ...pickRow(d, sub(spec)) } : null];
        }
        return [k, (s as unknown as Record<string, unknown>)[k]];
      }),
  );

type ReviewWhere = {
  id?: string | { lt: string };
  workspaceId?: string;
  status?: string | { in: string[] };
  pendingInstanceId?: string;
  createdAt?: Date | { lt: Date };
  AND?: ReviewWhere[];
  OR?: ReviewWhere[];
};
const reviewMatches = (r: ReviewRow, w: ReviewWhere): boolean => {
  for (const k of Object.keys(w)) if (!["id", "workspaceId", "status", "pendingInstanceId", "createdAt", "AND", "OR"].includes(k)) throw new Error(`the test double does not understand \`${k}\` in a review where`);
  refuseNul(typeof w.id === "string" ? w.id : undefined);
  const at = r.createdAt.getTime();
  return (
    (w.id === undefined || (typeof w.id === "string" ? r.id === w.id : r.id < w.id.lt)) &&
    (w.workspaceId === undefined || r.workspaceId === w.workspaceId) &&
    (w.status === undefined || (typeof w.status === "string" ? r.status === w.status : w.status.in.includes(r.status))) &&
    (w.pendingInstanceId === undefined || r.pendingInstanceId === w.pendingInstanceId) &&
    (w.createdAt === undefined || (w.createdAt instanceof Date ? at === w.createdAt.getTime() : at < w.createdAt.lt.getTime())) &&
    (w.AND === undefined || w.AND.every((c) => reviewMatches(r, c))) &&
    (w.OR === undefined || w.OR.some((c) => reviewMatches(r, c)))
  );
};
const projectReview = (r: ReviewRow, select: Sel): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(select)
      .filter(([, on]) => on)
      .map(([k, spec]) => {
        if (k === "submission") {
          const s = h.submissions.find((x) => x.id === r.submissionId);
          return [k, s ? projectSubmission(s, sub(spec)) : null];
        }
        return [k, (r as unknown as Record<string, unknown>)[k]];
      }),
  );
/** The CHECK constraints of DesignReviewRequest (the migration), enforced on every insert and update. */
const reviewCheck = (r: ReviewRow): string | null => {
  if (!["pending", "approved", "changes_requested", "superseded"].includes(r.status)) return 'violates check constraint "DesignReviewRequest_status_check"';
  if ((r.status === "pending") !== (r.pendingInstanceId !== null)) return 'violates check constraint "DesignReviewRequest_pending_check"';
  const decided = r.status === "approved" || r.status === "changes_requested";
  if (decided ? r.decidedAt === null || r.decidedByUserId === null : r.decidedAt !== null || r.decidedByUserId !== null || r.comment !== null) return 'violates check constraint "DesignReviewRequest_decided_check"';
  if (r.status === "changes_requested" && (r.comment === null || r.comment.trim() === "")) return 'violates check constraint "DesignReviewRequest_comment_check"';
  return null;
};

// The store lives in `h` and the helpers above are only called when a query runs, never while this factory runs.
vi.mock("../lib/prisma.js", () => {
  const client = {
    designAsset: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (h.createFails) throw new Error("db down");
        const row = { id: `asset-${h.rows.length + 1}`, ...data } as { id: string; workspaceId: string; storageRef: string };
        h.rows.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; workspaceId: string } }) => {
        // Like PostgreSQL (checked against the real dev database): a NUL in text is refused, and Prisma throws.
        if (where.id.includes("\u0000")) throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
        return h.rows.find((r) => r.id === where.id && r.workspaceId === where.workspaceId) ?? null;
      }),
      count: vi.fn(async ({ where }: { where: { id: { in: string[] }; workspaceId: string } }) => {
        trace("designAsset.count");
        return h.rows.filter((r) => where.id.in.includes(r.id) && r.workspaceId === where.workspaceId).length;
      }),
    },
    design: {
      findMany: vi.fn(async ({ where, take, select, orderBy }: { where: Where; take: number; select: Record<string, Spec>; orderBy?: Array<Record<string, "desc">> }) => {
        // The designer's list orders by updatedAt; "my designs" orders by createdAt then id, which an autosave never changes.
        const byCreated = orderBy?.some((o) => "createdAt" in o);
        const created = (d: DesignRow) => (d.createdAt ?? new Date(0)).getTime();
        return h.designs
          .filter((d) => matches(d, where))
          .sort(byCreated ? (a, b) => created(b) - created(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1))
          .slice(0, take)
          .map((d) => selectFrom(d, select));
      }),
      create: vi.fn(async ({ data, select }: { data: Omit<DesignRow, "id" | "version" | "updatedAt">; select: Record<string, Spec> }) => {
        h.log.push(h.inTx && !h.viaTx ? "write:design:OUTSIDE" : "write:design");
        const row: DesignRow = { id: `design-${h.designs.length + 1}`, version: 1, updatedAt: new Date(2026, 0, 1, 0, 0, ++h.clock), createdAt: new Date(2026, 0, 3, 0, 0, h.clock), ...data };
        // The database's own rules: the shape of each kind, and a base revision that exists (the foreign key).
        const bad = shapeError(row);
        if (bad) throw Object.assign(new Error(bad), { code: "P2004" });
        if (row.baseRevisionId && !h.revisions.some((r) => r.id === row.baseRevisionId)) throw Object.assign(new Error("Foreign key constraint failed on the field: `Design_baseRevisionId_fkey`"), { code: "P2003" });
        h.designs.push(row);
        if (h.inTx && !h.viaTx) h.outsideDesigns.push(row); // committed on its own: the transaction's rollback cannot take it back
        return selectFrom(row, select);
      }),
      findFirst: vi.fn(async ({ where, select }: { where: Where; select: Record<string, Spec> }) => {
        trace("design.findFirst");
        const row = h.designs.find((d) => matches(d, where));
        return row ? selectFrom(row, select) : null;
      }),
      // Counts rows, like Prisma. Only what the routes ask: instances pinned to a design's revisions.
      count: vi.fn(async ({ where }: { where: Where }) => {
        trace("design.count");
        return h.designs.filter((d) => matches(d, where)).length;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: { document?: unknown; overrides?: unknown; name?: string; archivedAt?: Date; version?: { increment: number } } & Record<string, unknown> }) => {
        h.log.push("write:design.update");
        const row = h.designs.find((d) => matches(d, where));
        if (!row) return { count: 0 };
        // Design_archived_frozen: once archived, no UPDATE of any kind (no edit, no restore, no second archive).
        if (row.archivedAt) throw triggerError(`An archived design cannot be changed (design ${row.id}).`);
        // The pin trigger: a kind or a base revision never changes after the insert.
        if (("baseRevisionId" in data && data.baseRevisionId !== row.baseRevisionId) || ("kind" in data && data.kind !== row.kind)) {
          throw Object.assign(new Error("A design's kind and base revision cannot be changed"), { code: "P2010" });
        }
        const next: DesignRow = { ...row };
        if ("document" in data) next.document = data.document;
        if ("overrides" in data) next.overrides = data.overrides;
        if (data.name !== undefined) next.name = data.name;
        if (data.archivedAt !== undefined) next.archivedAt = data.archivedAt;
        const bad = shapeError(next); // the check constraints are enforced on every update
        if (bad) throw Object.assign(new Error(bad), { code: "P2004" });
        Object.assign(row, next);
        if (data.version) row.version += data.version.increment; // archiving does not bump the version
        row.updatedAt = new Date(2026, 0, 1, 0, 0, ++h.clock);
        return { count: 1 };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        h.log.push("write:design.delete");
        const gone = h.designs.filter((d) => matches(d, where));
        // The foreign keys (NO ACTION): a design whose revisions an instance or a submission pins cannot be deleted, and an
        // instance that has a submission cannot be deleted either.
        for (const d of gone) {
          const fk = designReferenced(d);
          if (fk) throw fkError(fk);
        }
        h.designs = h.designs.filter((d) => !gone.includes(d));
        return { count: gone.length };
      }),
    },
    // ── Phase 6: snapshots and reviews ──
    designSubmission: {
      create: vi.fn(async ({ data, select }: { data: Omit<SubmissionRow, "id" | "createdAt">; select: Sel }) => {
        h.log.push("write:submission");
        // The foreign keys, the unique keys, and the shape NOT NULL columns give.
        if (!h.designs.some((d) => d.id === data.instanceId)) throw fkError("DesignSubmission_instanceId_fkey");
        if (!h.revisions.some((r) => r.id === data.baseRevisionId)) throw fkError("DesignSubmission_baseRevisionId_fkey");
        if (h.submissions.some((s) => s.instanceId === data.instanceId && (s.number === data.number || s.instanceVersion === data.instanceVersion))) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        for (const k of ["workspaceId", "instanceId", "name", "baseRevisionId", "overrides", "document", "submittedByUserId"] as const) if (data[k] === undefined || data[k] === null) throw Object.assign(new Error(`Null constraint violation on ${k}`), { code: "P2011" });
        const row: SubmissionRow = { id: `sub-${h.submissions.length + 1}`, createdAt: new Date(2026, 0, 5, 0, 0, ++h.clock), ...data, note: data.note ?? null };
        h.submissions.push(row);
        return projectSubmission(row, select);
      }),
      findFirst: vi.fn(async ({ where, orderBy, select }: { where: SubWhere; orderBy?: { number: "desc" }; select: Sel }) => {
        trace("designSubmission.findFirst");
        const rows = h.submissions.filter((s) => subMatches(s, where));
        if (orderBy) rows.sort((a, b) => b.number - a.number);
        return rows[0] ? projectSubmission(rows[0], select) : null;
      }),
      findMany: vi.fn(async ({ where, orderBy, take, select }: { where: SubWhere; orderBy?: { number: "desc" }; take?: number; select: Sel }) => {
        trace("designSubmission.findMany");
        const rows = h.submissions.filter((s) => subMatches(s, where));
        if (orderBy) rows.sort((a, b) => b.number - a.number);
        return rows.slice(0, take).map((s) => projectSubmission(s, select));
      }),
      count: vi.fn(async ({ where }: { where: SubWhere }) => {
        trace("designSubmission.count");
        return h.submissions.filter((s) => subMatches(s, where)).length;
      }),
      // Triggers: a submission is never updated or deleted. Nothing in the routes may call these; they fail loudly if one does.
      update: vi.fn(async () => {
        throw triggerError("A design submission cannot be changed");
      }),
      updateMany: vi.fn(async () => {
        throw triggerError("A design submission cannot be changed");
      }),
      delete: vi.fn(async () => {
        throw triggerError("A design submission cannot be deleted");
      }),
      deleteMany: vi.fn(async () => {
        throw triggerError("A design submission cannot be deleted");
      }),
    },
    designReviewRequest: {
      create: vi.fn(async ({ data, select }: { data: Partial<ReviewRow> & { workspaceId: string; submissionId: string; status: string }; select: Sel }) => {
        h.log.push("write:review");
        if (!h.submissions.some((s) => s.id === data.submissionId)) throw fkError("DesignReviewRequest_submissionId_fkey");
        const row: ReviewRow = { id: `rev-req-${h.reviews.length + 1}`, pendingInstanceId: null, comment: null, decidedByUserId: null, decidedAt: null, createdAt: new Date(2026, 0, 5, 0, 0, ++h.clock), ...data };
        const bad = reviewCheck(row);
        if (bad) throw Object.assign(new Error(bad), { code: "P2004" });
        if (h.reviews.some((r) => r.submissionId === row.submissionId) || (row.pendingInstanceId !== null && h.reviews.some((r) => r.pendingInstanceId === row.pendingInstanceId))) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        h.reviews.push(row);
        return projectReview(row, select);
      }),
      updateMany: vi.fn(async ({ where, data }: { where: ReviewWhere; data: Partial<ReviewRow> }) => {
        h.log.push("write:review.update");
        const row = h.reviews.find((r) => reviewMatches(r, where));
        if (!row) return { count: 0 };
        // DesignReviewRequest_guard_update: only a pending request changes, only to a decided or superseded one, and its identity never does.
        if (row.status !== "pending") throw triggerError(`A design review that is no longer pending cannot be changed (review ${row.id}).`);
        const next: ReviewRow = { ...row, ...data };
        if (next.status === "pending" || next.id !== row.id || next.workspaceId !== row.workspaceId || next.submissionId !== row.submissionId || next.createdAt !== row.createdAt) throw triggerError("A pending design review can only be decided or superseded");
        const bad = reviewCheck(next);
        if (bad) throw Object.assign(new Error(bad), { code: "P2004" });
        Object.assign(row, next);
        return { count: 1 };
      }),
      findFirst: vi.fn(async ({ where, orderBy, select }: { where: ReviewWhere; orderBy?: unknown; select: Sel }) => {
        trace("designReviewRequest.findFirst");
        const rows = h.reviews.filter((r) => reviewMatches(r, where));
        if (orderBy) rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
        return rows[0] ? projectReview(rows[0], select) : null;
      }),
      findMany: vi.fn(async ({ where, orderBy, take, select }: { where: ReviewWhere; orderBy?: unknown; take?: number; select: Sel }) => {
        trace("designReviewRequest.findMany");
        const rows = h.reviews.filter((r) => reviewMatches(r, where));
        if (orderBy) rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
        return rows.slice(0, take).map((r) => projectReview(r, select));
      }),
      count: vi.fn(async ({ where }: { where: ReviewWhere }) => h.reviews.filter((r) => reviewMatches(r, where)).length),
      update: vi.fn(async () => {
        throw new Error("the review routes must use updateMany with status: pending in the where");
      }),
      delete: vi.fn(async () => {
        throw triggerError("A design review cannot be deleted");
      }),
      deleteMany: vi.fn(async () => {
        throw triggerError("A design review cannot be deleted");
      }),
    },
    workspaceMember: {
      count: vi.fn(async ({ where }: { where: { workspaceId: string; role: string } }) => h.members.filter((m) => m.workspaceId === where.workspaceId && m.role === where.role).length),
    },
    user: {
      findMany: vi.fn(async ({ where, select }: { where: { id: { in: string[] } }; select: Sel }) => h.users.filter((u) => where.id.in.includes(u.id)).map((u) => pickRow(u, select))),
    },
    template: {
      // `designId: undefined` means no condition; `null` means "has no design", like Prisma.
      findFirst: vi.fn(async ({ where, select }: { where: { id?: string; workspaceId?: string; designId?: string | null; published?: boolean; category?: { not: null } }; select: Record<string, Spec> }) => {
        refuseNul(where.id, where.designId);
        trace("template.findFirst");
        const t = h.templates.find(
          (x) =>
            (where.id === undefined || x.id === where.id) &&
            (where.workspaceId === undefined || x.workspaceId === where.workspaceId) &&
            (where.designId === undefined || (x.designId ?? null) === where.designId) &&
            (where.published === undefined || x.published === where.published) &&
            (where.category === undefined || x.category !== null), // `category: { not: null }`
        );
        return t ? selectTemplate(t, select) : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; workspaceId: string; designId?: null }; data: { designId?: string | null; published?: boolean } }) => {
        h.log.push("write:template");
        if (h.attachRaces && typeof data.designId === "string") throw Object.assign(new Error("Unique constraint failed on the fields: (`designId`)"), { code: "P2002" });
        const t = h.templates.find((x) => x.id === where.id && x.workspaceId === where.workspaceId && (where.designId === undefined || x.designId === null));
        if (!t) return { count: 0 };
        if ("designId" in data) t.designId = data.designId ?? null;
        if (data.published !== undefined) t.published = data.published;
        return { count: 1 };
      }),
    },
    designRevision: {
      findFirst: vi.fn(async ({ where, orderBy, select }: { where: { designId?: string; id?: string; designVersion?: number }; orderBy?: { number: "desc" }; select: Record<string, boolean> }) => {
        trace("designRevision.findFirst");
        const rows = h.revisions.filter((r) => (where.designId === undefined || r.designId === where.designId) && (where.id === undefined || r.id === where.id) && (where.designVersion === undefined || r.designVersion === where.designVersion));
        if (orderBy) rows.sort((a, b) => b.number - a.number);
        return rows[0] ? pick(rows[0], select) : null;
      }),
      create: vi.fn(async ({ data, select }: { data: Omit<RevisionRow, "id" | "createdAt">; select: Record<string, boolean> }) => {
        h.log.push("write:revision");
        // The two unique keys of the table: (designId, number) and (designId, designVersion).
        if (h.revisions.some((r) => r.designId === data.designId && (r.number === data.number || r.designVersion === data.designVersion))) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        const row: RevisionRow = { id: `rev-${h.revisions.length + 1}`, createdAt: new Date(2026, 0, 2, 0, 0, ++h.clock), ...data };
        h.revisions.push(row);
        return pick(row, select);
      }),
    },
    // SELECT ... FOR UPDATE: the row's id when it exists in this workspace (and, for a design, is a template), else nothing.
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      refuseNul(...values);
      const sql = strings.join("?");
      if (sql.includes('FROM "Template"')) {
        h.log.push("lock:template");
        h.onLock?.("template"); // whoever held the lock has committed by the time we get it
        const [id, workspaceId] = values;
        return h.templates.some((t) => t.id === id && t.workspaceId === workspaceId) ? [{ id }] : [];
      }
      // Phase 6: the lock on MY instance (any state, archived included), read back with its archivedAt.
      if (sql.includes('FROM "Design"') && sql.includes('"createdByUserId"')) {
        h.log.push("lock:instance");
        h.onLock?.("instance");
        const [id, workspaceId, kind, userId] = values;
        const d = h.designs.find((x) => x.id === id && x.workspaceId === workspaceId && x.kind === kind && x.createdByUserId === userId);
        return d ? [{ archivedAt: d.archivedAt ?? null }] : [];
      }
      // The newest submission of each listed instance, with its review (DISTINCT ON in the real query).
      if (sql.includes("DISTINCT ON")) {
        const [ids] = values as [string[]];
        return ids.flatMap((instanceId) => {
          const newest = h.submissions.filter((s) => s.instanceId === instanceId).sort((a, b) => b.number - a.number)[0];
          if (!newest) return [];
          const r = h.reviews.find((x) => x.submissionId === newest.id);
          return [{ instanceId, id: newest.id, number: newest.number, instanceVersion: newest.instanceVersion, name: newest.name, overrides: newest.overrides, createdAt: newest.createdAt, reviewId: r?.id ?? null, status: r?.status ?? null, comment: r?.comment ?? null, decidedAt: r?.decidedAt ?? null }];
        });
      }
      if (sql.includes('FROM "Design"')) {
        h.log.push("lock:design");
        h.onLock?.("design");
        const [id, workspaceId, kind] = values;
        return h.designs.some((d) => d.id === id && d.workspaceId === workspaceId && d.kind === kind) ? [{ id }] : [];
      }
      throw new Error(`unexpected raw query: ${sql}`);
    }),
  };
  return {
    prisma: {
      ...client,
      // A transaction runs its callback with its OWN client over the same store. If the callback throws, everything written
      // through that client is put back (a ROLLBACK); a write made through the plain client meanwhile is not (it committed).
      $transaction: vi.fn(async (run: (tx: typeof client) => Promise<unknown>) => {
        h.log.push("tx:begin");
        h.inTx = true;
        h.outsideDesigns = [];
        h.outsideSubmissions = [];
        const saved = { designs: h.designs.map((d) => ({ ...d })), templates: h.templates.map((t) => ({ ...t })), revisions: h.revisions.slice(), submissions: h.submissions.slice(), reviews: h.reviews.map((r) => ({ ...r })) };
        const through = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
          h.viaTx = true;
          try {
            return await fn(...a);
          } finally {
            h.viaTx = false;
          }
        };
        const tx = {
          ...client,
          design: { ...client.design, create: through(client.design.create) },
          template: { ...client.template, updateMany: through(client.template.updateMany), findFirst: through(client.template.findFirst) },
        } as typeof client;
        try {
          return await run(tx);
        } catch (err) {
          h.designs = [...saved.designs, ...h.outsideDesigns];
          h.templates = saved.templates;
          h.revisions = saved.revisions;
          h.submissions = [...saved.submissions, ...h.outsideSubmissions];
          h.reviews = saved.reviews;
          h.log.push("tx:rollback");
          throw err;
        } finally {
          h.inTx = false;
          h.log.push("tx:end");
        }
      }),
    },
  };
});
vi.mock("../lib/auth/withAuth.js", () => ({
  withAuth: async (_req: unknown, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!h.authed) return reply.status(401).send({ error: "Unauthorized" });
  },
  getUser: () => ({ id: h.userId }),
  getWorkspaceId: () => {
    if (!h.workspace) throw new Error("no workspace");
    return h.workspace;
  },
  // Same answer as the real one: only the designer role may manage templates (and so designs).
  requireTemplateManagerRole: async () => (h.role === "designer" ? null : { error: "Templates are managed by the design team only.", code: "FORBIDDEN" }),
  // And the real content-editor gate (Marketing): owner, admin and member only. A designer or an unknown role is refused.
  requireContentEditorRole: async () => (h.role === "owner" || h.role === "admin" || h.role === "member" ? null : { error: "Content is created and edited by Admin and Marketing only.", code: "FORBIDDEN" }),
}));

import { canvasRoutes } from "./canvas.js";
import { prisma } from "../lib/prisma.js";
import { BLANK_DOCUMENT } from "../lib/canvas.js";
import { LocalDiskStorage } from "../lib/storage.js";

type Fn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as {
  design: Record<"findMany" | "create" | "findFirst" | "updateMany" | "deleteMany" | "count", Fn>;
  designAsset: { count: Fn; findFirst: Fn };
  template: Record<"findFirst" | "updateMany", Fn>;
  designRevision: Record<"findFirst" | "create", Fn>;
  designSubmission: Record<"create" | "findFirst" | "findMany" | "count" | "update" | "updateMany" | "delete" | "deleteMany", Fn>;
  designReviewRequest: Record<"create" | "updateMany" | "findFirst" | "findMany" | "count" | "update" | "delete" | "deleteMany", Fn>;
  workspaceMember: { count: Fn };
  user: { findMany: Fn };
  $transaction: Fn;
  $queryRaw: Fn;
};

let dir: string;
let app: FastifyInstance;
let storage: LocalDiskStorage;

const png = () => sharp({ create: { width: 12, height: 8, channels: 3, background: "#ff5c00" } }).png().toBuffer();

/** A multipart body with one file field, built by hand so the test needs no form-data dependency. */
function upload(file: Buffer, filename = "a.png", type = "image/png") {
  const boundary = "----canvastest";
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
  const payload = Buffer.concat([head, file, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { method: "POST" as const, url: "/canvas/assets", payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function build(s: LocalDiskStorage | object): Promise<FastifyInstance> {
  const a = Fastify();
  await a.register(multipart);
  // `gate: false`: these route tests mock authentication, and their ~300 cookie-less requests would otherwise be counted by the
  // Canvas auth gate (lib/canvasAuthGate.ts), which has its own test file and is exercised with the real guard there.
  await a.register(canvasRoutes, { storage: s, gate: false } as never);
  await a.ready();
  return a;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-routes-"));
  storage = new LocalDiskStorage(dir);
  app = await build(storage);
});
afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  h.authed = true;
  h.workspace = "ws-1";
  h.role = "designer";
  h.rows = [];
  h.designs = [];
  h.templates = [];
  h.revisions = [];
  h.submissions = [];
  h.reviews = [];
  h.members = [{ workspaceId: "ws-1", userId: "designer-1", role: "designer" }]; // a workspace has a designer unless a test says otherwise
  h.users = [{ id: "designer-1", name: "Dana Designer" }, { id: "user-1", name: "Mia Marketing" }];
  h.log = [];
  h.inTx = false;
  h.attachRaces = false;
  h.viaTx = false;
  h.outsideDesigns = [];
  h.userId = "user-1";
  h.onLock = null;
  h.clock = 0;
  h.createFails = false;
  for (const fn of [...Object.values(db.design), ...Object.values(db.template), ...Object.values(db.designRevision), ...Object.values(db.designSubmission), ...Object.values(db.designReviewRequest), db.workspaceMember.count, db.user.findMany, db.$transaction, db.$queryRaw]) fn.mockClear();
  db.designAsset.count.mockClear();
  db.designAsset.findFirst.mockClear();
});

describe("POST /canvas/assets", () => {
  it("stores a PNG privately and answers with an API-relative url, never the storage path", async () => {
    const res = await app.inject(upload(await png()));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({ id: "asset-1", width: 12, height: 8, url: "/canvas/assets/asset-1/content" });

    const ref = h.rows[0].storageRef;
    expect(ref).toMatch(/^\/uploads\/\.canvas-private\/ws-1\/[\w-]+\.png$/);
    expect(fs.existsSync(path.join(dir, ref.replace(/^\/uploads\//, "")))).toBe(true);
    const text = res.body;
    expect(text).not.toContain("storageRef");
    expect(text).not.toContain(".canvas-private");
    expect(text).not.toContain("/uploads/");
    expect(body.url).not.toMatch(/^https?:|\/api\//);
  });

  it("imports an SVG as one PNG layer", async () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="#FF5C00"/></svg>`);
    const res = await app.inject(upload(svg, "logo.svg", "image/svg+xml"));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ width: 3072, height: 1536 });
  });

  it("rejects a non-PNG renamed .png, and stores nothing", async () => {
    const folder = path.join(dir, ".canvas-private", "ws-1");
    const count = () => (fs.existsSync(folder) ? fs.readdirSync(folder).length : 0);
    await app.inject(upload(await png())); // earlier tests share this folder, so compare before and after
    const before = count();
    h.rows = [];

    const res = await app.inject(upload(Buffer.from("<html><script>alert(1)</script></html>"), "evil.png", "image/png"));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "ASSET_REJECTED" });
    expect(h.rows).toHaveLength(0);
    expect(count()).toBe(before);
  });

  it("names the offending SVG element", async () => {
    const res = await app.inject(upload(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>1</script></svg>`), "a.svg", "image/svg+xml"));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("<script>");
  });

  it("answers 400 when no file is sent", async () => {
    const res = await app.inject({ method: "POST", url: "/canvas/assets", payload: "", headers: { "content-type": "multipart/form-data; boundary=x" } });
    expect(res.statusCode).toBe(400);
  });

  it("answers 401 when unauthenticated, before reading the body", async () => {
    h.authed = false;
    const res = await app.inject(upload(await png()));
    expect(res.statusCode).toBe(401);
    expect(h.rows).toHaveLength(0);
  });

  it("removes the stored file when the database insert fails", async () => {
    const folder = path.join(dir, ".canvas-private", "ws-1");
    const count = () => (fs.existsSync(folder) ? fs.readdirSync(folder).length : 0);
    await app.inject(upload(await png())); // a successful upload first, so the folder exists and the count is not trivially 0
    const before = count();
    expect(before).toBeGreaterThan(0);

    h.createFails = true;
    const res = await app.inject(upload(await png()));
    expect(res.statusCode).toBe(500);
    expect(count()).toBe(before); // the failed upload's file was removed, not orphaned
  });
});

describe("GET /canvas/assets/:id/content", () => {
  async function seed(workspaceId = "ws-1") {
    const bytes = await png();
    const storageRef = await storage.upload(bytes, "image/png", `.canvas-private/${workspaceId}`);
    h.rows.push({ id: "a1", workspaceId, storageRef });
    return bytes;
  }

  it("serves the bytes with private, no-store headers and no validators", async () => {
    const bytes = await seed();
    const res = await app.inject({ method: "GET", url: "/canvas/assets/a1/content" });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(bytes)).toBe(true);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-disposition"]).toBe("inline");
    expect(res.headers).not.toHaveProperty("etag");
    expect(res.headers).not.toHaveProperty("last-modified");
    expect(String(res.headers["cache-control"])).not.toMatch(/max-age|immutable|public/);
  });

  it("answers 404 for an asset in another workspace, with nothing about it", async () => {
    await seed("ws-2");
    const res = await app.inject({ method: "GET", url: "/canvas/assets/a1/content" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("ws-2");
    expect(res.body).not.toContain("canvas-private");
  });

  it("answers 404 for an unknown id", async () => {
    expect((await app.inject({ method: "GET", url: "/canvas/assets/nope/content" })).statusCode).toBe(404);
  });

  it("answers 404 when the row exists but the file is gone", async () => {
    h.rows.push({ id: "a1", workspaceId: "ws-1", storageRef: "/uploads/.canvas-private/ws-1/missing.png" });
    expect((await app.inject({ method: "GET", url: "/canvas/assets/a1/content" })).statusCode).toBe(404);
  });

  it("answers 401 when unauthenticated", async () => {
    await seed();
    h.authed = false;
    const res = await app.inject({ method: "GET", url: "/canvas/assets/a1/content" });
    expect(res.statusCode).toBe(401);
    expect(res.rawPayload.length).toBeLessThan(100);
  });

  describe("an id that cannot be an id (a NUL in the path made PostgreSQL throw, so the API answered 500)", () => {
    const BAD = [
      ["a NUL in the middle", "a%00b"],
      ["only a NUL", "%00"],
      ["a NUL at the end", "a1%00"],
      ["a space", "a%201"],
      ["a dot", "a.1"],
      ["a dot-dot", "..%2F..%2Fx"],
      ["an encoded slash", "a%2F1"],
      ["a backslash", "a%5C1"],
      ["non-ASCII letters", "%E6%97%A5%E6%9C%AC"],
      ["65 characters", "x".repeat(65)],
      ["a percent sign", "a%251"],
      ["a trailing line break", "a1%0A"],
    ] as const;
    const get = (id: string) => app.inject({ method: "GET", url: `/canvas/assets/${id}/content` });

    it.each(BAD)("%s: the same 404 as an unknown id, with no database query and no storage read", async (_label, id) => {
      await seed(); // a real asset "a1" exists, so a loose lookup could have matched something
      const read = vi.spyOn(storage, "getBuffer");
      try {
        const res = await get(id);
        expect(res.statusCode, id).toBe(404);
        expect(res.json()).toEqual({ error: "Asset not found" });
        expect(db.designAsset.findFirst).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    });

    it("is word for word the answer for a well-formed id that simply does not exist (which is looked up)", async () => {
      const bad = await get("a%00b");
      const unknown = await get("clnotthere0000000000000000");
      expect(bad.statusCode).toBe(404);
      expect(bad.body).toBe(unknown.body);
      expect(db.designAsset.findFirst).toHaveBeenCalledTimes(1); // only the well-formed one
    });

    it("asks who is calling first: signed out is 401 whatever the id, and nothing is queried", async () => {
      h.authed = false;
      for (const [, id] of BAD) expect((await get(id)).statusCode, id).toBe(401);
      expect(db.designAsset.findFirst).not.toHaveBeenCalled();
    });

    it("does not change who may read an asset: any member of the workspace, Marketing included, still can", async () => {
      const bytes = await seed();
      for (const role of ["member", "designer", "admin", "owner", null]) {
        h.role = role; // the asset route has no role gate: a role is not needed, only membership of the workspace
        const ok = await get("a1");
        expect(ok.statusCode, String(role)).toBe(200);
        expect(ok.rawPayload.equals(bytes)).toBe(true);
        expect((await get("a%00b")).statusCode, String(role)).toBe(404);
      }
    });

    it("still refuses another workspace's asset and still serves your own, by the same real-looking ids", async () => {
      const bytes = await png();
      const ids = ["clxyz0abc0000abcdefghijkl", "550e8400-e29b-41d4-a716-446655440000", "a_b-C9", "x".repeat(64)];
      for (const id of ids) {
        h.rows = [];
        const mine = await storage.upload(bytes, "image/png", ".canvas-private/ws-1");
        const theirs = await storage.upload(bytes, "image/png", ".canvas-private/ws-2");
        h.rows.push({ id, workspaceId: "ws-1", storageRef: mine }, { id: `${id.slice(0, 20)}-other`, workspaceId: "ws-2", storageRef: theirs });
        const res = await get(id);
        expect(res.statusCode, id).toBe(200);
        expect(res.rawPayload.equals(bytes), id).toBe(true);
        expect(res.headers["cache-control"]).toBe("private, no-store");
        expect((await get(`${id.slice(0, 20)}-other`)).statusCode, id).toBe(404); // someone else's, by a well-formed id
      }
    });
  });
});

describe("upload, then download (LocalDiskStorage, no seeding)", () => {
  it("a PNG posted to the API is stored privately and comes back as the same valid PNG, to a member only", async () => {
    // 1. Upload through the real route.
    const posted = await app.inject(upload(await png()));
    expect(posted.statusCode).toBe(201);
    const asset = posted.json();
    expect(asset).toEqual({ id: "asset-1", width: 12, height: 8, url: "/canvas/assets/asset-1/content" });

    // 2. Nothing about where the file lives reaches the client.
    const storageRef = h.rows[0].storageRef;
    const storedName = path.basename(storageRef);
    for (const secret of [storageRef, storedName, ".canvas-private", "/uploads/", "storageRef"]) {
      expect(posted.body, secret).not.toContain(secret);
    }

    // 3. The file really is under the private directory, for this workspace, and holds a PNG.
    expect(storageRef).toMatch(/^\/uploads\/\.canvas-private\/ws-1\/[\w-]+\.png$/);
    const onDisk = path.join(dir, storageRef.replace(/^\/uploads\//, ""));
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);

    // 4. An authenticated member fetches it with the url the API returned, and gets valid PNG bytes.
    const got = await app.inject({ method: "GET", url: asset.url });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["cache-control"]).toBe("private, no-store");
    expect(got.rawPayload.equals(fs.readFileSync(onDisk))).toBe(true);
    expect(await sharp(got.rawPayload).metadata()).toMatchObject({ format: "png", width: 12, height: 8 });

    // 5. The same url gives nothing to a signed-out caller or to another workspace.
    h.authed = false;
    const signedOut = await app.inject({ method: "GET", url: asset.url });
    expect(signedOut.statusCode).toBe(401);
    expect(signedOut.rawPayload.length).toBeLessThan(100);
    h.authed = true;
    h.workspace = "ws-2";
    const otherWorkspace = await app.inject({ method: "GET", url: asset.url });
    expect(otherWorkspace.statusCode).toBe(404);
    expect(otherWorkspace.rawPayload.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });
});

describe("fail closed on storage that is not local disk", () => {
  it("answers 501 before auth, the database or storage are touched", async () => {
    const other = { upload: vi.fn(), getBuffer: vi.fn(), delete: vi.fn(), listFolder: vi.fn(), ownsUrl: vi.fn() };
    const closed = await build(other);
    h.authed = false; // proves the refusal does not depend on a session either
    h.rows.push({ id: "a1", workspaceId: "ws-1", storageRef: "https://cdn.example/x.png" });

    const post = await closed.inject(upload(await png()));
    const get = await closed.inject({ method: "GET", url: "/canvas/assets/a1/content" });
    await closed.close();

    for (const res of [post, get]) {
      expect(res.statusCode).toBe(501);
      expect(res.json()).toMatchObject({ code: "CANVAS_STORAGE_UNSUPPORTED" });
      expect(res.body).toMatch(/STORAGE_PROVIDER=local/);
    }
    expect(other.upload).not.toHaveBeenCalled();
    expect(other.getBuffer).not.toHaveBeenCalled();
    expect(other.delete).not.toHaveBeenCalled();
  });

  it("still answers 501 first for a malformed asset id, before the id is even looked at", async () => {
    const other = { upload: vi.fn(), getBuffer: vi.fn(), delete: vi.fn(), listFolder: vi.fn(), ownsUrl: vi.fn() };
    const closed = await build(other);
    h.authed = false;
    const res = await closed.inject({ method: "GET", url: "/canvas/assets/a%00b/content" });
    await closed.close();
    expect(res.statusCode).toBe(501);
    expect(db.designAsset.findFirst).not.toHaveBeenCalled();
    expect(other.getBuffer).not.toHaveBeenCalled();
  });

  it("still saves designs: only image bytes need local disk", async () => {
    const other = { upload: vi.fn(), getBuffer: vi.fn(), delete: vi.fn(), listFolder: vi.fn(), ownsUrl: vi.fn() };
    const closed = await build(other);
    const created = await closed.inject({ method: "POST", url: "/canvas/designs", payload: {} });
    const list = await closed.inject({ method: "GET", url: "/canvas/designs" });
    await closed.close();
    expect(created.statusCode).toBe(201);
    expect(list.statusCode).toBe(200);
    expect(other.upload).not.toHaveBeenCalled();
  });
});

// ── Designs ────────────────────────────────────────────────────────────────────────────────────────

const seedDesign = (over: Partial<DesignRow> = {}): DesignRow => {
  const row: DesignRow = {
    id: `d${h.designs.length + 1}`,
    workspaceId: "ws-1",
    kind: "template",
    name: "Spring sale",
    document: BLANK_DOCUMENT,
    version: 1,
    createdByUserId: "user-1",
    updatedAt: new Date(2026, 0, 1, 0, 0, ++h.clock),
    ...over,
  };
  h.designs.push(row);
  return row;
};
const imageDoc = (assetId: string) => ({
  ...BLANK_DOCUMENT,
  nodes: [
    {
      id: "i1", name: "Logo", parentId: null, x: 10, y: 10, width: 100, height: 100, rotation: 0, opacity: 1, visible: true,
      permission: "protected", type: "image", assetId, fit: "cover",
    },
  ],
});
const seedTemplate = (over: Partial<TemplateRow> = {}): TemplateRow => {
  const row: TemplateRow = { id: `t${h.templates.length + 1}`, workspaceId: "ws-1", category: "Case Study", linkUrl: null, published: false, designId: null, ...over };
  h.templates.push(row);
  return row;
};
const seedRevision = (designId: string, number: number, over: Partial<RevisionRow> = {}): RevisionRow => {
  const row: RevisionRow = { id: `r-${designId}-${number}`, designId, number, designVersion: number, document: BLANK_DOCUMENT, manifest: { schemaVersion: 1, fields: [] }, createdByUserId: "user-1", createdAt: new Date(2026, 0, 2, 0, 0, number), ...over };
  h.revisions.push(row);
  return row;
};
const FIGMA = "https://www.figma.com/design/AbC123/Case-study";
/** A text layer of a design, valid for the server's schema. */
const textLayer = (id: string, change: Record<string, unknown> = {}) => ({
  id, name: `Layer ${id}`, parentId: null, x: 0, y: 0, width: 200, height: 40, rotation: 0, opacity: 1, visible: true, permission: "protected",
  type: "text", text: "Hello", fontFamily: "Inter", fontSize: 24, fontStyle: "400", align: "left", lineHeight: 1.2, letterSpacing: 0, ...change,
});
const groupLayer = (id: string, change: Record<string, unknown> = {}) => ({
  id, name: `Layer ${id}`, parentId: null, x: 0, y: 0, width: 50, height: 50, rotation: 0, opacity: 1, visible: true, permission: "protected", type: "group", ...change,
});
const docOf = (...nodes: unknown[]) => ({ ...BLANK_DOCUMENT, nodes });
const put = (id: string, payload: unknown) => app.inject({ method: "PUT", url: `/canvas/designs/${id}`, payload: payload as object });
const publish = (id: string, payload: unknown = { version: 1 }) => app.inject({ method: "POST", url: `/canvas/designs/${id}/publish`, payload: payload as object });
const attach = (templateId: string, designId: string) => app.inject({ method: "PUT", url: `/canvas/templates/${templateId}/design`, payload: { designId } });
const detach = (templateId: string) => app.inject({ method: "DELETE", url: `/canvas/templates/${templateId}/design` });
/** What the log says about the order of two operations. */
const before = (a: string, b: string) => h.log.indexOf(a) !== -1 && h.log.indexOf(a) < h.log.indexOf(b);
const writes = () => db.design.create.mock.calls.length + db.design.updateMany.mock.calls.length + db.design.deleteMany.mock.calls.length;

describe("designs: who may use them", () => {
  const endpoints = [
    () => app.inject({ method: "GET", url: "/canvas/designs" }),
    () => app.inject({ method: "POST", url: "/canvas/designs", payload: {} }),
    () => app.inject({ method: "GET", url: "/canvas/designs/d1" }),
    () => put("d1", { version: 1, document: BLANK_DOCUMENT }),
    () => app.inject({ method: "DELETE", url: "/canvas/designs/d1" }),
    () => app.inject({ method: "POST", url: "/canvas/designs/d1/publish", payload: { version: 1 } }),
    () => app.inject({ method: "PUT", url: "/canvas/templates/t1/design", payload: { designId: "d1" } }),
    () => app.inject({ method: "POST", url: "/canvas/templates/t1/design", payload: {} }),
    () => app.inject({ method: "DELETE", url: "/canvas/templates/t1/design" }),
  ];
  const touchedNothing = () => {
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.template.findFirst).not.toHaveBeenCalled();
    expect(db.template.updateMany).not.toHaveBeenCalled();
    expect(db.designRevision.findFirst).not.toHaveBeenCalled();
    expect(db.designRevision.create).not.toHaveBeenCalled();
    expect(h.revisions).toHaveLength(0);
  };

  it("answers 401 on every endpoint when signed out, and touches nothing", async () => {
    seedDesign();
    h.authed = false;
    for (const call of endpoints) expect((await call()).statusCode).toBe(401);
    expect(h.designs).toHaveLength(1);
    expect(writes()).toBe(0);
    expect(db.design.findFirst).not.toHaveBeenCalled();
    touchedNothing();
  });

  it.each(["member", "owner", "admin", "viewer", null])("answers 403 on every endpoint for the %s role, and touches nothing", async (role) => {
    seedDesign();
    h.role = role;
    for (const call of endpoints) {
      const res = await call();
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(h.designs).toHaveLength(1);
    expect(h.designs[0]).toMatchObject({ version: 1, name: "Spring sale" });
    expect(writes()).toBe(0);
    expect(db.design.findMany).not.toHaveBeenCalled();
    expect(db.design.findFirst).not.toHaveBeenCalled();
    expect(db.designAsset.count).not.toHaveBeenCalled();
    touchedNothing();
  });
});

describe("POST /canvas/designs", () => {
  it("creates a blank design named 'Untitled design' in the caller's workspace, and answers with a summary only", async () => {
    const res = await app.inject({ method: "POST", url: "/canvas/designs", payload: {} }); // JSON with no name: what the editor sends
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json().design).sort()).toEqual(["id", "latestRevision", "name", "template", "updatedAt", "version"]);
    expect(res.json().design).toMatchObject({ name: "Untitled design", version: 1, template: null, latestRevision: null });
    expect(h.designs[0]).toMatchObject({ workspaceId: "ws-1", kind: "template", createdByUserId: "user-1", document: BLANK_DOCUMENT });
    expect(res.body).not.toContain("document");
  });

  it("trims a given name", async () => {
    const res = await app.inject({ method: "POST", url: "/canvas/designs", payload: { name: "  Spring sale  " } });
    expect(res.statusCode).toBe(201);
    expect(h.designs[0].name).toBe("Spring sale");
  });

  it.each([["empty", ""], ["only spaces", "   "], ["101 characters", "x".repeat(101)], ["a line break inside", "a\nb"], ["a control character", "a\u0000b"], ["null", null], ["a number", 5]])(
    "refuses a name that is %s with INVALID_NAME, and creates nothing",
    async (_label, name) => {
      const res = await app.inject({ method: "POST", url: "/canvas/designs", payload: { name } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_NAME" });
      expect(h.designs).toHaveLength(0);
      expect(db.design.create).not.toHaveBeenCalled();
    },
  );

  it("never lets the client choose the kind, the workspace or the author", async () => {
    for (const extra of [{ kind: "instance" }, { workspaceId: "ws-2" }, { createdByUserId: "someone" }]) {
      const res = await app.inject({ method: "POST", url: "/canvas/designs", payload: { name: "A", ...extra } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(h.designs).toHaveLength(0);
  });

  describe("only a JSON object creates a design (a request that is not one must not quietly become a blank design)", () => {
    const post = (headers: Record<string, string>, payload?: string | Buffer) => app.inject({ method: "POST", url: "/canvas/designs", headers, payload });
    const refusedAndNothingCreated = () => {
      expect(h.designs).toHaveLength(0);
      expect(db.design.create).not.toHaveBeenCalled();
    };

    it("accepts a JSON body with no name, with or without a charset, and still names it 'Untitled design'", async () => {
      for (const type of ["application/json", "application/json; charset=utf-8", "Application/JSON"]) {
        const res = await post({ "content-type": type }, "{}");
        expect(res.statusCode, type).toBe(201);
        expect(res.json().design.name).toBe("Untitled design");
      }
      expect(h.designs).toHaveLength(3);
    });

    it("refuses a request with no body and no content type with 415", async () => {
      const res = await app.inject({ method: "POST", url: "/canvas/designs" });
      expect(res.statusCode).toBe(415);
      expect(res.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
      refusedAndNothingCreated();
    });

    it("refuses a multipart upload (what @fastify/multipart lets through untouched) with 415", async () => {
      const boundary = "----designs";
      const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nSpring sale\r\n--${boundary}--\r\n`);
      const res = await post({ "content-type": `multipart/form-data; boundary=${boundary}` }, body);
      expect(res.statusCode).toBe(415);
      expect(res.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
      refusedAndNothingCreated();
    });

    it.each([
      ["a plain-text body that looks like JSON", "text/plain", "{}"],
      ["a plain-text body with a name", "text/plain;charset=UTF-8", '{"name":"x"}'],
      ["a urlencoded form (what a cross-site <form> sends)", "application/x-www-form-urlencoded", "name=x"],
      ["a content type that only contains 'json'", "application/jsonp", "{}"],
      ["a JSON-looking suffix type", "application/vnd.api+json", "{}"],
      ["an empty content type", "", "{}"],
    ])("refuses %s with 415", async (_label, type, payload) => {
      const res = await post(type ? { "content-type": type } : {}, payload);
      expect(res.statusCode).toBe(415);
      refusedAndNothingCreated();
    });

    it.each([
      ["null", "null"],
      ["an array", "[]"],
      ["a string", '"x"'],
      ["a number", "5"],
    ])("refuses JSON that is %s with 400 and creates nothing (it is not defaulted to {})", async (_label, payload) => {
      const res = await post({ "content-type": "application/json" }, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_REQUEST" });
      refusedAndNothingCreated();
    });

    it("refuses an empty body and malformed JSON sent as JSON with 400, and creates nothing", async () => {
      expect((await post({ "content-type": "application/json" }, "")).statusCode).toBe(400);
      expect((await post({ "content-type": "application/json" }, "{")).statusCode).toBe(400);
      refusedAndNothingCreated();
    });

    it("checks who is asking before it looks at the content type: 401 signed out, 403 for anyone but a designer", async () => {
      h.authed = false;
      expect((await app.inject({ method: "POST", url: "/canvas/designs" })).statusCode).toBe(401);
      h.authed = true;
      h.role = "member";
      const res = await app.inject({ method: "POST", url: "/canvas/designs" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
      refusedAndNothingCreated();
    });
  });
});

describe("design ids that cannot be ids (a NUL in the path made PostgreSQL throw, so the API answered 500)", () => {
  const BAD = [
    ["a NUL in the middle", "a%00b"],
    ["only a NUL", "%00"],
    ["a NUL at the end", "abc%00"],
    ["a space", "a%20b"],
    ["a dot", "a.b"],
    ["an encoded slash", "a%2Fb"],
    ["a backslash", "a%5Cb"],
    ["non-ASCII letters", "%E6%97%A5%E6%9C%AC"],
    ["65 characters", "x".repeat(65)],
    ["a percent sign", "a%25b"],
  ] as const;
  const calls = (id: string) => [
    ["GET", () => app.inject({ method: "GET", url: `/canvas/designs/${id}` })],
    ["PUT", () => app.inject({ method: "PUT", url: `/canvas/designs/${id}`, payload: { version: 1, document: BLANK_DOCUMENT } })],
    ["DELETE", () => app.inject({ method: "DELETE", url: `/canvas/designs/${id}` })],
  ] as const;

  it.each(BAD)("%s: 404 on GET, PUT and DELETE, with no query made and nothing changed", async (_label, id) => {
    seedDesign({ id: "d1" });
    for (const [method, call] of calls(id)) {
      const res = await call();
      expect(res.statusCode, `${method} ${id}`).toBe(404);
      expect(res.json()).toEqual({ error: "Design not found" }); // the same answer as an unknown id
    }
    expect(db.design.findFirst).not.toHaveBeenCalled();
    expect(db.design.updateMany).not.toHaveBeenCalled();
    expect(db.design.deleteMany).not.toHaveBeenCalled();
    expect(db.designAsset.count).not.toHaveBeenCalled();
    expect(h.designs).toHaveLength(1);
    expect(h.designs[0]).toMatchObject({ id: "d1", version: 1 });
  });

  it("a PUT with a bad id and an image in the document does not even check the asset", async () => {
    const res = await app.inject({ method: "PUT", url: "/canvas/designs/a%00b", payload: { version: 1, document: { ...BLANK_DOCUMENT, nodes: [{ id: "i1", name: "L", parentId: null, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, visible: true, permission: "protected", type: "image", assetId: "asset-1", fit: "cover" }] } } });
    expect(res.statusCode).toBe(404);
    expect(db.designAsset.count).not.toHaveBeenCalled();
  });

  it("still tells a signed-out caller 401 and a non-designer 403 first, so an id's shape is not learned without being allowed", async () => {
    h.authed = false;
    for (const [, call] of calls("a%00b")) expect((await call()).statusCode).toBe(401);
    h.authed = true;
    h.role = "member";
    for (const [, call] of calls("a%00b")) expect((await call()).statusCode).toBe(403);
    expect(db.design.findFirst).not.toHaveBeenCalled();
  });

  it("every id a design can really have still works: cuid, uuid, dashes and underscores, 64 characters", async () => {
    for (const id of ["clxyz0abc0000abcdefghijkl", "550e8400-e29b-41d4-a716-446655440000", "a_b-C9", "x".repeat(64)]) {
      h.designs = [];
      seedDesign({ id });
      expect((await app.inject({ method: "GET", url: `/canvas/designs/${id}` })).statusCode, id).toBe(200);
      expect((await put(id, { version: 1, document: BLANK_DOCUMENT })).statusCode, id).toBe(200);
      expect((await app.inject({ method: "DELETE", url: `/canvas/designs/${id}` })).statusCode, id).toBe(200);
    }
  });

  it("a well-formed id that does not exist is still a plain 404 (it is looked up)", async () => {
    const res = await app.inject({ method: "GET", url: "/canvas/designs/clnotthere0000000000000000" });
    expect(res.statusCode).toBe(404);
    expect(db.design.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe("GET /canvas/designs", () => {
  it("lists this workspace's designs, newest edit first, with no documents and no caching", async () => {
    seedDesign({ id: "old", name: "Old" });
    seedDesign({ id: "other-ws", workspaceId: "ws-2", name: "Not mine" });
    seedDesign({ id: "instance", kind: "instance", name: "An instance" });
    seedDesign({ id: "new", name: "New" });
    const res = await app.inject({ method: "GET", url: "/canvas/designs" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { designs } = res.json();
    expect(designs.map((d: { id: string }) => d.id)).toEqual(["new", "old"]);
    for (const d of designs) expect(Object.keys(d).sort()).toEqual(["id", "latestRevision", "name", "template", "updatedAt", "version"]);
    expect(res.body).not.toContain("document");
    expect(res.body).not.toContain("Not mine");
  });

  it("shows at most the newest 200", async () => {
    for (let i = 0; i < 205; i++) seedDesign({ id: `d${String(i).padStart(3, "0")}` });
    const { designs } = (await app.inject({ method: "GET", url: "/canvas/designs" })).json();
    expect(designs).toHaveLength(200);
    expect(designs[0].id).toBe("d204");
  });
});

describe("GET /canvas/designs/:id", () => {
  it("returns the design with its document, not cached", async () => {
    seedDesign({ id: "d1", document: imageDoc("asset-1") });
    const res = await app.inject({ method: "GET", url: "/canvas/designs/d1" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().design).toMatchObject({ id: "d1", name: "Spring sale", version: 1, document: imageDoc("asset-1") });
  });

  it("answers 404 for another workspace's design, an instance, and an unknown id", async () => {
    seedDesign({ id: "other-ws", workspaceId: "ws-2" });
    seedDesign({ id: "instance", kind: "instance" });
    for (const id of ["other-ws", "instance", "nope"]) {
      const res = await app.inject({ method: "GET", url: `/canvas/designs/${id}` });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("ws-2");
    }
  });
});

describe("PUT /canvas/designs/:id", () => {
  const edited = { ...BLANK_DOCUMENT, background: { color: "#112233" } };

  it("saves the document, bumps the version in one conditional update, and answers with the new version", async () => {
    seedDesign({ id: "d1" });
    const res = await put("d1", { version: 1, document: edited });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: 2 });
    expect(h.designs[0]).toMatchObject({ version: 2, document: edited, name: "Spring sale" });
    // The write names the version it was based on (the optimistic lock) and the caller's own workspace and kind.
    expect(db.design.updateMany).toHaveBeenCalledTimes(1);
    expect(db.design.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "d1", workspaceId: "ws-1", kind: "template", version: 1 },
      data: { version: { increment: 1 } },
    });
    // No read-back: a second read could return somebody else's later save, which the editor would take for its own.
    expect(db.design.findFirst).not.toHaveBeenCalled();
  });

  it("saves in sequence: versions 1 to 2 to 3", async () => {
    seedDesign({ id: "d1" });
    expect((await put("d1", { version: 1, document: edited })).json()).toEqual({ version: 2 });
    expect((await put("d1", { version: 2, document: BLANK_DOCUMENT })).json()).toEqual({ version: 3 });
    expect(h.designs[0]).toMatchObject({ version: 3, document: BLANK_DOCUMENT });
  });

  it("answers 409 VERSION_CONFLICT for a stale version, and writes nothing", async () => {
    seedDesign({ id: "d1", version: 5, document: BLANK_DOCUMENT });
    const res = await put("d1", { version: 4, document: edited });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(res.body).not.toContain("document"); // nothing of the stored design leaks into the refusal
    expect(h.designs[0]).toMatchObject({ version: 5, document: BLANK_DOCUMENT });
    const ahead = await put("d1", { version: 6, document: edited }); // a version from the future is no better
    expect(ahead.statusCode).toBe(409);
    expect(h.designs[0].version).toBe(5);
  });

  it("two saves from the same version: the first wins, the second is refused", async () => {
    seedDesign({ id: "d1" });
    expect((await put("d1", { version: 1, document: edited })).statusCode).toBe(200);
    const second = await put("d1", { version: 1, document: { ...BLANK_DOCUMENT, background: { color: "#999999" } } });
    expect(second.statusCode).toBe(409);
    expect(h.designs[0].document).toEqual(edited);
  });

  it("renames with a trimmed name, saves a name-only change, and keeps the name when none is sent", async () => {
    seedDesign({ id: "d1" });
    await put("d1", { version: 1, document: BLANK_DOCUMENT, name: "  Summer  " }); // same document, new name
    expect(h.designs[0]).toMatchObject({ name: "Summer", version: 2 });
    await put("d1", { version: 2, document: edited }); // no name
    expect(h.designs[0]).toMatchObject({ name: "Summer", version: 3 });
    expect(db.design.updateMany.mock.calls[1][0].data).not.toHaveProperty("name");
  });

  it.each([["empty", ""], ["only spaces", "   "], ["101 characters", "x".repeat(101)], ["a line break inside", "a\nb"], ["null", null], ["a number", 5]])(
    "refuses a name that is %s with INVALID_NAME, and writes nothing",
    async (_label, name) => {
      seedDesign({ id: "d1" });
      const res = await put("d1", { version: 1, document: edited, name });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_NAME" });
      expect(h.designs[0]).toMatchObject({ version: 1, name: "Spring sale", document: BLANK_DOCUMENT });
      expect(db.design.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["an unknown key on a layer", { ...BLANK_DOCUMENT, nodes: [{ ...imageDoc("asset-1").nodes[0], url: "https://evil.example/x.png" }] }],
    ["an unknown key on the document", { ...BLANK_DOCUMENT, href: "https://evil.example" }],
    ["a number past its limit", { ...BLANK_DOCUMENT, nodes: [{ ...imageDoc("asset-1").nodes[0], width: 20_001 }] }],
    ["an asset id that is a URL", imageDoc("https://evil.example/x.png")],
    ["an asset id with a path", imageDoc("../../user/me")],
    ["another schema version", { ...BLANK_DOCUMENT, schemaVersion: 2 }],
    ["text with a NUL", { ...BLANK_DOCUMENT, nodes: [{ ...imageDoc("a").nodes[0], type: "text", text: "a\u0000b", fontFamily: "Inter", fontSize: 20, fontStyle: "400", align: "left", lineHeight: 1.2, letterSpacing: 0, assetId: undefined, fit: undefined }] }],
  ])("refuses %s with INVALID_DOCUMENT, and writes nothing", async (_label, document) => {
    seedDesign({ id: "d1" });
    h.rows.push({ id: "asset-1", workspaceId: "ws-1", storageRef: "x" });
    const res = await put("d1", { version: 1, document });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_DOCUMENT" });
    expect(res.json().error).toMatch(/^document/); // names where the problem is
    expect(h.designs[0]).toMatchObject({ version: 1, document: BLANK_DOCUMENT });
    expect(db.design.updateMany).not.toHaveBeenCalled();
  });

  it("never lets the client choose the kind or the workspace, and needs a whole version", async () => {
    seedDesign({ id: "d1" });
    for (const body of [{ version: 1, document: edited, kind: "instance" }, { version: 1, document: edited, workspaceId: "ws-2" }, { document: edited }, { version: "1", document: edited }, { version: 0, document: edited }]) {
      const res = await put("d1", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(writes()).toBe(0);
  });

  // Phase 7: the PUT takes only JSON, like its POST sibling (it was the one design write that did not). A request with no body, a
  // form or multipart post, or plain text is refused by the JSON guard (a preHandler, so the body is already parsed) and writes nothing: nothing can be saved by a cross-site form post.
  // (The "no body at all" case used to be a 400 INVALID_REQUEST above; it is now this stronger refusal.)
  it.each([
    ["no body and no content type", undefined, {}],
    ["plain text", "{}", { "content-type": "text/plain" }],
    ["a form post", "version=1", { "content-type": "application/x-www-form-urlencoded" }],
    ["multipart", "--x--", { "content-type": "multipart/form-data; boundary=x" }],
  ])("refuses %s with 415 and writes nothing (the same guard as POST /canvas/designs)", async (label, payload, headers) => {
    seedDesign({ id: "d1" });
    const res = await app.inject({ method: "PUT", url: "/canvas/designs/d1", ...(payload ? { payload } : {}), headers });
    expect(res.statusCode).toBe(415);
    // a form post has no parser in this app, so Fastify itself refuses it (its own body); every other case is our guard
    if (label !== "a form post") expect(res.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
    expect(writes()).toBe(0);
  });

  it("a JSON body is still read exactly as before (the guard changes nothing for the editor, which always sends JSON)", async () => {
    seedDesign({ id: "d1" });
    const res = await put("d1", { version: 1, document: edited });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: 2 });
  });

  it("checks on every save that each image is an asset of this workspace", async () => {
    seedDesign({ id: "d1" });
    h.rows.push({ id: "asset-mine", workspaceId: "ws-1", storageRef: "x" }, { id: "asset-theirs", workspaceId: "ws-2", storageRef: "y" });

    const theirs = await put("d1", { version: 1, document: imageDoc("asset-theirs") });
    expect(theirs.statusCode).toBe(400);
    expect(theirs.json()).toMatchObject({ code: "UNKNOWN_ASSET" });
    expect(theirs.body).not.toContain("asset-theirs");
    const invented = await put("d1", { version: 1, document: imageDoc("asset-made-up") });
    expect(invented.statusCode).toBe(400);
    expect(invented.json()).toMatchObject({ code: "UNKNOWN_ASSET" });
    expect(h.designs[0].version).toBe(1);

    const mine = await put("d1", { version: 1, document: imageDoc("asset-mine") });
    expect(mine.statusCode).toBe(200);
    expect(db.designAsset.count).toHaveBeenLastCalledWith({ where: { id: { in: ["asset-mine"] }, workspaceId: "ws-1" } });
    // and again on the next save, not only the first
    db.designAsset.count.mockClear();
    expect((await put("d1", { version: 2, document: imageDoc("asset-mine") })).statusCode).toBe(200);
    expect(db.designAsset.count).toHaveBeenCalledTimes(1);
  });

  it("asks about each asset once, and not at all for a design with no image", async () => {
    seedDesign({ id: "d1" });
    await put("d1", { version: 1, document: BLANK_DOCUMENT });
    expect(db.designAsset.count).not.toHaveBeenCalled();
  });

  it("answers 404 for another workspace's design, an instance and an unknown id, and writes nothing", async () => {
    seedDesign({ id: "other-ws", workspaceId: "ws-2" });
    seedDesign({ id: "instance", kind: "instance" });
    for (const id of ["other-ws", "instance", "nope"]) expect((await put(id, { version: 1, document: edited })).statusCode).toBe(404);
    expect(h.designs.map((d) => d.version)).toEqual([1, 1]);
    expect(h.designs[0].document).toEqual(BLANK_DOCUMENT);
  });

  it("refuses a body over 1 MB with 413, and writes nothing", async () => {
    seedDesign({ id: "d1" });
    const res = await put("d1", { version: 1, document: { ...BLANK_DOCUMENT, source: { kind: "x".repeat(1_100_000) } } });
    expect(res.statusCode).toBe(413);
    expect(db.design.updateMany).not.toHaveBeenCalled();
  });
});

describe("DELETE /canvas/designs/:id", () => {
  it("deletes the caller's design", async () => {
    seedDesign({ id: "d1" });
    const res = await app.inject({ method: "DELETE", url: "/canvas/designs/d1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(h.designs).toHaveLength(0);
    expect(db.design.deleteMany.mock.calls[0][0]).toEqual({ where: { id: "d1", workspaceId: "ws-1", kind: "template" } });
  });

  it("answers 404 and deletes nothing for another workspace's design, an instance and an unknown id", async () => {
    seedDesign({ id: "other-ws", workspaceId: "ws-2" });
    seedDesign({ id: "instance", kind: "instance" });
    for (const id of ["other-ws", "instance", "nope"]) expect((await app.inject({ method: "DELETE", url: `/canvas/designs/${id}` })).statusCode).toBe(404);
    expect(h.designs).toHaveLength(2);
  });
});

// ── Phase 4: the design list, linked designs, revisions and the template link ───────────────────────────────────

describe("the design list and a single design carry their template and latest revision", () => {
  it("a design with no template and no revision says so, in the list and in GET one", async () => {
    seedDesign({ id: "d1" });
    const list = (await app.inject({ method: "GET", url: "/canvas/designs" })).json().designs[0];
    expect(list).toMatchObject({ id: "d1", template: null, latestRevision: null });
    const one = (await app.inject({ method: "GET", url: "/canvas/designs/d1" })).json().design;
    expect(one).toMatchObject({ template: null, latestRevision: null, document: BLANK_DOCUMENT });
  });

  it("shows the template it is attached to and the newest of its revisions, and nothing else of either", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1", designId: "d1", published: true, linkUrl: FIGMA });
    seedRevision("d1", 1);
    seedRevision("d1", 2);
    const { designs } = (await app.inject({ method: "GET", url: "/canvas/designs" })).json();
    expect(designs[0].template).toEqual({ id: "t1", category: "Case Study", published: true });
    expect(Object.keys(designs[0].latestRevision).sort()).toEqual(["createdAt", "designVersion", "number"]);
    expect(designs[0].latestRevision.number).toBe(2);
    expect(JSON.stringify(designs)).not.toContain("manifest");
    expect(JSON.stringify(designs)).not.toContain("linkUrl");
    expect(JSON.stringify(designs)).not.toContain("workspaceId");
  });
});

describe("DELETE /canvas/designs/:id: a design a template is made from cannot be deleted", () => {
  it("answers 409 DESIGN_LINKED, deletes nothing, and keeps the revisions", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1", designId: "d1" });
    seedRevision("d1", 1);
    const res = await app.inject({ method: "DELETE", url: "/canvas/designs/d1" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "DESIGN_LINKED" });
    expect(db.design.deleteMany).not.toHaveBeenCalled();
    expect(h.designs).toHaveLength(1);
    expect(h.revisions).toHaveLength(1);
  });

  it("the foreign key is the backstop: a link made after the check (P2003) is the same 409, not a 500", async () => {
    seedDesign({ id: "d1" });
    db.design.deleteMany.mockRejectedValueOnce(Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" }));
    const res = await app.inject({ method: "DELETE", url: "/canvas/designs/d1" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "DESIGN_LINKED" });
  });

  it("any other database error is still an error", async () => {
    seedDesign({ id: "d1" });
    db.design.deleteMany.mockRejectedValueOnce(new Error("db down"));
    expect((await app.inject({ method: "DELETE", url: "/canvas/designs/d1" })).statusCode).toBe(500);
  });

  it("an unlinked design is deleted, with the check scoped to this workspace", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "elsewhere", workspaceId: "ws-2", designId: "d1" }); // another workspace's row never blocks this one
    expect((await app.inject({ method: "DELETE", url: "/canvas/designs/d1" })).statusCode).toBe(200);
    expect(db.template.findFirst.mock.calls[0][0].where).toEqual({ designId: "d1", workspaceId: "ws-1" });
  });
});

describe("POST /canvas/designs/:id/publish", () => {
  const editable = () => docOf(textLayer("t", { permission: "text" }), textLayer("p"));

  it("freezes the STORED document, derives the manifest itself, numbers the revision and records who published it", async () => {
    seedDesign({ id: "d1", version: 3, document: editable() });
    const res = await publish("d1", { version: 3 });
    expect(res.statusCode).toBe(201);
    expect(res.json().revision).toMatchObject({ number: 1, designVersion: 3 });
    expect(Object.keys(res.json().revision).sort()).toEqual(["createdAt", "designVersion", "number"]);
    expect(h.revisions).toHaveLength(1);
    expect(h.revisions[0]).toMatchObject({ designId: "d1", number: 1, designVersion: 3, createdByUserId: "user-1", document: editable(), manifest: { schemaVersion: 1, fields: [{ nodeId: "t", kind: "text" }] } });
    // The design itself is not touched: publishing only adds a row.
    expect(h.designs[0].version).toBe(3);
    expect(db.design.updateMany).not.toHaveBeenCalled();
  });

  it("the next revision is numbered after the last one, and each working version is published once", async () => {
    seedDesign({ id: "d1", version: 1, document: editable() });
    expect((await publish("d1", { version: 1 })).statusCode).toBe(201);
    expect((await publish("d1", { version: 1 })).json()).toMatchObject({ code: "NO_CHANGES" }); // same version again
    h.designs[0].version = 2;
    const second = await publish("d1", { version: 2 });
    expect(second.json().revision).toMatchObject({ number: 2, designVersion: 2 });
    expect(h.revisions.map((r) => r.number)).toEqual([1, 2]);
    expect(h.revisions[0]).toMatchObject({ designVersion: 1 }); // the first one is exactly as it was
  });

  it("never overwrites a revision: the only write is an insert, and nothing updates or deletes one", async () => {
    seedDesign({ id: "d1", version: 1, document: editable() });
    seedRevision("d1", 1, { designVersion: 7 });
    const first = structuredClone(h.revisions[0]);
    await publish("d1", { version: 1 });
    expect(h.revisions[0]).toEqual(first);
    expect(Object.keys(db.designRevision).sort()).toEqual(["create", "findFirst"]); // no update, delete or upsert exists for the route to call
  });

  it("answers 409 VERSION_CONFLICT for a version that is not the stored one, and writes nothing", async () => {
    seedDesign({ id: "d1", version: 4, document: editable() });
    const res = await publish("d1", { version: 3 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(h.revisions).toHaveLength(0);
  });

  it("locks the design's row first, and reads and writes only inside the transaction", async () => {
    seedDesign({ id: "d1", version: 1, document: editable() });
    await publish("d1", { version: 1 });
    expect(h.log[0]).toBe("tx:begin");
    expect(h.log[1]).toBe("lock:design");
    expect(h.log.filter((x) => x.startsWith("out:"))).toEqual([]);
    expect(before("lock:design", "tx:design.findFirst")).toBe(true);
    expect(before("tx:design.findFirst", "write:revision")).toBe(true);
    expect(h.log.at(-1)).toBe("tx:end");
  });

  it("refuses an editable layer that is hidden, and names it; nothing is written", async () => {
    seedDesign({ id: "d1", version: 1, document: docOf(textLayer("t", { permission: "text", visible: false, name: "Headline" })) });
    const res = await publish("d1", { version: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_PUBLISH" });
    expect(res.json().error).toContain('"Headline" is editable but hidden');
    expect(h.revisions).toHaveLength(0);
  });

  it("refuses an editable layer inside a hidden group, and names the layer and the group", async () => {
    seedDesign({ id: "d1", version: 1, document: docOf(groupLayer("g", { visible: false, name: "Hero" }), textLayer("t", { permission: "text", parentId: "g", name: "Title" })) });
    const res = await publish("d1", { version: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('"Title" is editable but hidden because its group "Hero" is hidden');
    expect(h.revisions).toHaveLength(0);
  });

  it("a hidden layer that is protected does not block a publish", async () => {
    seedDesign({ id: "d1", version: 1, document: docOf(textLayer("p", { visible: false }), textLayer("t", { permission: "text" })) });
    expect((await publish("d1", { version: 1 })).statusCode).toBe(201);
    expect(h.revisions[0].manifest).toEqual({ schemaVersion: 1, fields: [{ nodeId: "t", kind: "text" }] });
  });

  it("a design with nothing editable can still be published (the manifest is empty)", async () => {
    seedDesign({ id: "d1", version: 1 });
    expect((await publish("d1", { version: 1 })).statusCode).toBe(201);
    expect(h.revisions[0].manifest).toEqual({ schemaVersion: 1, fields: [] });
  });

  it("checks the images again: an asset of another workspace or a made-up one is UNKNOWN_ASSET, nothing is written", async () => {
    h.rows = [{ id: "mine", workspaceId: "ws-1", storageRef: "x" }, { id: "theirs", workspaceId: "ws-2", storageRef: "y" }];
    for (const assetId of ["theirs", "made-up"]) {
      h.designs = [];
      seedDesign({ id: "d1", version: 1, document: imageDoc(assetId) });
      const res = await publish("d1", { version: 1 });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "UNKNOWN_ASSET" });
    }
    expect(h.revisions).toHaveLength(0);
    h.designs = [];
    seedDesign({ id: "d1", version: 1, document: imageDoc("mine") });
    expect((await publish("d1", { version: 1 })).statusCode).toBe(201);
  });

  it("validates the stored document again, so a bad stored row is not frozen", async () => {
    seedDesign({ id: "d1", version: 1, document: { schemaVersion: 2, nodes: [] } });
    const res = await publish("d1", { version: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_DOCUMENT" });
    expect(h.revisions).toHaveLength(0);
  });

  it.each([
    ["a document", { version: 1, document: BLANK_DOCUMENT }],
    ["a manifest", { version: 1, manifest: { schemaVersion: 1, fields: [{ nodeId: "p", kind: "text" }] } }],
    ["a number", { version: 1, number: 99 }],
    ["a design id", { version: 1, designId: "d2" }],
    ["an author", { version: 1, createdByUserId: "someone" }],
    ["a workspace", { version: 1, workspaceId: "ws-2" }],
    ["a kind", { version: 1, kind: "instance" }],
    ["no version", {}],
    ["a zero version", { version: 0 }],
    ["a text version", { version: "1" }],
  ])("refuses a body with %s (a client chooses nothing but the version), and writes nothing", async (_label, payload) => {
    seedDesign({ id: "d1", version: 1, document: editable() });
    const res = await publish("d1", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(h.revisions).toHaveLength(0);
  });

  it("answers 415 for a body that is not JSON", async () => {
    seedDesign({ id: "d1", version: 1, document: editable() });
    const res = await app.inject({ method: "POST", url: "/canvas/designs/d1/publish", headers: { "content-type": "text/plain" }, payload: '{"version":1}' });
    expect(res.statusCode).toBe(415);
    expect(h.revisions).toHaveLength(0);
  });

  it("answers 404 for another workspace's design, an instance, an unknown id and a bad id; nothing is written", async () => {
    seedDesign({ id: "other-ws", workspaceId: "ws-2", document: editable() });
    seedDesign({ id: "instance", kind: "instance", document: editable() });
    for (const id of ["other-ws", "instance", "nope", "a%00b", "a%20b"]) expect((await publish(id)).statusCode, id).toBe(404);
    expect(h.revisions).toHaveLength(0);
  });

  it("a race past the check ends in the table's unique keys: P2002 is a 409, never a 500", async () => {
    seedDesign({ id: "d1", version: 1, document: editable() });
    db.designRevision.create.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    const res = await publish("d1", { version: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NO_CHANGES" });
  });
});

describe("PUT /canvas/templates/:id/design (attach)", () => {
  it("links a design to a draft that has no source yet (a draft is prepared before it is published)", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1" });
    const res = await attach("t1", "d1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ designId: "d1" });
    expect(h.templates[0].designId).toBe("d1");
  });

  it("locks the template first and then the design, reads and writes only inside the transaction, and writes last", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1" });
    await attach("t1", "d1");
    expect(h.log.filter((x) => x.startsWith("lock:"))).toEqual(["lock:template", "lock:design"]); // never the other way round
    expect(h.log[0]).toBe("tx:begin");
    expect(before("lock:template", "lock:design")).toBe(true);
    expect(before("lock:design", "tx:template.findFirst")).toBe(true); // the reads come after both locks
    expect(before("lock:design", "write:template")).toBe(true);
    expect(h.log.filter((x) => x.startsWith("out:"))).toEqual([]);
    expect(h.log.at(-1)).toBe("tx:end");
  });

  it("the design lock is scoped to the workspace and to template designs", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1" });
    await attach("t1", "d1");
    const lock = db.$queryRaw.mock.calls.find(([s]: [TemplateStringsArray]) => s.join("?").includes('FROM "Design"'))!;
    expect(lock.slice(1)).toEqual(["d1", "ws-1", "template"]);
    expect(lock[0].join("?")).toContain("FOR UPDATE");
  });

  it("answers 409 DESIGN_LINKED when the design already belongs to another template, and writes nothing", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1", designId: "d1" });
    seedTemplate({ id: "t2", category: "Blog Post" });
    const res = await attach("t2", "d1");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "DESIGN_LINKED" });
    expect(db.template.updateMany).not.toHaveBeenCalled();
    expect(h.templates[1].designId).toBeNull();
  });

  it("answers 409 TEMPLATE_HAS_DESIGN when the template already has a design: replacing means removing the link first", async () => {
    seedDesign({ id: "d1" });
    seedDesign({ id: "d2" });
    seedTemplate({ id: "t1", designId: "d1" });
    const res = await attach("t1", "d2");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "TEMPLATE_HAS_DESIGN" });
    expect(h.templates[0].designId).toBe("d1");
    expect(db.template.updateMany).not.toHaveBeenCalled();
  });

  describe("two requests for the same design at the same moment", () => {
    it("the second one's check, made after both locks, sees the first one's committed link: 409, no write", async () => {
      seedDesign({ id: "d1" });
      seedTemplate({ id: "t1" });
      seedTemplate({ id: "t2", category: "Blog Post" });
      expect((await attach("t1", "d1")).statusCode).toBe(200);
      h.log = [];
      const second = await attach("t2", "d1");
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ code: "DESIGN_LINKED" });
      expect(h.log).not.toContain("write:template"); // the re-check stopped it before any write
      expect(h.log.filter((x) => x.startsWith("lock:"))).toEqual(["lock:template", "lock:design"]);
      expect(h.templates.map((t) => t.designId)).toEqual(["d1", null]);
    });

    it("if both slip past the locks, the unique index decides: P2002 is 409 DESIGN_LINKED, not a 500", async () => {
      seedDesign({ id: "d1" });
      seedTemplate({ id: "t1" });
      h.attachRaces = true; // the write fails the way a unique violation on Template.designId does
      const res = await attach("t1", "d1");
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "DESIGN_LINKED" });
      expect(h.templates[0].designId).toBeNull();
    });

    it("any other error from the write is not hidden", async () => {
      seedDesign({ id: "d1" });
      seedTemplate({ id: "t1" });
      db.template.updateMany.mockRejectedValueOnce(new Error("db down"));
      expect((await attach("t1", "d1")).statusCode).toBe(500);
    });
  });

  describe("R4: attaching must not strand a published template", () => {
    it("a PUBLISHED legacy template with no link, and a design with no revision: refused, and the template is unchanged and still listed", async () => {
      seedDesign({ id: "d1" });
      seedTemplate({ id: "legacy", published: true, linkUrl: null });
      const res = await attach("legacy", "d1");
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "DESIGN_NEEDS_REVISION" });
      expect(res.json().error).toContain("Publish a revision of the design first");
      expect(db.template.updateMany).not.toHaveBeenCalled();
      expect(h.templates[0]).toMatchObject({ published: true, linkUrl: null, designId: null }); // not mutated: it keeps the status it had, and no design
    });

    it("the same for a published template whose link is not a Figma design (https://example.com is not a source)", async () => {
      seedDesign({ id: "d1" });
      seedTemplate({ id: "legacy", published: true, linkUrl: "https://example.com" });
      expect((await attach("legacy", "d1")).json()).toMatchObject({ code: "DESIGN_NEEDS_REVISION" });
      expect(h.templates[0]).toMatchObject({ published: true, designId: null });
    });

    it("the same for a blank or whitespace link", async () => {
      for (const linkUrl of ["", "   "]) {
        h.templates = [];
        h.designs = [];
        seedDesign({ id: "d1" });
        seedTemplate({ id: "legacy", published: true, linkUrl });
        expect((await attach("legacy", "d1")).json(), JSON.stringify(linkUrl)).toMatchObject({ code: "DESIGN_NEEDS_REVISION" });
      }
    });

    it("a published template WITH a valid Figma link may attach a design that has no revision (it stays listed through its link)", async () => {
      seedDesign({ id: "d1" });
      seedTemplate({ id: "t1", published: true, linkUrl: FIGMA });
      expect((await attach("t1", "d1")).statusCode).toBe(200);
      expect(h.templates[0]).toMatchObject({ published: true, linkUrl: FIGMA, designId: "d1" });
    });

    it("a DRAFT with no source may attach a design that has no revision", async () => {
      seedDesign({ id: "d1" });
      seedTemplate({ id: "t1", published: false, linkUrl: null });
      expect((await attach("t1", "d1")).statusCode).toBe(200);
    });

    it("a published legacy template may attach a design that already has a revision: it gains a real source", async () => {
      seedDesign({ id: "d1" });
      seedRevision("d1", 1);
      seedTemplate({ id: "legacy", published: true, linkUrl: null });
      expect((await attach("legacy", "d1")).statusCode).toBe(200);
      expect(h.templates[0]).toMatchObject({ published: true, designId: "d1" });
    });
  });

  it("answers 404 for a template or a design of another workspace, a design that is not a template one, or an unknown id", async () => {
    seedDesign({ id: "d1" });
    seedDesign({ id: "other-d", workspaceId: "ws-2" });
    seedDesign({ id: "instance", kind: "instance" });
    seedTemplate({ id: "t1" });
    seedTemplate({ id: "other-t", workspaceId: "ws-2" });
    for (const [t, d] of [["other-t", "d1"], ["t1", "other-d"], ["t1", "instance"], ["t1", "nope"], ["nope", "d1"]] as const) {
      expect((await attach(t, d)).statusCode, `${t} ${d}`).toBe(404);
    }
    expect(h.templates.map((t) => t.designId)).toEqual([null, null]);
    expect(db.template.updateMany).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed template id, and refuses a malformed or extra body, with nothing locked", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1" });
    expect((await attach("a%00b", "d1")).statusCode).toBe(404);
    for (const payload of [{}, { designId: "../x" }, { designId: "d1", published: true }, { designId: "d1", templateId: "t2" }, { designId: 5 }]) {
      const res = await app.inject({ method: "PUT", url: "/canvas/templates/t1/design", payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("DELETE /canvas/templates/:id/design (detach)", () => {
  it("detaches a draft's design and keeps the design and its revisions", async () => {
    seedDesign({ id: "d1" });
    seedRevision("d1", 1);
    seedTemplate({ id: "t1", designId: "d1", published: false });
    const res = await detach("t1");
    expect(res.statusCode).toBe(200);
    expect(h.templates[0].designId).toBeNull();
    expect(h.designs).toHaveLength(1);
    expect(h.revisions).toHaveLength(1);
    expect(db.design.deleteMany).not.toHaveBeenCalled();
  });

  it("locks the template first, then reads and writes inside the transaction", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1", designId: "d1" });
    await detach("t1");
    expect(h.log[0]).toBe("tx:begin");
    expect(h.log[1]).toBe("lock:template");
    expect(h.log).not.toContain("lock:design"); // detaching never takes the design's lock: no cycle is possible
    expect(h.log.filter((x) => x.startsWith("out:"))).toEqual([]);
  });

  it("R2: a published template whose only source is the Canvas revision cannot lose it (409 SOURCE_REQUIRED), and is unchanged", async () => {
    seedDesign({ id: "d1" });
    seedRevision("d1", 1);
    seedTemplate({ id: "t1", designId: "d1", published: true, linkUrl: null });
    const res = await detach("t1");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "SOURCE_REQUIRED" });
    expect(h.templates[0].designId).toBe("d1");
    expect(db.template.updateMany).not.toHaveBeenCalled();
  });

  it("R2: the same when the template's link is not a Figma design (it is not a source)", async () => {
    seedDesign({ id: "d1" });
    seedRevision("d1", 1);
    seedTemplate({ id: "t1", designId: "d1", published: true, linkUrl: "https://example.com" });
    expect((await detach("t1")).json()).toMatchObject({ code: "SOURCE_REQUIRED" });
  });

  it("a published template that also has a valid Figma link may detach (it keeps a source)", async () => {
    seedDesign({ id: "d1" });
    seedRevision("d1", 1);
    seedTemplate({ id: "t1", designId: "d1", published: true, linkUrl: FIGMA });
    expect((await detach("t1")).statusCode).toBe(200);
    expect(h.templates[0]).toMatchObject({ published: true, designId: null });
  });

  it("R3: a published template whose design has no revision and no Figma link had no source to lose, so it may detach", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1", designId: "d1", published: true, linkUrl: null }); // a state R4 now prevents, but one that must not be a trap
    expect((await detach("t1")).statusCode).toBe(200);
  });

  it("answers 404 for a template with no design, another workspace's template, and an unknown or bad id", async () => {
    seedTemplate({ id: "t1" });
    seedTemplate({ id: "other-t", workspaceId: "ws-2", designId: "d9" });
    for (const id of ["t1", "other-t", "nope", "a%00b"]) expect((await detach(id)).statusCode, id).toBe(404);
    expect(h.templates[1].designId).toBe("d9");
    expect(db.template.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST /canvas/templates/:id/design (create a design for a template, in one step)", () => {
  const createFor = (templateId: string, payload: unknown = {}) => app.inject({ method: "POST", url: `/canvas/templates/${templateId}/design`, payload: payload as object });

  it("creates a blank design named after the category and attaches it, and answers with the design", async () => {
    seedTemplate({ id: "t1", category: "Case Study" });
    const res = await createFor("t1");
    expect(res.statusCode).toBe(201);
    const { design } = res.json();
    expect(design).toMatchObject({ name: "Case Study", version: 1 });
    expect(h.designs).toHaveLength(1);
    expect(h.designs[0]).toMatchObject({ id: design.id, workspaceId: "ws-1", kind: "template", name: "Case Study", document: BLANK_DOCUMENT, createdByUserId: "user-1" });
    expect(h.templates[0].designId).toBe(design.id);
  });

  it("does everything in ONE transaction, template locked first, and links last", async () => {
    seedTemplate({ id: "t1" });
    await createFor("t1");
    expect(h.log[0]).toBe("tx:begin");
    expect(h.log[1]).toBe("lock:template");
    expect(h.log).not.toContain("lock:design"); // the design does not exist yet, so there is nothing to lock first
    expect(h.log.filter((x) => x.startsWith("out:"))).toEqual([]);
    expect(before("write:design", "write:template")).toBe(true);
    expect(h.log.at(-1)).toBe("tx:end");
  });

  it("a failure while linking leaves NO design behind: the transaction is rolled back", async () => {
    seedTemplate({ id: "t1" });
    db.template.updateMany.mockRejectedValueOnce(new Error("db down"));
    const res = await createFor("t1");
    expect(res.statusCode).toBe(500);
    expect(h.designs).toHaveLength(0); // the design that was created is gone with the rollback
    expect(h.templates[0].designId).toBeNull();
    expect(h.log).toContain("tx:rollback");
  });

  // Phase 7: this used to be a plain Error and so a 500. It is a conflict (the template changed under the request), so a 409 the
  // page can show; the rollback is unchanged and is the point: a refusal RETURNED from the transaction would have committed the design.
  it("a link that finds the template already taken in between is a 409 TEMPLATE_CHANGED, and rolls the new design back too", async () => {
    seedTemplate({ id: "t1" });
    db.template.updateMany.mockImplementationOnce(async () => ({ count: 0 })); // someone linked it after the check
    const res = await createFor("t1");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "TEMPLATE_CHANGED" });
    expect(h.designs).toHaveLength(0); // rolled back, not committed
    expect(h.templates[0].designId).toBeNull();
    expect(h.log).toContain("tx:rollback");
  });

  it("a real failure (not the race) is still a 500 and still rolls back", async () => {
    seedTemplate({ id: "t1" });
    db.template.updateMany.mockRejectedValueOnce(new Error("db down"));
    const res = await createFor("t1");
    expect(res.statusCode).toBe(500);
    expect(res.json()).not.toMatchObject({ code: "TEMPLATE_CHANGED" });
    expect(h.designs).toHaveLength(0);
  });

  it("a failure while creating the design changes nothing", async () => {
    seedTemplate({ id: "t1" });
    db.design.create.mockRejectedValueOnce(new Error("db down"));
    expect((await createFor("t1")).statusCode).toBe(500);
    expect(h.designs).toHaveLength(0);
    expect(h.templates[0].designId).toBeNull();
  });

  it("a template that already has a design: 409 TEMPLATE_HAS_DESIGN, and no second design is made", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1", designId: "d1" });
    const res = await createFor("t1");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "TEMPLATE_HAS_DESIGN" });
    expect(db.design.create).not.toHaveBeenCalled();
    expect(h.designs).toHaveLength(1);
  });

  it("R4: a PUBLISHED template with no usable source is refused (a new design has no revision), and nothing is created", async () => {
    for (const linkUrl of [null, "", "   ", "https://example.com"]) {
      h.templates = [];
      seedTemplate({ id: "legacy", published: true, linkUrl });
      const res = await createFor("legacy");
      expect(res.statusCode, JSON.stringify(linkUrl)).toBe(409);
      expect(res.json()).toMatchObject({ code: "DESIGN_NEEDS_REVISION" });
      expect(h.templates[0]).toMatchObject({ published: true, designId: null });
    }
    expect(db.design.create).not.toHaveBeenCalled();
    expect(h.designs).toHaveLength(0);
  });

  it("a published template WITH a valid Figma link may, and a draft with no source may", async () => {
    seedTemplate({ id: "fig", published: true, linkUrl: FIGMA });
    seedTemplate({ id: "draft", published: false, linkUrl: null, category: "Blog Post" });
    expect((await createFor("fig")).statusCode).toBe(201);
    expect((await createFor("draft")).statusCode).toBe(201);
    expect(h.designs.map((d) => d.name)).toEqual(["Case Study", "Blog Post"]);
  });

  it("answers 404 for another workspace's template, an unknown id and a bad id, and creates nothing", async () => {
    seedTemplate({ id: "other", workspaceId: "ws-2" });
    for (const id of ["other", "nope", "a%00b"]) expect((await createFor(id)).statusCode, id).toBe(404);
    expect(h.designs).toHaveLength(0);
  });

  it("the client sends nothing: any field (a name, a document, a design id, a workspace) is a 400, and nothing is created", async () => {
    seedTemplate({ id: "t1" });
    for (const payload of [{ name: "x" }, { document: BLANK_DOCUMENT }, { designId: "d9" }, { workspaceId: "ws-2" }, { kind: "instance" }, { createdByUserId: "u" }]) {
      expect((await createFor("t1", payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(h.designs).toHaveLength(0);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("answers 415 for a body that is not JSON", async () => {
    seedTemplate({ id: "t1" });
    const res = await app.inject({ method: "POST", url: "/canvas/templates/t1/design", headers: { "content-type": "text/plain" }, payload: "{}" });
    expect(res.statusCode).toBe(415);
    expect(h.designs).toHaveLength(0);
  });

  it("is for the design team only: 401 signed out, 403 for every other role, and nothing is touched", async () => {
    seedTemplate({ id: "t1" });
    h.authed = false;
    expect((await createFor("t1")).statusCode).toBe(401);
    h.authed = true;
    for (const role of ["member", "owner", "admin", "viewer", null]) {
      h.role = role;
      expect((await createFor("t1")).statusCode, String(role)).toBe(403);
    }
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(h.designs).toHaveLength(0);
  });

  it("the name is the category as the design-name rule accepts it (every category fits in 100 characters)", async () => {
    seedTemplate({ id: "t1", category: "Geospatial Insight/Expertise" });
    expect((await createFor("t1")).json().design.name).toBe("Geospatial Insight/Expertise");
  });
});

// ── Phase 5: Marketing's designs (instances) ──────────────────────────────────────────────────────────────────────

/** A published, Canvas-backed template whose design has the given revisions (revision 2, if asked, with other copy). */
function seedCampaign(opts: { published?: boolean; linkUrl?: string | null; revisions?: number } = {}) {
  const doc = (headline: string) =>
    docOf(
      textLayer("head", { permission: "text", text: headline }),
      { id: "photo", name: "Photo", parentId: null, x: 0, y: 0, width: 300, height: 200, rotation: 0, opacity: 1, visible: true, permission: "image", type: "image", assetId: "asset-1", fit: "cover" },
      textLayer("legal", { text: "Fixed legal text" }),
    );
  const manifest = { schemaVersion: 1, fields: [{ nodeId: "head", kind: "text" }, { nodeId: "photo", kind: "image" }] };
  const design = seedDesign({ id: "base" });
  const template = seedTemplate({ id: "tpl", designId: "base", published: opts.published ?? true, linkUrl: opts.linkUrl ?? null });
  const n = opts.revisions ?? 1;
  for (let i = 1; i <= n; i++) seedRevision("base", i, { document: doc(i === 1 ? "Headline one" : `Headline ${i}`), manifest });
  return { design, template, doc, manifest };
}
const customize = (templateId: string, payload: unknown = { templateId }) => app.inject({ method: "POST", url: "/canvas/instances", payload: payload as object });
const listInstances = (query = "") => app.inject({ method: "GET", url: `/canvas/instances${query}` });
const getInstance = (id: string) => app.inject({ method: "GET", url: `/canvas/instances/${id}` });
const putInstance = (id: string, payload: unknown) => app.inject({ method: "PUT", url: `/canvas/instances/${id}`, payload: payload as object });
const delInstance = (id: string) => app.inject({ method: "DELETE", url: `/canvas/instances/${id}` });
/** A Marketing design, as the database holds one. */
const seedInstance = (over: Partial<DesignRow> = {}): DesignRow =>
  seedDesign({ id: `i${h.designs.length + 1}`, kind: "instance", name: "Case Study", document: null, baseRevisionId: "r-base-1", overrides: { schemaVersion: 1, fields: [] }, createdAt: new Date(2026, 0, 3, 0, 0, ++h.clock), ...over });
const stored = (row: DesignRow) => (row.overrides as { fields: unknown[] }).fields;

describe("instances: who may use them", () => {
  const endpoints = [
    () => customize("tpl"),
    () => listInstances(),
    () => getInstance("i1"),
    () => putInstance("i1", { version: 1, overrides: [] }),
    () => delInstance("i1"),
  ];

  it("answers 401 when signed out, on every endpoint, and touches nothing", async () => {
    seedCampaign();
    seedInstance({ id: "i1" });
    h.authed = false;
    for (const call of endpoints) expect((await call()).statusCode).toBe(401);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.design.findFirst).not.toHaveBeenCalled();
    expect(db.design.findMany).not.toHaveBeenCalled();
    expect(db.design.updateMany).not.toHaveBeenCalled();
    expect(db.design.deleteMany).not.toHaveBeenCalled();
    expect(h.designs).toHaveLength(2);
  });

  it.each(["designer", "viewer", null])("answers 403 for the %s role, on every endpoint, and touches nothing: a designer makes templates, not designs from them", async (role) => {
    seedCampaign();
    seedInstance({ id: "i1" });
    h.role = role;
    for (const call of endpoints) {
      const res = await call();
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.design.findFirst).not.toHaveBeenCalled();
    expect(db.design.findMany).not.toHaveBeenCalled();
    expect(db.design.updateMany).not.toHaveBeenCalled();
    expect(db.design.deleteMany).not.toHaveBeenCalled();
    expect(h.designs).toHaveLength(2);
  });

  it.each(["member", "admin", "owner"])("the %s role may use its own designs", async (role) => {
    seedCampaign();
    h.role = role;
    const made = await customize("tpl");
    expect(made.statusCode).toBe(201);
    const id = made.json().instance.id;
    expect((await getInstance(id)).statusCode).toBe(200);
    expect((await putInstance(id, { version: 1, overrides: [] })).statusCode).toBe(200);
    expect((await listInstances()).json().instances).toHaveLength(1);
    expect((await delInstance(id)).statusCode).toBe(200);
  });

  describe("both directions between the two kinds of design", () => {
    it("a designer's routes never find an instance, and a Marketing route never finds a template design: all 404", async () => {
      seedCampaign();
      seedInstance({ id: "inst" });
      // A designer asks for the instance through the designer routes.
      h.role = "designer";
      expect((await app.inject({ method: "GET", url: "/canvas/designs/inst" })).statusCode).toBe(404);
      expect((await put("inst", { version: 1, document: BLANK_DOCUMENT })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: "/canvas/designs/inst" })).statusCode).toBe(404);
      expect((await publish("inst")).statusCode).toBe(404);
      expect((await attach("tpl", "inst")).statusCode).toBe(404);
      expect(h.designs.find((d) => d.id === "inst")).toBeDefined();
      // A member asks for the template's design through the Marketing routes.
      h.role = "member";
      expect((await getInstance("base")).statusCode).toBe(404);
      expect((await putInstance("base", { version: 1, overrides: [] })).statusCode).toBe(404);
      expect((await delInstance("base")).statusCode).toBe(404);
      expect(h.designs.find((d) => d.id === "base")).toMatchObject({ kind: "template", version: 1 });
    });

    it("and a designer on the Marketing routes, and a member on the designer routes, are 403 before any lookup", async () => {
      seedCampaign();
      seedInstance({ id: "inst" });
      h.role = "designer";
      expect((await getInstance("inst")).statusCode).toBe(403);
      h.role = "member";
      expect((await app.inject({ method: "GET", url: "/canvas/designs/base" })).statusCode).toBe(403);
    });
  });

  it("an id that cannot be an id is a 404 with no query, after the role check", async () => {
    h.role = "member";
    for (const id of ["a%00b", "a%20b", "x".repeat(65), "a%2Fb"]) {
      expect((await getInstance(id)).statusCode, id).toBe(404);
      expect((await putInstance(id, { version: 1, overrides: [] })).statusCode, id).toBe(404);
      expect((await delInstance(id)).statusCode, id).toBe(404);
    }
    expect(db.design.findFirst).not.toHaveBeenCalled();
    expect(db.design.deleteMany).not.toHaveBeenCalled();
  });
});

describe("instances are personal", () => {
  it("another user's instance is a 404 for read, save and delete, even for an owner, and nothing about it leaks", async () => {
    seedCampaign();
    seedInstance({ id: "theirs", createdByUserId: "user-2", overrides: { schemaVersion: 1, fields: [{ nodeId: "head", text: "Secret" }] } });
    for (const role of ["member", "admin", "owner"]) {
      h.role = role;
      const read = await getInstance("theirs");
      expect(read.statusCode, role).toBe(404);
      expect(read.body).not.toContain("Secret");
      expect((await putInstance("theirs", { version: 1, overrides: [] })).statusCode, role).toBe(404);
      expect((await delInstance("theirs")).statusCode, role).toBe(404);
    }
    expect(h.designs.find((d) => d.id === "theirs")).toMatchObject({ version: 1, overrides: { fields: [{ nodeId: "head", text: "Secret" }] } });
  });

  it("an instance of another workspace is a 404", async () => {
    seedCampaign();
    seedInstance({ id: "elsewhere", workspaceId: "ws-2" });
    h.role = "member";
    expect((await getInstance("elsewhere")).statusCode).toBe(404);
    expect((await putInstance("elsewhere", { version: 1, overrides: [] })).statusCode).toBe(404);
    expect((await delInstance("elsewhere")).statusCode).toBe(404);
  });

  it("every query names the workspace, the kind and the signed-in user, which come from the session and never from a request", async () => {
    seedCampaign();
    h.role = "member";
    h.userId = "user-9";
    const made = await customize("tpl", { templateId: "tpl" });
    const id = made.json().instance.id;
    await getInstance(id);
    await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "x" }] });
    await delInstance(id);
    const where = (fn: Fn) => fn.mock.calls.map(([a]: [{ where: Where }]) => a.where);
    for (const w of [...where(db.design.findFirst), ...where(db.design.updateMany), ...where(db.design.deleteMany)]) {
      expect(w).toMatchObject({ workspaceId: "ws-1", kind: "instance", createdByUserId: "user-9" });
    }
    expect(h.designs.find((d) => d.id === id)).toBeUndefined();
  });

  it("two people customize the same template and each sees only their own", async () => {
    seedCampaign();
    h.role = "member";
    h.userId = "alice";
    const a = (await customize("tpl")).json().instance.id;
    h.userId = "bob";
    const b = (await customize("tpl")).json().instance.id;
    expect((await listInstances()).json().instances.map((i: { id: string }) => i.id)).toEqual([b]);
    h.userId = "alice";
    expect((await listInstances()).json().instances.map((i: { id: string }) => i.id)).toEqual([a]);
    expect((await getInstance(b)).statusCode).toBe(404);
  });
});

describe("POST /canvas/instances: customize a published template", () => {
  beforeEach(() => {
    h.role = "member";
  });

  it("creates an instance pinned to the latest revision, with no document, an empty override set and the session as author", async () => {
    seedCampaign({ revisions: 2 });
    const res = await customize("tpl");
    expect(res.statusCode).toBe(201);
    const { instance } = res.json();
    expect(Object.keys(instance).sort()).toEqual(["baseRevision", "createdAt", "id", "name", "version"]);
    expect(instance).toMatchObject({ name: "Case Study", version: 1, baseRevision: { number: 2 } });
    const row = h.designs.find((d) => d.id === instance.id)!;
    expect(row).toMatchObject({ kind: "instance", workspaceId: "ws-1", createdByUserId: "user-1", baseRevisionId: "r-base-2", overrides: { schemaVersion: 1, fields: [] } });
    expect(row.document ?? null).toBeNull();
    expect(res.body).not.toContain("document");
    expect(res.body).not.toContain("manifest");
  });

  it("works for a Canvas-only template and for one that has a Figma link as well", async () => {
    seedCampaign({ linkUrl: null });
    expect((await customize("tpl")).statusCode).toBe(201);
    h.templates[0].linkUrl = FIGMA;
    expect((await customize("tpl")).statusCode).toBe(201);
  });

  it("locks the template, reads it, locks its design, reads the latest revision, then inserts: all inside one transaction, never the other way round", async () => {
    seedCampaign({ revisions: 2 });
    await customize("tpl");
    expect(h.log.filter((x) => x.startsWith("lock:"))).toEqual(["lock:template", "lock:design"]);
    expect(h.log[0]).toBe("tx:begin");
    expect(before("lock:template", "tx:template.findFirst")).toBe(true); // nothing about the template is read before its lock
    expect(before("tx:template.findFirst", "lock:design")).toBe(true);
    expect(before("lock:design", "tx:designRevision.findFirst")).toBe(true); // the revision is read while the design is locked
    expect(before("tx:designRevision.findFirst", "write:design")).toBe(true);
    expect(h.log.filter((x) => x.startsWith("out:"))).toEqual([]);
    expect(h.log.at(-1)).toBe("tx:end");
    expect(h.log).not.toContain("tx:rollback");
  });

  it("the design lock is scoped to the workspace and to template designs, and the template read asks for a PUBLISHED one", async () => {
    seedCampaign();
    await customize("tpl");
    const lock = db.$queryRaw.mock.calls.find(([s]: [TemplateStringsArray]) => s.join("?").includes('FROM "Design"'))!;
    expect(lock.slice(1)).toEqual(["base", "ws-1", "template"]);
    expect(lock[0].join("?")).toContain("FOR UPDATE");
    expect(db.template.findFirst.mock.calls[0][0].where).toMatchObject({ id: "tpl", workspaceId: "ws-1", published: true });
  });

  it("the client names the template and nothing else: no revision, kind, workspace or author", async () => {
    seedCampaign();
    for (const extra of ["baseRevisionId", "revisionId", "kind", "workspaceId", "createdByUserId", "document", "overrides"]) {
      const res = await customize("tpl", { templateId: "tpl", [extra]: "x" });
      expect(res.statusCode, extra).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
    for (const bad of [{}, { templateId: "" }, { templateId: 5 }, { templateId: "a\u0000b" }, []]) expect((await customize("tpl", bad)).statusCode).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(h.designs.filter((d) => d.kind === "instance")).toHaveLength(0);
  });

  it("only a JSON request creates one (a form post, which needs no preflight, must not)", async () => {
    seedCampaign();
    const res = await app.inject({ method: "POST", url: "/canvas/instances", payload: "templateId=tpl", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(res.statusCode).toBe(415);
    expect(h.designs.filter((d) => d.kind === "instance")).toHaveLength(0);
  });

  describe("a template that cannot be customized", () => {
    it.each([
      ["a Draft", { published: false }],
    ])("%s is a 404 'Template not found', the same as one that does not exist, and its design is never even locked", async (_label, opts) => {
      seedCampaign(opts);
      const res = await customize("tpl");
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "Template not found" });
      expect(h.log.filter((x) => x.startsWith("lock:"))).toEqual(["lock:template"]);
      expect(db.design.create).not.toHaveBeenCalled();
    });

    it("a missing, foreign-workspace or malformed template is the same 404", async () => {
      seedCampaign();
      seedTemplate({ id: "other", workspaceId: "ws-2", published: true, designId: "base" });
      for (const id of ["nope", "other", "a%00b"]) {
        const res = await customize("tpl", { templateId: id.includes("%") ? "a\u0000b" : id });
        expect([400, 404], id).toContain(res.statusCode);
        if (res.statusCode === 404) expect(res.json()).toEqual({ error: "Template not found" });
      }
      expect(h.designs.filter((d) => d.kind === "instance")).toHaveLength(0);
    });

    it("a published template with no Canvas design (Figma only, or a legacy row) is 409 NO_CANVAS_REVISION, and nothing is written", async () => {
      seedTemplate({ id: "figma", published: true, linkUrl: FIGMA });
      seedTemplate({ id: "legacy", published: true, linkUrl: null, category: "Blog Post" });
      for (const id of ["figma", "legacy"]) {
        const res = await customize(id);
        expect(res.statusCode, id).toBe(409);
        expect(res.json()).toMatchObject({ code: "NO_CANVAS_REVISION" });
      }
      expect(db.design.create).not.toHaveBeenCalled();
      expect(h.log).not.toContain("lock:design");
    });

    it("a published template whose design has no revision yet is 409 NO_CANVAS_REVISION", async () => {
      seedCampaign({ revisions: 0 });
      const res = await customize("tpl");
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "NO_CANVAS_REVISION" });
      expect(db.design.create).not.toHaveBeenCalled();
    });

    it("a design the template points at that is not in this workspace is not locked or used", async () => {
      seedDesign({ id: "foreign", workspaceId: "ws-2" });
      seedTemplate({ id: "tpl", designId: "foreign", published: true });
      seedRevision("foreign", 1);
      const res = await customize("tpl");
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "NO_CANVAS_REVISION" });
      expect(db.design.create).not.toHaveBeenCalled();
    });
  });

  describe("against an unpublish, a detach and a new revision at the same moment: the post-lock read decides", () => {
    // `onLock` is "the other transaction": it commits something while this one waits for the lock, so whatever the route
    // reads AFTER the lock sees it. A route that read before locking would use the old state.
    it("an unpublish that commits first: the creation waits, re-reads, and is a 404 with nothing written", async () => {
      seedCampaign();
      h.onLock = (which) => {
        if (which === "template") h.templates[0].published = false;
      };
      const res = await customize("tpl");
      expect(res.statusCode).toBe(404);
      expect(h.designs.filter((d) => d.kind === "instance")).toHaveLength(0);
      expect(h.log).not.toContain("lock:design");
    });

    it("a detach that commits first: 409, nothing written", async () => {
      seedCampaign();
      h.onLock = (which) => {
        if (which === "template") h.templates[0].designId = null;
      };
      const res = await customize("tpl");
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "NO_CANVAS_REVISION" });
      expect(h.designs.filter((d) => d.kind === "instance")).toHaveLength(0);
    });

    it("a revision published while the design lock was awaited: the instance pins the NEW latest, because it is read under that lock", async () => {
      seedCampaign({ revisions: 1 });
      h.onLock = (which) => {
        if (which === "design") seedRevision("base", 2);
      };
      const res = await customize("tpl");
      expect(res.statusCode).toBe(201);
      expect(res.json().instance.baseRevision.number).toBe(2);
      expect(h.designs.find((d) => d.id === res.json().instance.id)!.baseRevisionId).toBe("r-base-2");
    });

    it("creation that takes the lock first is valid, whatever happens to the template afterwards", async () => {
      seedCampaign();
      const res = await customize("tpl");
      expect(res.statusCode).toBe(201);
      h.templates[0].published = false; // the unpublish that was waiting
      expect(h.designs.find((d) => d.id === res.json().instance.id)).toBeDefined();
    });

    it("the design is deleted while the lock was awaited: 409, and nothing is created", async () => {
      seedCampaign();
      h.onLock = (which) => {
        if (which === "design") h.designs = h.designs.filter((d) => d.id !== "base");
      };
      const res = await customize("tpl");
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "NO_CANVAS_REVISION" });
    });
  });

  it("a failed insert is rolled back: no instance, and a foreign-key failure (the revision vanished) is a 409, not a 500", async () => {
    seedCampaign();
    db.design.create.mockRejectedValueOnce(Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" }));
    const res = await customize("tpl");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NO_CANVAS_REVISION" });
    expect(h.designs.filter((d) => d.kind === "instance")).toHaveLength(0);
    expect(h.log).toContain("tx:rollback");
  });

  it("any other error is not hidden", async () => {
    seedCampaign();
    db.design.create.mockRejectedValueOnce(new Error("db down"));
    expect((await customize("tpl")).statusCode).toBe(500);
  });

  it("the name is the category, cleaned by the design-name rule", async () => {
    seedCampaign();
    h.templates[0].category = "  Event \n Recap  ";
    const res = await customize("tpl");
    expect(res.statusCode).toBe(201);
    expect(res.json().instance.name).toBe("Untitled design"); // a category with a control character is not a valid name: the default
    h.templates[0].category = "Event Recap";
    expect((await customize("tpl")).json().instance.name).toBe("Event Recap");
  });
});

describe("an instance stays on the revision it was made from", () => {
  beforeEach(() => {
    h.role = "member";
  });

  it("a revision published afterwards does not change an existing instance: GET still returns the pinned document and manifest", async () => {
    const { doc } = seedCampaign({ revisions: 1 });
    const id = (await customize("tpl")).json().instance.id;
    seedRevision("base", 2, { document: doc("A completely new headline"), manifest: { schemaVersion: 1, fields: [] } });
    const got = (await getInstance(id)).json().instance;
    expect(got.baseRevision.number).toBe(1);
    expect(got.document.nodes.find((n: { id: string }) => n.id === "head").text).toBe("Headline one");
    expect(got.manifest.fields).toHaveLength(2);
    // The next instance starts from the new revision.
    expect((await customize("tpl")).json().instance.baseRevision.number).toBe(2);
  });

  it("saving still validates against the PINNED revision, not the newest: a field only the newer revision lists stays locked", async () => {
    const { doc } = seedCampaign({ revisions: 1 });
    const id = (await customize("tpl")).json().instance.id;
    seedRevision("base", 2, { document: doc("New"), manifest: { schemaVersion: 1, fields: [{ nodeId: "head", kind: "text" }, { nodeId: "legal", kind: "text" }] } });
    expect((await putInstance(id, { version: 1, overrides: [{ nodeId: "legal", text: "x" }] })).json()).toMatchObject({ code: "LOCKED_NODE" });
    expect((await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "x" }] })).statusCode).toBe(200);
  });

  it("unpublishing, detaching or deleting the template, or deleting its link, leaves existing instances readable, editable and deletable (D2, policy A: unpublish is not revocation)", async () => {
    seedCampaign();
    const id = (await customize("tpl")).json().instance.id;
    h.templates[0].published = false;
    expect((await getInstance(id)).statusCode).toBe(200);
    expect((await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "Still editable" }] })).statusCode).toBe(200);
    h.templates[0].designId = null;
    expect((await getInstance(id)).statusCode).toBe(200);
    h.templates = [];
    expect((await getInstance(id)).json().instance.overrides).toEqual([{ nodeId: "head", text: "Still editable" }]);
    expect((await putInstance(id, { version: 2, overrides: [] })).statusCode).toBe(200);
    // New ones need a template that is published right now.
    expect((await customize("tpl")).statusCode).toBe(404);
    expect((await delInstance(id)).statusCode).toBe(200);
  });
});

describe("GET /canvas/instances/:id", () => {
  beforeEach(() => {
    h.role = "member";
  });

  it("returns what the editor draws: the overrides, and the pinned revision's document and manifest, not cached", async () => {
    const { doc } = seedCampaign();
    const id = (await customize("tpl")).json().instance.id;
    await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "Mine" }] });
    const res = await getInstance(id);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { instance } = res.json();
    // Phase 6 adds `review` (nothing submitted yet here); archivedAt is never sent: an archived design has no editor.
    expect(Object.keys(instance).sort()).toEqual(["baseRevision", "createdAt", "document", "id", "manifest", "name", "overrides", "review", "submitted", "updatedAt", "version"]);
    expect(instance.review).toMatchObject({ latestReviewStatus: null, hasChangesSinceSubmitted: false, workingVersion: 2 });
    expect(instance.submitted).toBeNull(); // nothing was submitted yet
    expect(instance.overrides).toEqual([{ nodeId: "head", text: "Mine" }]);
    expect(instance.document).toEqual(doc("Headline one"));
    expect(Object.keys(instance.baseRevision).sort()).toEqual(["createdAt", "number"]);
    expect(res.body).not.toContain("baseRevisionId");
    expect(res.body).not.toContain("createdByUserId");
    expect(res.body).not.toContain("workspaceId");
    expect(res.body).not.toContain("category"); // nothing about the template, which may since have become a draft
  });

  it("a damaged row (impossible past the check constraint and the foreign key) is an error, not a half answer", async () => {
    seedInstance({ id: "i1", baseRevisionId: "gone" });
    expect((await getInstance("i1")).statusCode).toBe(500);
    seedCampaign();
    seedInstance({ id: "i2", overrides: { schemaVersion: 9, fields: [] } });
    expect((await getInstance("i2")).statusCode).toBe(500);
  });
});

describe("PUT /canvas/instances/:id: the complete override set, checked against the pinned revision", () => {
  let id: string;
  beforeEach(async () => {
    h.role = "member";
    seedCampaign();
    h.rows.push({ id: "asset-2", workspaceId: "ws-1", storageRef: "x" }, { id: "foreign", workspaceId: "ws-2", storageRef: "y" });
    id = (await customize("tpl")).json().instance.id;
    db.design.updateMany.mockClear();
    h.log = [];
  });
  const row = () => h.designs.find((d) => d.id === id)!;

  // Phase 7: like the designer's PUT, this takes only JSON; the rest are refused by the JSON guard and write nothing.
  it.each([
    ["no body and no content type", undefined, {}],
    ["plain text", "{}", { "content-type": "text/plain" }],
    ["a form post", "version=1", { "content-type": "application/x-www-form-urlencoded" }],
    ["multipart", "--x--", { "content-type": "multipart/form-data; boundary=x" }],
  ])("refuses %s with 415 and writes nothing", async (label, payload, headers) => {
    const res = await app.inject({ method: "PUT", url: `/canvas/instances/${id}`, ...(payload ? { payload } : {}), headers });
    expect(res.statusCode).toBe(415);
    if (label !== "a form post") expect(res.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" }); // (Fastify refuses a form post itself)
    expect(db.design.updateMany).not.toHaveBeenCalled();
    expect(row().version).toBe(1);
  });

  it("saves, bumps the version once, and answers with the new version only", async () => {
    const res = await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "Mine" }] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: 2 });
    expect(row().version).toBe(2);
    expect(row().overrides).toEqual({ schemaVersion: 1, fields: [{ nodeId: "head", text: "Mine" }] });
    expect(row().document ?? null).toBeNull();
  });

  it("REPLACES the whole set: what the body leaves out goes back to the revision's value", async () => {
    await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "One" }, { nodeId: "photo", assetId: "asset-2" }] });
    expect(stored(row())).toHaveLength(2);
    const res = await putInstance(id, { version: 2, overrides: [{ nodeId: "photo", assetId: "asset-2" }] }); // head left out
    expect(res.statusCode).toBe(200);
    expect(stored(row())).toEqual([{ nodeId: "photo", assetId: "asset-2" }]);
    const shown = (await getInstance(id)).json().instance;
    expect(shown.overrides).toEqual([{ nodeId: "photo", assetId: "asset-2" }]);
    expect(shown.document.nodes.find((n: { id: string }) => n.id === "head").text).toBe("Headline one"); // the base is untouched
  });

  it("an empty list resets every field, and a field sent with the revision's own value is not stored", async () => {
    await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "One" }] });
    expect((await putInstance(id, { version: 2, overrides: [] })).json()).toEqual({ version: 3 });
    expect(stored(row())).toEqual([]);
    expect((await putInstance(id, { version: 3, overrides: [{ nodeId: "head", text: "Headline one" }] })).json()).toEqual({ version: 3 }); // already empty: nothing to write
    expect(stored(row())).toEqual([]);
  });

  it("an unchanged set is a 200 with the SAME version and no write, whatever order it came in", async () => {
    await putInstance(id, { version: 1, overrides: [{ nodeId: "photo", assetId: "asset-2" }, { nodeId: "head", text: "One" }] });
    db.design.updateMany.mockClear();
    const res = await putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "One" }, { nodeId: "photo", assetId: "asset-2" }] });
    expect(res.json()).toEqual({ version: 2 });
    expect(db.design.updateMany).not.toHaveBeenCalled();
    expect(row().version).toBe(2);
  });

  it("stores the set in the manifest's order", async () => {
    await putInstance(id, { version: 1, overrides: [{ nodeId: "photo", assetId: "asset-2" }, { nodeId: "head", text: "One" }] });
    expect(stored(row()).map((e) => (e as { nodeId: string }).nodeId)).toEqual(["head", "photo"]);
  });

  it("refuses a locked layer with LOCKED_NODE, an unknown one with UNKNOWN_NODE, a repeat with DUPLICATE_NODE, and writes nothing", async () => {
    const cases: Array<[unknown[], string]> = [
      [[{ nodeId: "legal", text: "x" }], "LOCKED_NODE"],
      [[{ nodeId: "head", assetId: "asset-2" }], "LOCKED_NODE"],
      [[{ nodeId: "photo", text: "x" }], "LOCKED_NODE"],
      [[{ nodeId: "nope", text: "x" }], "UNKNOWN_NODE"],
      [[{ nodeId: "__proto__", text: "x" }], "UNKNOWN_NODE"],
      [[{ nodeId: "head", text: "a" }, { nodeId: "head", text: "b" }], "DUPLICATE_NODE"],
      [[{ nodeId: "head", text: "ok" }, { nodeId: "legal", text: "x" }], "LOCKED_NODE"], // one bad entry refuses the set
    ];
    for (const [overrides, code] of cases) {
      const res = await putInstance(id, { version: 1, overrides });
      expect(res.statusCode, code).toBe(400);
      expect(res.json()).toMatchObject({ code });
    }
    expect(db.design.updateMany).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ version: 1, overrides: { fields: [] } });
  });

  it("refuses a body that is not exactly {version, overrides, name?}: INVALID_OVERRIDES or INVALID_REQUEST, and writes nothing", async () => {
    for (const body of [{ version: 1 }, { version: 1, overrides: null }, { version: 1, overrides: {} }, { version: 1, overrides: [{ nodeId: "head" }] }, { version: 1, overrides: [{ nodeId: "head", text: "x", assetId: "asset-2" }] }, { version: 1, overrides: [{ nodeId: "head", text: "x", x: 5 }] }]) {
      const res = await putInstance(id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_OVERRIDES" });
    }
    for (const extra of ["document", "manifest", "baseRevisionId", "kind", "workspaceId", "createdByUserId", "createdAt"]) {
      const res = await putInstance(id, { version: 1, overrides: [], [extra]: "x" });
      expect(res.statusCode, extra).toBe(400);
    }
    expect((await putInstance(id, { version: 0, overrides: [] })).statusCode).toBe(400);
    expect(db.design.updateMany).not.toHaveBeenCalled();
  });

  it("the text budget: more text than the design may hold is TEXT_TOO_LONG", async () => {
    // 16 protected layers of 4,999 characters plus a one-character headline: 79,985 of the 80,000 the design may hold.
    h.revisions[0].document = docOf(textLayer("head", { permission: "text", text: "h" }), ...Array.from({ length: 16 }, (_, i) => textLayer(`f${i}`, { text: "y".repeat(4999) })));
    h.revisions[0].manifest = { schemaVersion: 1, fields: [{ nodeId: "head", kind: "text" }] };
    expect((await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "x".repeat(5000) }] })).json()).toMatchObject({ code: "TEXT_TOO_LONG" });
    expect((await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "x".repeat(10) }] })).statusCode).toBe(200);
  });

  it("an image must be an asset of THIS workspace (UNKNOWN_ASSET), checked on every save that brings one in", async () => {
    for (const assetId of ["foreign", "nope"]) {
      const res = await putInstance(id, { version: 1, overrides: [{ nodeId: "photo", assetId }] });
      expect(res.statusCode, assetId).toBe(400);
      expect(res.json()).toMatchObject({ code: "UNKNOWN_ASSET" });
    }
    expect(db.design.updateMany).not.toHaveBeenCalled();
    expect((await putInstance(id, { version: 1, overrides: [{ nodeId: "photo", assetId: "asset-2" }] })).statusCode).toBe(200);
    expect(db.designAsset.count.mock.calls.at(-1)![0].where).toEqual({ id: { in: ["asset-2"] }, workspaceId: "ws-1" });
  });

  it("a save with no image asks the database about no asset at all", async () => {
    db.designAsset.count.mockClear();
    await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "x" }] });
    expect(db.designAsset.count).not.toHaveBeenCalled();
  });

  it("a stale version is 409 VERSION_CONFLICT, and nothing is written", async () => {
    await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "One" }] });
    db.design.updateMany.mockClear();
    const res = await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "Two" }] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(db.design.updateMany).not.toHaveBeenCalled();
    expect(stored(row())).toEqual([{ nodeId: "head", text: "One" }]);
  });

  it("two saves from the same version: the first wins, the second is refused", async () => {
    const a = await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "A" }] });
    const b = await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "B" }] });
    expect([a.statusCode, b.statusCode]).toEqual([200, 409]);
    expect(stored(row())).toEqual([{ nodeId: "head", text: "A" }]);
  });

  it("a conflict that arises between the read and the write (the conditional update matches nothing) is the same 409, or a 404 if the design is gone", async () => {
    db.design.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "x" }] })).json()).toMatchObject({ code: "VERSION_CONFLICT" });
    db.design.updateMany.mockImplementationOnce(async () => {
      h.designs = h.designs.filter((d) => d.id !== id);
      return { count: 0 };
    });
    expect((await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "x" }] })).statusCode).toBe(404);
  });

  it("renames with a trimmed name, saves a name-only change, and keeps the name when none is sent", async () => {
    expect((await putInstance(id, { version: 1, overrides: [], name: "  Spring launch  " })).json()).toEqual({ version: 2 });
    expect(row().name).toBe("Spring launch");
    expect((await putInstance(id, { version: 2, overrides: [] })).json()).toEqual({ version: 2 }); // no name: the stored one stays
    expect(row().name).toBe("Spring launch");
    expect((await putInstance(id, { version: 2, overrides: [], name: "Spring launch" })).json()).toEqual({ version: 2 }); // the same name: nothing to write
    for (const name of ["", "   ", "a\nb", "x".repeat(101)]) expect((await putInstance(id, { version: 2, overrides: [], name })).json(), name).toMatchObject({ code: "INVALID_NAME" });
  });

  it("writes ONLY the overrides, the name and the version: the conditional update names the owner, and never the pinned revision, the kind, the document or the dates", async () => {
    await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "x" }], name: "N" });
    const call = db.design.updateMany.mock.calls[0][0];
    // archivedAt: null (phase 6): a design archived between the read and the write is not saved.
    expect(call.where).toEqual({ id, workspaceId: "ws-1", kind: "instance", createdByUserId: "user-1", version: 1, archivedAt: null });
    expect(Object.keys(call.data).sort()).toEqual(["name", "overrides", "version"]);
    expect(call.data.version).toEqual({ increment: 1 });
    expect(row()).toMatchObject({ baseRevisionId: "r-base-1", kind: "instance", createdByUserId: "user-1" });
  });

  it("the base revision is never modified by a save", async () => {
    const before = JSON.stringify(h.revisions);
    await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "x" }, { nodeId: "photo", assetId: "asset-2" }] });
    expect(JSON.stringify(h.revisions)).toBe(before);
    expect(db.designRevision.create).not.toHaveBeenCalled();
  });

  it("a revision whose manifest is damaged fails CLOSED: an error, and nothing is written", async () => {
    h.revisions[0].manifest = { schemaVersion: 7, fields: [] };
    expect((await putInstance(id, { version: 1, overrides: [{ nodeId: "head", text: "x" }] })).statusCode).toBe(500);
    expect((await putInstance(id, { version: 1, overrides: [] })).statusCode).toBe(500); // even an empty set: the revision cannot be trusted
    expect(db.design.updateMany).not.toHaveBeenCalled();
  });

  it("accepts a body up to the API's limit and refuses one over it, writing nothing", async () => {
    const res = await app.inject({ method: "PUT", url: `/canvas/instances/${id}`, payload: JSON.stringify({ version: 1, overrides: [], name: "a".repeat(1_100_000) }), headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(413);
    expect(db.design.updateMany).not.toHaveBeenCalled();
  });
});

describe("DELETE /canvas/instances/:id", () => {
  it("deletes my own design, with the delete scoped to the workspace, the kind and me, and keeps the base revision and the images", async () => {
    h.role = "member";
    seedCampaign();
    h.rows.push({ id: "asset-2", workspaceId: "ws-1", storageRef: "x" });
    const id = (await customize("tpl")).json().instance.id;
    await putInstance(id, { version: 1, overrides: [{ nodeId: "photo", assetId: "asset-2" }] });
    const res = await delInstance(id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(db.design.deleteMany.mock.calls[0][0].where).toEqual({ id, workspaceId: "ws-1", kind: "instance", createdByUserId: "user-1" });
    expect(h.designs.some((d) => d.id === id)).toBe(false);
    expect(h.revisions).toHaveLength(1);
    expect(h.rows.some((r) => r.id === "asset-2")).toBe(true);
  });

  it("an unknown id, or one already deleted, is a 404", async () => {
    h.role = "member";
    expect((await delInstance("nope")).statusCode).toBe(404);
  });
});

describe("GET /canvas/instances: my designs, in pages", () => {
  const ids = (res: { json: () => { instances: Array<{ id: string }> } }) => res.json().instances.map((i) => i.id);
  /** n of my instances, created one second apart, oldest first; ids i1..in. */
  const seedMany = (n: number, over: (i: number) => Partial<DesignRow> = () => ({})) => {
    for (let i = 1; i <= n; i++) seedInstance({ id: `i${String(i).padStart(3, "0")}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)), ...over(i) });
  };
  beforeEach(() => {
    h.role = "member";
    seedCampaign();
  });

  it("lists newest-created first, with a summary only: no document, overrides or revision id", async () => {
    seedMany(3);
    const res = await listInstances();
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(ids(res)).toEqual(["i003", "i002", "i001"]);
    // Phase 6 adds `review` (a summary of the newest submission); the stored overrides are read to compute it and never sent.
    expect(Object.keys(res.json().instances[0]).sort()).toEqual(["archivedAt", "baseRevision", "createdAt", "id", "name", "review", "updatedAt", "version"]);
    expect(res.json().instances[0].baseRevision).toEqual({ number: 1 });
    expect(res.json().instances[0].archivedAt).toBeNull();
    expect(res.json().instances[0].review).toMatchObject({ latestReviewStatus: null, hasChangesSinceSubmitted: false });
    expect(res.json().nextCursor).toBeNull();
    for (const secret of ["document", "overrides", "baseRevisionId", "createdByUserId", "workspaceId"]) expect(res.body).not.toContain(secret);
  });

  it("defaults to 50 a page and caps a larger limit at 100", async () => {
    seedMany(130);
    const first = await listInstances();
    expect(first.json().instances).toHaveLength(50);
    expect(db.design.findMany.mock.calls[0][0].take).toBe(51); // one more than the page, only to know whether there is a next
    expect((await listInstances("?limit=1000")).json().instances).toHaveLength(100);
    expect((await listInstances("?limit=7")).json().instances).toHaveLength(7);
  });

  it("walks every row exactly once over several pages: 120 rows at 50 a page is 50, 50, 20, and the last has no next cursor", async () => {
    seedMany(120);
    const seen: string[] = [];
    let url = "";
    const sizes: number[] = [];
    for (let guard = 0; guard < 10; guard++) {
      const res = await listInstances(url);
      expect(res.statusCode).toBe(200);
      const page = ids(res);
      sizes.push(page.length);
      seen.push(...page);
      const next = res.json().nextCursor as string | null;
      if (!next) break;
      url = `?cursor=${next}`;
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120); // no duplicates
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => `i${String(120 - i).padStart(3, "0")}`)); // no gaps, in order
  });

  it("an exact multiple of the limit ends with a null cursor (the lookahead row decides, and is never returned or used for the cursor)", async () => {
    seedMany(100);
    const one = await listInstances("?limit=50");
    expect(one.json().instances).toHaveLength(50);
    expect(one.json().nextCursor).not.toBeNull();
    const two = await listInstances(`?limit=50&cursor=${one.json().nextCursor}`);
    expect(two.json().instances).toHaveLength(50);
    expect(two.json().nextCursor).toBeNull();
    // Exactly one page of 50 rows: nothing after it.
    h.designs = [];
    seedMany(50);
    expect((await listInstances("?limit=50")).json().nextCursor).toBeNull();
  });

  it("the next cursor comes from the last row actually RETURNED, never from the extra lookahead row", async () => {
    seedMany(4);
    const res = await listInstances("?limit=2");
    expect(ids(res)).toEqual(["i004", "i003"]);
    const cursor = JSON.parse(Buffer.from(res.json().nextCursor, "base64url").toString("utf8"));
    expect(cursor).toEqual({ t: Date.UTC(2026, 0, 1, 0, 0, 3), i: "i003" }); // not i002, the lookahead row
    expect(ids(await listInstances(`?limit=2&cursor=${res.json().nextCursor}`))).toEqual(["i002", "i001"]);
  });

  it("rows created at the same instant are ordered by id, and a page boundary inside them neither skips nor repeats a row", async () => {
    const same = new Date(Date.UTC(2026, 0, 1, 0, 0, 5));
    seedMany(7, () => ({ createdAt: same })); // seven rows with an identical createdAt
    const seen: string[] = [];
    let url = "?limit=3";
    for (let guard = 0; guard < 5; guard++) {
      const res = await listInstances(url);
      seen.push(...ids(res));
      if (!res.json().nextCursor) break;
      url = `?limit=3&cursor=${res.json().nextCursor}`;
    }
    expect(seen).toEqual(["i007", "i006", "i005", "i004", "i003", "i002", "i001"]);
    // A tie across the boundary with rows of other times around it.
    h.designs = [];
    seedInstance({ id: "x1", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 9)) });
    seedInstance({ id: "x2", createdAt: same });
    seedInstance({ id: "x3", createdAt: same });
    seedInstance({ id: "x4", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 1)) });
    const first = await listInstances("?limit=2");
    expect(ids(first)).toEqual(["x1", "x3"]);
    expect(ids(await listInstances(`?limit=2&cursor=${first.json().nextCursor}`))).toEqual(["x2", "x4"]);
  });

  it("the boundary row deleted, or renamed, between two pages does not end or distort the walk (the cursor is a value, not a row)", async () => {
    seedMany(6);
    const first = await listInstances("?limit=3");
    expect(ids(first)).toEqual(["i006", "i005", "i004"]);
    h.designs = h.designs.filter((d) => d.id !== "i004"); // the row the cursor points at is deleted
    const second = await listInstances(`?limit=3&cursor=${first.json().nextCursor}`);
    expect(second.statusCode).toBe(200);
    expect(ids(second)).toEqual(["i003", "i002", "i001"]); // the walk goes on from where it was: nothing lost, nothing repeated
    // And the same when the boundary row is saved (its updatedAt changes) in between.
    seedInstance({ id: "i004", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 4)) });
    const again = await listInstances("?limit=3");
    h.designs.find((d) => d.id === "i004")!.updatedAt = new Date(2030, 0, 1);
    expect(ids(await listInstances(`?limit=3&cursor=${again.json().nextCursor}`))).toEqual(["i003", "i002", "i001"]);
  });

  it("an autosave (a PUT) between two pages does not reorder anything: the order is by creation, not by last change", async () => {
    seedMany(5);
    const first = await listInstances("?limit=2");
    expect(ids(first)).toEqual(["i005", "i004"]);
    // The oldest and the newest are both saved after the first page was read.
    for (const id of ["i001", "i005"]) {
      const row = h.designs.find((d) => d.id === id)!;
      expect((await putInstance(id, { version: row.version, overrides: [], name: `Saved ${id}` })).statusCode).toBe(200);
    }
    const second = await listInstances(`?limit=2&cursor=${first.json().nextCursor}`);
    expect(ids(second)).toEqual(["i003", "i002"]);
    const third = await listInstances(`?limit=2&cursor=${second.json().nextCursor}`);
    expect(ids(third)).toEqual(["i001"]);
    expect(third.json().nextCursor).toBeNull();
  });

  it("a design created and one deleted during the walk: nothing the walk already passed repeats, and the deleted one is gone", async () => {
    seedMany(4);
    const first = await listInstances("?limit=2");
    seedInstance({ id: "newest", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 50)) }); // sorts before the first page
    h.designs = h.designs.filter((d) => d.id !== "i002");
    const second = await listInstances(`?limit=2&cursor=${first.json().nextCursor}`);
    expect(ids(second)).toEqual(["i001"]); // i002 is gone, i003 and i004 were already passed, and the new one sorts before the first page
    expect(second.json().instances.some((i: { id: string }) => i.id === "newest")).toBe(false);
  });

  it("shows only MY designs of THIS workspace and kind", async () => {
    seedMany(2);
    seedInstance({ id: "theirs", createdByUserId: "user-2" });
    seedInstance({ id: "elsewhere", workspaceId: "ws-2" });
    const res = await listInstances();
    expect(ids(res)).toEqual(["i002", "i001"]);
    const w = db.design.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(w)).toContain('"createdByUserId":"user-1"');
    expect(JSON.stringify(w)).toContain('"workspaceId":"ws-1"');
    expect(JSON.stringify(w)).toContain('"kind":"instance"');
  });

  it("orders by createdAt then id, and the keyset condition is a value comparison: strictly after the cursor", async () => {
    seedMany(5);
    const first = await listInstances("?limit=2");
    await listInstances(`?limit=2&cursor=${first.json().nextCursor}`);
    expect(db.design.findMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    const second = db.design.findMany.mock.calls[1][0];
    expect(second.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(second.where.AND[1]).toEqual({ OR: [{ createdAt: { lt: new Date(Date.UTC(2026, 0, 1, 0, 0, 4)) } }, { createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 4)), id: { lt: "i004" } }] });
    expect(JSON.stringify(second)).not.toContain("cursor"); // Prisma's own cursor would end the walk if its row were deleted
    expect(second).not.toHaveProperty("cursor");
    // updatedAt is only READ (it is in the summary); it is never in the filter or the order, because every autosave changes it.
    for (const [call] of db.design.findMany.mock.calls) {
      expect(JSON.stringify(call.where)).not.toContain("updatedAt");
      expect(JSON.stringify(call.orderBy)).not.toContain("updatedAt");
    }
  });

  it.each(["0", "-1", "1.5", "abc", "", " ", "1e2", "+5", "Infinity", "NaN"])("limit=%j is a 400 INVALID_LIMIT, with no query", async (limit) => {
    seedMany(3);
    const res = await listInstances(`?limit=${encodeURIComponent(limit)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_LIMIT" });
    expect(db.design.findMany).not.toHaveBeenCalled();
  });

  it("a repeated limit (?limit=5&limit=10) is a 400, not a guess", async () => {
    seedMany(3);
    const res = await listInstances("?limit=5&limit=10");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_LIMIT" });
    expect(db.design.findMany).not.toHaveBeenCalled();
  });

  it.each(["!!!", "e30", "abc", "eyJ0IjoxfQ", "a".repeat(300), "", "eyJ0IjoxLCJpIjoiYSIsIngiOjF9"])("cursor=%j is a 400 INVALID_CURSOR, with no query", async (cursor) => {
    seedMany(3);
    const res = await listInstances(`?cursor=${cursor}`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_CURSOR" });
    expect(db.design.findMany).not.toHaveBeenCalled();
  });

  it("a repeated cursor is a 400 too", async () => {
    seedMany(3);
    const one = await listInstances("?limit=1");
    const c = one.json().nextCursor;
    expect((await listInstances(`?cursor=${c}&cursor=${c}`)).statusCode).toBe(400);
  });

  it("a forged but well-formed cursor can only move within MY rows", async () => {
    seedMany(3);
    seedInstance({ id: "theirs", createdByUserId: "user-2", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 2)) });
    const forged = Buffer.from(JSON.stringify({ t: Date.UTC(2030, 0, 1), i: "zzz" }), "utf8").toString("base64url");
    const res = await listInstances(`?cursor=${forged}`);
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual(["i003", "i002", "i001"]);
  });

  it("an empty list is an empty page with no cursor", async () => {
    const res = await listInstances();
    expect(res.json()).toEqual({ instances: [], nextCursor: null });
  });
});

describe("DELETE /canvas/designs/:id: a design Marketing made designs from cannot be deleted", () => {
  it("answers 409 DESIGN_IN_USE with the count, deletes nothing, and keeps the revisions", async () => {
    seedCampaign();
    seedInstance({ id: "m1" });
    seedInstance({ id: "m2", createdByUserId: "user-2" });
    h.templates = []; // unlinked: only the instances stand in the way
    const res = await app.inject({ method: "DELETE", url: "/canvas/designs/base" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "DESIGN_IN_USE" });
    expect(res.json().error).toContain("2 designs");
    expect(res.body).not.toContain("m1");
    expect(db.design.deleteMany).not.toHaveBeenCalled();
    expect(h.designs.some((d) => d.id === "base")).toBe(true);
    expect(h.revisions).toHaveLength(1);
  });

  it("counts only instances of THIS workspace, pinned to THIS design", async () => {
    seedCampaign();
    h.templates = [];
    seedDesign({ id: "other-design" });
    seedRevision("other-design", 1);
    seedInstance({ id: "x", baseRevisionId: "r-other-design-1" }); // pinned to another design
    seedDesign({ id: "ws2-design", workspaceId: "ws-2" });
    seedRevision("ws2-design", 1);
    seedInstance({ id: "y", workspaceId: "ws-2", baseRevisionId: "r-ws2-design-1" }); // another workspace, and its own design
    expect((await app.inject({ method: "DELETE", url: "/canvas/designs/base" })).statusCode).toBe(200);
    expect(db.design.count.mock.calls[0][0].where).toEqual({ workspaceId: "ws-1", kind: "instance", baseRevision: { designId: "base" } });
  });

  it("linked to a template, it is still DESIGN_LINKED first", async () => {
    seedCampaign();
    seedInstance({ id: "m1" });
    expect((await app.inject({ method: "DELETE", url: "/canvas/designs/base" })).json()).toMatchObject({ code: "DESIGN_LINKED" });
  });

  it("once the last instance is deleted, the design can be deleted", async () => {
    seedCampaign();
    h.templates = [];
    seedInstance({ id: "m1" });
    expect((await app.inject({ method: "DELETE", url: "/canvas/designs/base" })).statusCode).toBe(409);
    h.role = "member";
    expect((await delInstance("m1")).statusCode).toBe(200);
    h.role = "designer";
    expect((await app.inject({ method: "DELETE", url: "/canvas/designs/base" })).statusCode).toBe(200);
  });

  it("the foreign key is the backstop: an instance made after the check (P2003) is DESIGN_IN_USE, and a link made after it is still DESIGN_LINKED", async () => {
    seedCampaign();
    h.templates = [];
    db.design.deleteMany.mockImplementationOnce(async () => {
      seedInstance({ id: "late" }); // made between the check and the delete
      throw Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" });
    });
    const res = await app.inject({ method: "DELETE", url: "/canvas/designs/base" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "DESIGN_IN_USE" });
    h.designs = h.designs.filter((d) => d.id !== "late");
    db.design.deleteMany.mockRejectedValueOnce(Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" }));
    expect((await app.inject({ method: "DELETE", url: "/canvas/designs/base" })).json()).toMatchObject({ code: "DESIGN_LINKED" });
  });
});

describe("the database's own rules, as the test double enforces them (so the routes are tested against them)", () => {
  it("a template design can never be written without its document, nor an instance with one (Design_shape_check)", async () => {
    h.role = "member";
    seedCampaign();
    await expect(db.design.create({ data: { workspaceId: "ws-1", kind: "template", name: "x", document: null }, select: { id: true } })).rejects.toMatchObject({ code: "P2004" });
    await expect(db.design.create({ data: { workspaceId: "ws-1", kind: "instance", name: "x", document: BLANK_DOCUMENT, baseRevisionId: "r-base-1", overrides: { schemaVersion: 1, fields: [] } }, select: { id: true } })).rejects.toMatchObject({ code: "P2004" });
    await expect(db.design.create({ data: { workspaceId: "ws-1", kind: "instance", name: "x", overrides: { schemaVersion: 1, fields: [] } }, select: { id: true } })).rejects.toMatchObject({ code: "P2004" });
  });

  it("the pinned revision and the kind cannot be changed by an update (the pin trigger)", async () => {
    seedCampaign();
    seedInstance({ id: "i1" });
    await expect(db.design.updateMany({ where: { id: "i1" }, data: { baseRevisionId: "other", version: { increment: 1 } } })).rejects.toMatchObject({ code: "P2010" });
    await expect(db.design.updateMany({ where: { id: "i1" }, data: { kind: "template", version: { increment: 1 } } })).rejects.toMatchObject({ code: "P2010" });
  });
});

// ── Phase 6: design review ────────────────────────────────────────────────────────────────────────────────────────

const submit = (id: string, payload: unknown = { version: 1 }) => app.inject({ method: "POST", url: `/canvas/instances/${id}/submit`, payload: payload as object });
const history = (id: string, query = "") => app.inject({ method: "GET", url: `/canvas/instances/${id}/submissions${query}` });
const oneSubmission = (id: string, n: number | string) => app.inject({ method: "GET", url: `/canvas/instances/${id}/submissions/${n}` });
const queueOf = (query = "") => app.inject({ method: "GET", url: `/canvas/reviews${query}` });
const reviewOf = (id: string) => app.inject({ method: "GET", url: `/canvas/reviews/${id}` });
const reviewSummaryOf = () => app.inject({ method: "GET", url: "/canvas/reviews/summary" });
const decide = (id: string, payload: unknown) => app.inject({ method: "POST", url: `/canvas/reviews/${id}/decision`, payload: payload as object });
const inst = (id: string) => h.designs.find((d) => d.id === id)!;
const pendingCount = () => h.reviews.filter((r) => r.status === "pending").length;
const layerText = (d: unknown, nodeId: string) => (d as { nodes: Array<{ id: string; text?: string }> }).nodes.find((n) => n.id === nodeId)?.text;

/** A published campaign, and one of MY instances made from it, with its first save done (version 2). */
async function seedMine(overrides: unknown[] = [{ nodeId: "head", text: "Mine" }]) {
  h.role = "member";
  const campaign = seedCampaign();
  const id = (await customize("tpl")).json().instance.id as string;
  await putInstance(id, { version: 1, overrides });
  return { id, ...campaign };
}
const asDesigner = () => {
  h.role = "designer";
  h.userId = "designer-1";
};
const asMarketing = () => {
  h.role = "member";
  h.userId = "user-1";
};

describe("phase 6: who may do what", () => {
  const marketing = (id: string) => [() => submit(id), () => history(id), () => oneSubmission(id, 1)];
  const designer = () => [() => reviewSummaryOf(), () => queueOf(), () => reviewOf("rv1"), () => decide("rv1", { decision: "approve" })];

  it("answers 401 when signed out, on every phase 6 endpoint, and touches nothing", async () => {
    const { id } = await seedMine();
    h.authed = false;
    for (const call of [...marketing(id), ...designer()]) expect((await call()).statusCode).toBe(401);
    expect(db.designSubmission.create).not.toHaveBeenCalled();
    expect(db.designReviewRequest.updateMany).not.toHaveBeenCalled();
    expect(h.submissions).toHaveLength(0);
  });

  it.each(["designer", "viewer", null])("Marketing's endpoints answer 403 for the %s role, and touch nothing", async (role) => {
    const { id } = await seedMine();
    h.role = role;
    db.$queryRaw.mockClear();
    for (const call of marketing(id)) {
      const res = await call();
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.designSubmission.create).not.toHaveBeenCalled();
  });

  it.each(["member", "admin", "owner", "viewer", null])("the review endpoints answer 403 for the %s role (review is the design team's, owner and admin included), and touch nothing", async (role) => {
    await seedMine();
    h.role = role;
    for (const call of designer()) {
      const res = await call();
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(db.designReviewRequest.findMany).not.toHaveBeenCalled();
    expect(db.designReviewRequest.updateMany).not.toHaveBeenCalled();
  });

  it.each(["member", "admin", "owner"])("the %s role may submit its own design", async (role) => {
    const { id } = await seedMine();
    h.role = role;
    expect((await submit(id, { version: 2 })).statusCode).toBe(201);
  });

  it("another person's design, another workspace's and a malformed id are all the same 404, and nothing is written", async () => {
    await seedMine();
    seedInstance({ id: "theirs", createdByUserId: "someone-else" });
    seedInstance({ id: "other-ws", workspaceId: "ws-2" });
    for (const id of ["theirs", "other-ws", "nope", "a%00b"]) {
      for (const call of [() => submit(id), () => history(id), () => oneSubmission(id, 1)]) expect((await call()).statusCode, id).toBe(404);
    }
    expect(h.submissions).toHaveLength(0);
  });
});

describe("POST /canvas/instances/:id/submit", () => {
  it("snapshots the design as the SERVER composes it: the pinned revision's document plus the overrides, nothing from the client", async () => {
    h.rows.push({ id: "asset-2", workspaceId: "ws-1", storageRef: "x" }); // before the save: an image must be an asset of the workspace
    const { id, doc } = await seedMine([{ nodeId: "head", text: "Mine" }, { nodeId: "photo", assetId: "asset-2" }]);
    const res = await submit(id, { version: 2, note: "  For the launch  " });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ submission: { number: 1 }, review: { status: "pending" } });
    const s = h.submissions[0];
    expect(s).toMatchObject({ instanceId: id, workspaceId: "ws-1", number: 1, instanceVersion: 2, name: "Case Study", note: "For the launch", baseRevisionId: "r-base-1", submittedByUserId: "user-1" });
    const expected = doc("Headline one") as { nodes: Array<Record<string, unknown>> };
    expect(s.document).toEqual({ ...expected, nodes: expected.nodes.map((n) => (n.id === "head" ? { ...n, text: "Mine" } : n.id === "photo" ? { ...n, assetId: "asset-2" } : n)) });
    expect(s.overrides).toEqual(inst(id).overrides); // exactly what the instance held
    expect(h.reviews[0]).toMatchObject({ submissionId: s.id, status: "pending", pendingInstanceId: id, workspaceId: "ws-1", comment: null, decidedByUserId: null });
    expect(res.body).not.toContain("document"); // the answer is small: ids and numbers
  });

  it("takes only the version and an optional note: a document, overrides, a revision, a workspace or a status from the client is a 400", async () => {
    const { id } = await seedMine();
    for (const body of [{ version: 2, document: {} }, { version: 2, overrides: [] }, { version: 2, baseRevisionId: "r" }, { version: 2, workspaceId: "ws-2" }, { version: 2, status: "approved" }, { version: 2, submittedByUserId: "x" }, {}, { version: "2" }]) {
      expect((await submit(id, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(h.submissions).toHaveLength(0);
  });

  it("answers 415 for a body that is not JSON, and 400 for a note over 500 characters", async () => {
    const { id } = await seedMine();
    expect((await app.inject({ method: "POST", url: `/canvas/instances/${id}/submit`, headers: { "content-type": "text/plain" }, payload: "{}" })).statusCode).toBe(415);
    const long = await submit(id, { version: 2, note: "a".repeat(501) });
    expect(long.statusCode).toBe(400);
    expect(long.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(h.submissions).toHaveLength(0);
  });

  it("the first submission is allowed even with no overrides at all (P6-D3)", async () => {
    h.role = "member";
    seedCampaign();
    const id = (await customize("tpl")).json().instance.id as string;
    const res = await submit(id, { version: 1 });
    expect(res.statusCode).toBe(201);
    expect(h.submissions[0].overrides).toEqual({ schemaVersion: 1, fields: [] });
    expect(h.submissions[0].document).toEqual(h.revisions[0].document); // the revision as published
  });

  it("a note is optional: none, or only spaces, is stored as null", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    expect(h.submissions[0].note).toBeNull();
    await putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "Other" }] });
    await submit(id, { version: 3, note: "   " });
    expect(h.submissions[1].note).toBeNull();
  });

  it("409 VERSION_CONFLICT when the editor's version is not the stored one, and nothing is written", async () => {
    const { id } = await seedMine();
    const res = await submit(id, { version: 1 }); // stored is 2
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(h.submissions).toHaveLength(0);
    expect(h.reviews).toHaveLength(0);
  });

  it("409 NO_REVIEWER when the workspace has no designer, and nothing is written", async () => {
    const { id } = await seedMine();
    h.members = [{ workspaceId: "ws-1", userId: "m1", role: "member" }, { workspaceId: "ws-2", userId: "d9", role: "designer" }]; // a designer of ANOTHER workspace does not count
    const res = await submit(id, { version: 2 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NO_REVIEWER" });
    expect(h.submissions).toHaveLength(0);
    expect(db.workspaceMember.count.mock.calls[0][0]).toEqual({ where: { workspaceId: "ws-1", role: "designer" } });
  });

  it("409 NO_CHANGES for the same state again, after a pending, an approved and a changes-requested submission", async () => {
    const { id } = await seedMine();
    expect((await submit(id, { version: 2 })).statusCode).toBe(201);
    for (const next of [null, "approved", "changes_requested"]) {
      if (next) {
        const rv = h.reviews[h.reviews.length - 1];
        if (next === "approved") {
          asDesigner();
          await decide(rv.id, { decision: "approve" });
          asMarketing();
        }
      }
      const again = await submit(id, { version: 2 });
      expect(again.statusCode, String(next)).toBe(409);
      expect(again.json()).toMatchObject({ code: "NO_CHANGES" });
    }
    expect(h.submissions).toHaveLength(1);
  });

  it("a note alone is never a change: the same design with a new note is NO_CHANGES", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2, note: "first" });
    const again = await submit(id, { version: 2, note: "an explanation, no edit" });
    expect(again.statusCode).toBe(409);
    expect(h.submissions).toHaveLength(1);
  });

  it("an edit makes a new submission possible, and it SUPERSEDES the pending review (one pending per design)", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    await putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "Second" }] });
    const res = await submit(id, { version: 3, note: "v2" });
    expect(res.statusCode).toBe(201);
    expect(res.json().submission.number).toBe(2);
    expect(h.reviews.map((r) => [r.status, r.pendingInstanceId])).toEqual([["superseded", null], ["pending", id]]);
    expect(pendingCount()).toBe(1);
    expect(h.submissions.map((s) => s.number)).toEqual([1, 2]);
    expect(layerText(h.submissions[0].document, "head")).toBe("Mine"); // the first snapshot is untouched
    expect(layerText(h.submissions[1].document, "head")).toBe("Second");
  });

  it("A, then B, then A again: each is a new submission, because only the LATEST is compared (no unique key on the content)", async () => {
    const { id } = await seedMine([{ nodeId: "head", text: "A" }]);
    expect((await submit(id, { version: 2 })).statusCode).toBe(201); // A
    await putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "B" }] });
    expect((await submit(id, { version: 3 })).statusCode).toBe(201); // B
    await putInstance(id, { version: 3, overrides: [{ nodeId: "head", text: "A" }] });
    expect((await submit(id, { version: 4 })).statusCode).toBe(201); // A again
    expect(h.submissions.map((s) => [s.number, s.instanceVersion, layerText(s.document, "head")])).toEqual([[1, 2, "A"], [2, 3, "B"], [3, 4, "A"]]);
    expect(pendingCount()).toBe(1);
  });

  it("edit then revert to what was submitted is NO_CHANGES (a newer version, the same content)", async () => {
    const { id } = await seedMine([{ nodeId: "head", text: "A" }]);
    await submit(id, { version: 2 });
    await putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "B" }] });
    await putInstance(id, { version: 3, overrides: [{ nodeId: "head", text: "A" }] });
    expect(inst(id).version).toBe(4);
    const res = await submit(id, { version: 4 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NO_CHANGES" });
  });

  it("a rename alone is a change", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    await putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "Mine" }], name: "Renamed" });
    expect((await submit(id, { version: 3 })).statusCode).toBe(201);
    expect(h.submissions[1].name).toBe("Renamed");
  });

  it("after a decision, editing and submitting again is allowed (the earlier answer stays on its own submission)", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    asDesigner();
    await decide(h.reviews[0].id, { decision: "request_changes", comment: "Shorter" });
    asMarketing();
    await putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "Shorter" }] });
    expect((await submit(id, { version: 3 })).statusCode).toBe(201);
    expect(h.reviews.map((r) => r.status)).toEqual(["changes_requested", "pending"]);
  });

  it("409 UNKNOWN_ASSET when an image of the design is no longer an asset of this workspace, and nothing is written", async () => {
    h.rows.push({ id: "asset-2", workspaceId: "ws-1", storageRef: "x" });
    const { id } = await seedMine([{ nodeId: "photo", assetId: "asset-2" }]);
    h.rows = [];
    const res = await submit(id, { version: 2 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "UNKNOWN_ASSET" });
    expect(h.submissions).toHaveLength(0);
  });

  it("a revision that is not what publishing wrote fails CLOSED: a 500, and nothing is written", async () => {
    const { id } = await seedMine();
    h.revisions[0].manifest = { schemaVersion: 9, fields: [] };
    expect((await submit(id, { version: 2 })).statusCode).toBe(500);
    expect(h.submissions).toHaveLength(0);
    expect(h.reviews).toHaveLength(0);
  });

  it("stored overrides that no longer validate are damage: a 500, and nothing is written", async () => {
    const { id } = await seedMine();
    inst(id).overrides = { schemaVersion: 1, fields: [{ nodeId: "legal", text: "x" }] }; // a locked layer
    expect((await submit(id, { version: 2 })).statusCode).toBe(500);
    expect(h.submissions).toHaveLength(0);
  });

  it("takes the instance's row lock FIRST and no other lock (not the template's, not the template design's), all in one transaction", async () => {
    const { id } = await seedMine();
    h.log = [];
    await submit(id, { version: 2 });
    expect(h.log.filter((e) => e.startsWith("lock:"))).toEqual(["lock:instance"]);
    expect(h.log.indexOf("tx:begin")).toBeLessThan(h.log.indexOf("lock:instance"));
    expect(h.log.indexOf("lock:instance")).toBeLessThan(h.log.indexOf("write:submission"));
    expect(h.log.indexOf("write:submission")).toBeLessThan(h.log.indexOf("write:review"));
    expect(h.log.indexOf("tx:end")).toBeGreaterThan(h.log.indexOf("write:review"));
    // the old pending review is replaced in the same transaction, both columns in one statement (the table's CHECK)
    expect(db.designReviewRequest.updateMany.mock.calls[0][0]).toEqual({ where: { pendingInstanceId: id, status: "pending" }, data: { status: "superseded", pendingInstanceId: null } });
  });

  it("a failure after the first write rolls the whole thing back: no submission without its review, no superseded review left behind", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    await putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "Second" }] });
    db.designReviewRequest.create.mockRejectedValueOnce(new Error("db down"));
    expect((await submit(id, { version: 3 })).statusCode).toBe(500);
    expect(h.submissions).toHaveLength(1); // the second submission was rolled back
    expect(h.reviews.map((r) => r.status)).toEqual(["pending"]); // and the first review is still pending, not superseded
  });

  it("a double submit: the second request finds the first one's snapshot and is NO_CHANGES (serialized by the lock)", async () => {
    const { id } = await seedMine();
    const [a, b] = await Promise.all([submit(id, { version: 2 }), submit(id, { version: 2 })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(h.submissions).toHaveLength(1);
  });

  it("the table's unique keys are only a backstop: a P2002 from a race that got past the check is NO_CHANGES, not a 500", async () => {
    const { id } = await seedMine();
    db.designSubmission.create.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    const res = await submit(id, { version: 2 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NO_CHANGES" });
  });

  it("never touches the template, its design or its revisions", async () => {
    const { id } = await seedMine();
    const before = JSON.stringify([h.templates, h.revisions]);
    db.template.findFirst.mockClear();
    await submit(id, { version: 2 });
    expect(JSON.stringify([h.templates, h.revisions])).toBe(before);
    expect(db.template.findFirst).not.toHaveBeenCalled();
    expect(db.designRevision.create).not.toHaveBeenCalled();
  });

  it("a template that was unpublished or detached since does not matter: the instance pins an immutable revision (policy A)", async () => {
    const { id, template } = await seedMine();
    template.published = false;
    template.designId = null;
    expect((await submit(id, { version: 2 })).statusCode).toBe(201);
  });
});

describe("submission history (Marketing, read-only)", () => {
  it("lists my submissions newest first with the answers and the reviewer's NAME, never an id or an email", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2, note: "one" });
    asDesigner();
    await decide(h.reviews[0].id, { decision: "request_changes", comment: "Shorter" });
    asMarketing();
    await putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "Short" }] });
    await submit(id, { version: 3 });
    const res = await history(id);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { submissions, nextCursor } = res.json();
    expect(nextCursor).toBeNull();
    expect(submissions.map((s: { number: number; status: string }) => [s.number, s.status])).toEqual([[2, "pending"], [1, "changes_requested"]]);
    expect(submissions[1]).toMatchObject({ number: 1, note: "one", comment: "Shorter", reviewer: "Dana Designer" });
    expect(submissions[0]).toMatchObject({ reviewer: null, comment: null });
    for (const secret of ["document", "overrides", "decidedByUserId", "submittedByUserId", "workspaceId", "email", "designer-1"]) expect(res.body, secret).not.toContain(secret);
  });

  it("shows 'Former team member' when the reviewer's account no longer exists, and names the person while it does", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    asDesigner();
    await decide(h.reviews[0].id, { decision: "approve" });
    asMarketing();
    expect((await history(id)).json().submissions[0].reviewer).toBe("Dana Designer");
    h.users = h.users.filter((u) => u.id !== "designer-1"); // the account was deleted
    h.members = []; // and they left the workspace
    expect((await history(id)).json().submissions[0].reviewer).toBe("Former team member");
    expect((await oneSubmission(id, 1)).json().submission.reviewer).toBe("Former team member");
    h.users.push({ id: "designer-1", name: "Dana Renamed" }); // a rename shows at once: names are read, never stored
    expect((await history(id)).json().submissions[0].reviewer).toBe("Dana Renamed");
  });

  it("one submission comes back as it was submitted, with its document, ready to draw", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2, note: "n" });
    const res = await oneSubmission(id, 1);
    expect(res.statusCode).toBe(200);
    const { submission } = res.json();
    expect(submission).toMatchObject({ number: 1, name: "Case Study", note: "n", status: "pending", baseRevision: { number: 1 } });
    expect(submission.document).toEqual(h.submissions[0].document);
    expect(res.body).not.toContain("overrides");
    expect(res.body).not.toContain("submittedByUserId");
  });

  it("pages with a cursor, and a bad limit or cursor is a 400", async () => {
    const { id } = await seedMine();
    for (let i = 0; i < 3; i++) {
      await submit(id, { version: 2 + i });
      await putInstance(id, { version: 2 + i, overrides: [{ nodeId: "head", text: `T${i}` }] });
    }
    const first = (await history(id, "?limit=2")).json();
    expect(first.submissions.map((s: { number: number }) => s.number)).toEqual([3, 2]);
    expect(first.nextCursor).toBe("2");
    const last = (await history(id, `?limit=2&cursor=${first.nextCursor}`)).json();
    expect(last.submissions.map((s: { number: number }) => s.number)).toEqual([1]);
    expect(last.nextCursor).toBeNull();
    for (const q of ["?limit=0", "?limit=x", "?cursor=abc", "?cursor=0", "?cursor=-1", "?cursor=1.5"]) expect((await history(id, q)).statusCode, q).toBe(400);
    expect((await oneSubmission(id, 0)).statusCode).toBe(404);
    expect((await oneSubmission(id, "x")).statusCode).toBe(404);
    expect((await oneSubmission(id, 99)).statusCode).toBe(404);
  });

  it("an empty history is an empty list, not a 404", async () => {
    const { id } = await seedMine();
    expect((await history(id)).json()).toEqual({ submissions: [], nextCursor: null, archived: false });
  });

  it("says whether the design is archived, so the page does not depend on which address it was opened from", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    expect((await history(id)).json().archived).toBe(false);
    await delInstance(id);
    expect((await history(id)).json().archived).toBe(true);
  });
});

describe("the designer's review queue", () => {
  async function onePending() {
    const { id } = await seedMine();
    await submit(id, { version: 2, note: "first" });
    return id;
  }

  it("the summary counts what waits and when the newest arrived", async () => {
    await onePending();
    asDesigner();
    const res = await reviewSummaryOf();
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({ pending: 1 });
    expect(res.json().latestSubmittedAt).not.toBeNull();
    Object.assign(h.reviews[0], { status: "approved", pendingInstanceId: null, decidedByUserId: "d", decidedAt: new Date() }); // (the double lets a test set the state directly)
    expect((await reviewSummaryOf()).json()).toEqual({ pending: 0, latestSubmittedAt: null });
  });

  it("the queue lists what waits by default, newest first, with the submitter's NAME and no email, document or person id", async () => {
    await onePending();
    asDesigner();
    const res = await queueOf();
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { reviews } = res.json();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ status: "pending", number: 1, name: "Case Study", note: "first", baseRevisionNumber: 1, submitter: "Mia Marketing", archivedBySubmitter: false });
    for (const secret of ["document", "email", "submittedByUserId", "decidedByUserId", "user-1", "workspaceId", "pendingInstanceId"]) expect(res.body, secret).not.toContain(secret);
  });

  it("'decided' lists approved and changes-requested ones, and not pending or superseded ones", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    await putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "B" }] });
    await submit(id, { version: 3 }); // the first is now superseded
    asDesigner();
    await decide(h.reviews[1].id, { decision: "approve" });
    expect((await queueOf("?status=decided")).json().reviews.map((r: { status: string }) => r.status)).toEqual(["approved"]);
    expect((await queueOf("?status=pending")).json().reviews).toEqual([]);
    expect(h.reviews.map((r) => r.status)).toEqual(["superseded", "approved"]);
  });

  it("is scoped to the designer's workspace: another workspace's submissions are never listed, opened or decided", async () => {
    await onePending();
    h.reviews[0].workspaceId = "ws-2";
    asDesigner();
    expect((await queueOf()).json().reviews).toEqual([]);
    expect((await reviewSummaryOf()).json().pending).toBe(0);
    expect((await reviewOf(h.reviews[0].id)).statusCode).toBe(404);
    expect((await decide(h.reviews[0].id, { decision: "approve" })).statusCode).toBe(404);
    expect(h.reviews[0].status).toBe("pending");
  });

  it("pages with a cursor like 'my designs', and a bad status, limit or cursor is a 400", async () => {
    const { id } = await seedMine();
    for (let i = 0; i < 3; i++) {
      await submit(id, { version: 2 + i });
      await putInstance(id, { version: 2 + i, overrides: [{ nodeId: "head", text: `T${i}` }] });
      asDesigner();
      await decide(h.reviews[h.reviews.length - 1].id, { decision: "approve" });
      asMarketing();
    }
    asDesigner();
    const first = (await queueOf("?status=decided&limit=2")).json();
    expect(first.reviews).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const rest = (await queueOf(`?status=decided&limit=2&cursor=${first.nextCursor}`)).json();
    expect(rest.reviews).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    for (const q of ["?status=nope", "?limit=0", "?limit=x", "?cursor=abc"]) expect((await queueOf(q)).statusCode, q).toBe(400);
  });

  it("the detail has the submitted document, what changed from the published revision (first) or the previous submission, and the history", async () => {
    const { id } = await seedMine([{ nodeId: "head", text: "First" }]);
    await submit(id, { version: 2 });
    await putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "Second" }] });
    await submit(id, { version: 3, note: "again" });
    asDesigner();
    const first = (await reviewOf(h.reviews[0].id)).json();
    expect(first.changes).toEqual([expect.objectContaining({ nodeId: "head", kind: "text", before: "Headline one", after: "First" })]); // against the revision
    const second = (await reviewOf(h.reviews[1].id)).json();
    expect(second.changes).toEqual([expect.objectContaining({ nodeId: "head", before: "First", after: "Second" })]); // against the previous submission
    expect(second.review).toMatchObject({ id: h.reviews[1].id, status: "pending", reviewer: null });
    expect(second.submission).toMatchObject({ number: 2, name: "Case Study", note: "again", submitter: "Mia Marketing", baseRevision: { number: 1 } });
    expect(second.submission.document).toEqual(h.submissions[1].document);
    expect(second.history.map((x: { number: number; status: string }) => [x.number, x.status])).toEqual([[2, "pending"], [1, "superseded"]]);
    expect(second.archivedBySubmitter).toBe(false);
    expect(first.rename).toBeNull(); // nothing to compare the first submission's name with
    expect(second.rename).toBeNull(); // the name did not change
    for (const secret of ["email", "submittedByUserId", "decidedByUserId", "overrides"]) expect(JSON.stringify(second), secret).not.toContain(secret);
  });

  it("a rename is shown as a change, though it is not a field: the name counts for resubmitting, so the designer must see it", async () => {
    const { id } = await seedMine([{ nodeId: "head", text: "Same" }]);
    await submit(id, { version: 2 });
    await putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "Same" }], name: "Case Study Q4" }); // only the name changes
    await submit(id, { version: 3 });
    asDesigner();
    const second = (await reviewOf(h.reviews[1].id)).json();
    expect(second.changes).toEqual([]);
    expect(second.rename).toEqual({ before: "Case Study", after: "Case Study Q4" });
  });

  it("an unknown or malformed review id is a 404", async () => {
    asDesigner();
    for (const id of ["nope", "a%00b"]) {
      expect((await reviewOf(id)).statusCode, id).toBe(404);
      expect((await decide(id, { decision: "approve" })).statusCode, id).toBe(404);
    }
  });
});

describe("POST /canvas/reviews/:id/decision", () => {
  async function pending() {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    asDesigner();
    return { id, rv: h.reviews[0] };
  }

  it("approves: one conditional update on status = pending, naming the workspace, and stamping who and when", async () => {
    const { rv } = await pending();
    const res = await decide(rv.id, { decision: "approve", comment: " Nice " });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, review: { id: rv.id, status: "approved" } });
    expect(rv).toMatchObject({ status: "approved", pendingInstanceId: null, comment: "Nice", decidedByUserId: "designer-1" });
    expect(rv.decidedAt).toBeInstanceOf(Date);
    expect(db.designReviewRequest.updateMany.mock.calls.at(-1)![0].where).toEqual({ id: rv.id, workspaceId: "ws-1", status: "pending" });
  });

  it("asks for changes only WITH a comment, and a blank one is a 400 that changes nothing", async () => {
    const { rv } = await pending();
    for (const body of [{ decision: "request_changes" }, { decision: "request_changes", comment: "   " }]) expect((await decide(rv.id, body)).statusCode).toBe(400);
    expect(rv.status).toBe("pending");
    expect((await decide(rv.id, { decision: "request_changes", comment: "Shorter" })).json().review.status).toBe("changes_requested");
    expect(rv).toMatchObject({ comment: "Shorter", decidedByUserId: "designer-1" });
  });

  it("a comment over 2000 characters, an unknown decision and extra fields are 400s; a non-JSON body is 415", async () => {
    const { rv } = await pending();
    for (const body of [{ decision: "approve", comment: "a".repeat(2001) }, { decision: "reject" }, { decision: "approve", status: "approved" }, { decision: "approve", decidedByUserId: "x" }, {}]) {
      expect((await decide(rv.id, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(rv.status).toBe("pending");
    expect((await app.inject({ method: "POST", url: `/canvas/reviews/${rv.id}/decision`, headers: { "content-type": "text/plain" }, payload: "{}" })).statusCode).toBe(415);
  });

  it("409 NOT_PENDING for a review that was already answered, and the first answer stands", async () => {
    const { rv } = await pending();
    await decide(rv.id, { decision: "approve" });
    const again = await decide(rv.id, { decision: "request_changes", comment: "Too late" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "NOT_PENDING" });
    expect(rv).toMatchObject({ status: "approved", comment: null });
  });

  it("409 NOT_PENDING for a review a newer submission replaced", async () => {
    const { id, rv } = await pending();
    asMarketing();
    await putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "Newer" }] });
    await submit(id, { version: 3 });
    asDesigner();
    expect(rv.status).toBe("superseded");
    const res = await decide(rv.id, { decision: "approve" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NOT_PENDING" });
    expect(rv.status).toBe("superseded");
  });

  it("two designers answering at once: exactly one wins", async () => {
    const { rv } = await pending();
    const [a, b] = await Promise.all([decide(rv.id, { decision: "approve" }), decide(rv.id, { decision: "request_changes", comment: "No" })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(["approved", "changes_requested"]).toContain(rv.status);
  });

  it("touches nothing but the review: not the submission, the instance or the template", async () => {
    const { id, rv } = await pending();
    const before = JSON.stringify([h.submissions, h.designs, h.templates, h.revisions]);
    db.design.updateMany.mockClear();
    await decide(rv.id, { decision: "approve" });
    expect(JSON.stringify([h.submissions, h.designs, h.templates, h.revisions])).toBe(before);
    expect(db.design.updateMany).not.toHaveBeenCalled();
    expect(inst(id).version).toBe(2);
  });

  it("works on a review whose design was archived (B1): a pending submission of an archived design is still decidable", async () => {
    const { id, rv } = await pending();
    asMarketing();
    expect((await delInstance(id)).json()).toMatchObject({ archived: true });
    asDesigner();
    expect((await reviewOf(rv.id)).json().archivedBySubmitter).toBe(true);
    expect((await queueOf()).json().reviews[0].archivedBySubmitter).toBe(true);
    expect((await decide(rv.id, { decision: "approve" })).statusCode).toBe(200);
    expect(rv.status).toBe("approved");
  });
});

describe("deleting or archiving a design (P6-D2)", () => {
  it("a design that was NEVER submitted is deleted for good, as in phase 5", async () => {
    const { id } = await seedMine();
    const res = await delInstance(id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(h.designs.some((d) => d.id === id)).toBe(false);
  });

  it("a design with a PENDING submission is archived, never deleted, and its snapshots and review are untouched", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    const before = JSON.stringify([h.submissions, h.reviews]);
    const res = await delInstance(id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, archived: true });
    expect(inst(id).archivedAt).toBeInstanceOf(Date);
    expect(inst(id).version).toBe(2); // archiving is not an edit
    expect(JSON.stringify([h.submissions, h.reviews])).toBe(before);
    expect(db.design.deleteMany).not.toHaveBeenCalled();
  });

  it.each([["approved"], ["changes_requested"], ["superseded"]])("a design whose latest review is %s is archived too: any submission at all blocks the hard delete", async (status) => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    Object.assign(h.reviews[0], { status, pendingInstanceId: null, comment: status === "changes_requested" ? "c" : null, decidedAt: status === "superseded" ? null : new Date(), decidedByUserId: status === "superseded" ? null : "designer-1" });
    expect((await delInstance(id)).json()).toEqual({ ok: true, archived: true });
    expect(h.designs.some((d) => d.id === id)).toBe(true);
    expect(h.submissions).toHaveLength(1);
  });

  it("asking again is the same answer (idempotent) and does not archive twice; a design that is not mine is a 404", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    await delInstance(id);
    const stamp = inst(id).archivedAt;
    expect((await delInstance(id)).json()).toEqual({ ok: true, archived: true });
    expect(inst(id).archivedAt).toBe(stamp);
    seedInstance({ id: "theirs", createdByUserId: "someone-else" });
    expect((await delInstance("theirs")).statusCode).toBe(404);
    expect(h.designs.some((d) => d.id === "theirs")).toBe(true);
  });

  it("takes the instance lock first, counts the submissions inside the same transaction, and takes no other lock", async () => {
    const { id } = await seedMine();
    h.log = [];
    await delInstance(id);
    expect(h.log.filter((e) => e.startsWith("lock:"))).toEqual(["lock:instance"]);
    expect(h.log.indexOf("lock:instance")).toBeGreaterThan(h.log.indexOf("tx:begin"));
    expect(h.log.indexOf("tx:end")).toBeGreaterThan(h.log.indexOf("write:design.delete"));
    expect(h.log).toContain("tx:designSubmission.count");
  });

  it("a submission that appeared between the count and the delete: the foreign key refuses the delete (P2003) and the retry archives", async () => {
    const { id } = await seedMine();
    db.design.deleteMany.mockImplementationOnce(async () => {
      const late = { id: "late", workspaceId: "ws-1", instanceId: id, number: 1, instanceVersion: 2, name: "x", note: null, baseRevisionId: "r-base-1", overrides: {}, document: {}, submittedByUserId: "user-1", createdAt: new Date() };
      h.submissions.push(late);
      h.outsideSubmissions.push(late); // committed by another connection: this transaction's rollback does not take it back
      throw Object.assign(new Error("Foreign key constraint failed on the field: `DesignSubmission_instanceId_fkey`"), { code: "P2003" });
    });
    const res = await delInstance(id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, archived: true });
    expect(h.designs.some((d) => d.id === id)).toBe(true);
  });

  it("the DATABASE refuses to hard-delete a submitted instance by itself (the foreign key), whatever the route does", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    await expect(db.design.deleteMany({ where: { id } })).rejects.toMatchObject({ code: "P2003" });
    expect(h.designs.some((d) => d.id === id)).toBe(true);
  });

  it("an error other than the foreign key is not swallowed", async () => {
    const { id } = await seedMine();
    db.design.deleteMany.mockRejectedValueOnce(new Error("db down"));
    expect((await delInstance(id)).statusCode).toBe(500);
  });

  it("the images stay: neither deleting nor archiving touches an asset", async () => {
    const { id } = await seedMine();
    h.rows.push({ id: "asset-9", workspaceId: "ws-1", storageRef: "x" });
    await delInstance(id);
    expect(h.rows.some((r) => r.id === "asset-9")).toBe(true);
  });
});

describe("an archived design is frozen, but its history is not", () => {
  async function archived() {
    const mine = await seedMine();
    await submit(mine.id, { version: 2, note: "n" });
    await delInstance(mine.id);
    return mine;
  }

  it("the editor's read, a save and a submit all answer 404 DESIGN_ARCHIVED (not 'deleted'), and write nothing", async () => {
    const { id } = await archived();
    const before = JSON.stringify([h.designs, h.submissions, h.reviews]);
    for (const call of [() => getInstance(id), () => putInstance(id, { version: 2, overrides: [] }), () => putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "x" }], name: "Y" }), () => submit(id, { version: 2 })]) {
      const res = await call();
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: "DESIGN_ARCHIVED" });
    }
    expect(JSON.stringify([h.designs, h.submissions, h.reviews])).toBe(before);
  });

  it("a save that raced the archive (past the read) is refused by the conditional update, not applied", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    db.design.findFirst.mockImplementationOnce(async () => ({ version: 2, name: "Case Study", overrides: inst(id).overrides, archivedAt: null, baseRevision: { document: h.revisions[0].document, manifest: h.revisions[0].manifest } }));
    inst(id).archivedAt = new Date(); // archived after the read
    const res = await putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "late" }] });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "DESIGN_ARCHIVED" });
  });

  it("an archived design is not in 'my designs'; ?archived=1 lists only the archived ones, and a bad value is a 400", async () => {
    const { id } = await archived();
    expect((await listInstances()).json().instances.map((i: { id: string }) => i.id)).not.toContain(id);
    const only = (await listInstances("?archived=1")).json().instances;
    expect(only.map((i: { id: string }) => i.id)).toEqual([id]);
    expect(only[0].archivedAt).not.toBeNull();
    expect(only[0].review).toMatchObject({ latestReviewStatus: "pending" });
    expect((await listInstances("?archived=0")).statusCode).toBe(200);
    for (const q of ["?archived=2", "?archived=true", "?archived="]) expect((await listInstances(q)).statusCode, q).toBe(400);
  });

  it("its submission history stays readable by its owner, reviewer names included", async () => {
    const { id } = await archived();
    asDesigner();
    await decide(h.reviews[0].id, { decision: "request_changes", comment: "Shorter" });
    asMarketing();
    const list = (await history(id)).json();
    expect(list.submissions).toHaveLength(1);
    expect(list.submissions[0]).toMatchObject({ number: 1, status: "changes_requested", comment: "Shorter", reviewer: "Dana Designer", note: "n" });
    const one = (await oneSubmission(id, 1)).json().submission;
    expect(one.document).toEqual(h.submissions[0].document);
    expect(one.reviewer).toBe("Dana Designer");
  });

  it("someone else's archived design is still a plain 404 for its history", async () => {
    const { id } = await archived();
    h.userId = "someone-else";
    expect((await history(id)).statusCode).toBe(404);
    expect((await oneSubmission(id, 1)).statusCode).toBe(404);
  });

  it("the database's frozen trigger refuses any later update of an archived design, even one that skips the route", async () => {
    const { id } = await archived();
    await expect(db.design.updateMany({ where: { id }, data: { name: "x", version: { increment: 1 } } })).rejects.toMatchObject({ code: "P2010" });
    await expect(db.design.updateMany({ where: { id }, data: { archivedAt: new Date() } })).rejects.toMatchObject({ code: "P2010" });
  });
});

describe("what the review state shows on the design", () => {
  it("GET one carries the two facts: the latest review status and whether there are unsubmitted changes", async () => {
    const { id } = await seedMine();
    expect((await getInstance(id)).json().instance.review).toMatchObject({ latestReviewStatus: null, hasChangesSinceSubmitted: false });
    await submit(id, { version: 2, note: "n" });
    const afterSubmit = (await getInstance(id)).json().instance;
    expect(afterSubmit.review).toMatchObject({ latestReviewStatus: "pending", hasChangesSinceSubmitted: false, submissionNumber: 1, submittedVersion: 2, workingVersion: 2 });
    expect(afterSubmit.submitted).toEqual({ name: "Case Study", overrides: [{ nodeId: "head", text: "Mine" }] }); // what the editor compares its live state with
    expect(JSON.stringify(afterSubmit.submitted)).not.toContain("note"); // the note is not an input to a change
    await putInstance(id, { version: 2, overrides: [{ nodeId: "head", text: "Edited" }] });
    expect((await getInstance(id)).json().instance.review).toMatchObject({ latestReviewStatus: "pending", hasChangesSinceSubmitted: true, workingVersion: 3 }); // an edit does NOT clear the status
    asDesigner();
    await decide(h.reviews[0].id, { decision: "approve" });
    asMarketing();
    expect((await getInstance(id)).json().instance.review).toMatchObject({ latestReviewStatus: "approved", hasChangesSinceSubmitted: true });
  });

  it("the list carries it for every design of the page, from ONE query", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    seedInstance({ id: "plain" });
    db.$queryRaw.mockClear();
    const res = await listInstances();
    const byId = Object.fromEntries(res.json().instances.map((i: { id: string; review: unknown }) => [i.id, i.review]));
    expect(byId[id]).toMatchObject({ latestReviewStatus: "pending", hasChangesSinceSubmitted: false });
    expect(byId.plain).toMatchObject({ latestReviewStatus: null, hasChangesSinceSubmitted: false });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(String(db.$queryRaw.mock.calls[0][0].join("?"))).toContain("DISTINCT ON");
  });

  it("an empty page makes no review query at all", async () => {
    h.role = "member";
    db.$queryRaw.mockClear();
    expect((await listInstances()).json().instances).toEqual([]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("a template design a submission was made from cannot be deleted (the extra safeguard)", () => {
  it("DELETE /canvas/designs/:id counts submissions as well as instances, and refuses with DESIGN_IN_USE", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    h.designs = h.designs.filter((d) => d.id !== id); // only the snapshot is left to pin the revision
    h.submissions[0].instanceId = "gone";
    h.templates = [];
    asDesigner();
    const res = await app.inject({ method: "DELETE", url: "/canvas/designs/base" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "DESIGN_IN_USE" });
    expect(h.designs.some((d) => d.id === "base")).toBe(true);
  });

  it("an ARCHIVED instance still counts: the design it pins cannot be deleted", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    await delInstance(id);
    h.templates = [];
    asDesigner();
    const res = await app.inject({ method: "DELETE", url: "/canvas/designs/base" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "DESIGN_IN_USE" });
  });

  it("the database refuses it too, whatever the route checked: DesignSubmission_baseRevisionId_fkey", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    h.designs = h.designs.filter((d) => d.id !== id);
    h.submissions[0].instanceId = "gone";
    await expect(db.design.deleteMany({ where: { id: "base" } })).rejects.toMatchObject({ code: "P2003" });
  });
});

describe("the double's own rules for the new tables (so the routes are tested against them)", () => {
  it("a submission can never be updated or deleted, and a review only leaves 'pending' once", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    await expect(db.designSubmission.updateMany({ where: {}, data: { name: "x" } })).rejects.toMatchObject({ code: "P2010" });
    await expect(db.designSubmission.deleteMany({ where: {} })).rejects.toMatchObject({ code: "P2010" });
    await expect(db.designReviewRequest.deleteMany({ where: {} })).rejects.toMatchObject({ code: "P2010" });
    const rv = h.reviews[0];
    await db.designReviewRequest.updateMany({ where: { id: rv.id }, data: { status: "approved", pendingInstanceId: null, decidedByUserId: "d", decidedAt: new Date() } });
    await expect(db.designReviewRequest.updateMany({ where: { id: rv.id }, data: { status: "changes_requested", comment: "x", decidedByUserId: "d", decidedAt: new Date() } })).rejects.toMatchObject({ code: "P2010" });
    expect(id).toBeTruthy();
  });

  it("the review table's CHECKs: pending iff pendingInstanceId, a decision needs who and when, changes need a comment, one pending per design", async () => {
    const { id } = await seedMine();
    await submit(id, { version: 2 });
    const second = { ...h.submissions[0], id: "sub-x", number: 2, instanceVersion: 9 };
    h.submissions.push(second);
    const make = (data: Record<string, unknown>) => db.designReviewRequest.create({ data: { workspaceId: "ws-1", submissionId: "sub-x", ...data }, select: { id: true } });
    await expect(make({ status: "pending", pendingInstanceId: null })).rejects.toMatchObject({ code: "P2004" });
    await expect(make({ status: "approved", pendingInstanceId: id })).rejects.toMatchObject({ code: "P2004" });
    await expect(make({ status: "approved", pendingInstanceId: null, decidedAt: null })).rejects.toMatchObject({ code: "P2004" });
    await expect(make({ status: "changes_requested", pendingInstanceId: null, decidedAt: new Date(), decidedByUserId: "d", comment: "  " })).rejects.toMatchObject({ code: "P2004" });
    await expect(make({ status: "weird", pendingInstanceId: null })).rejects.toMatchObject({ code: "P2004" });
    await expect(make({ status: "pending", pendingInstanceId: id })).rejects.toMatchObject({ code: "P2002" }); // one pending review per design
  });

  it("only an instance can be archived (Design_archive_check)", async () => {
    seedCampaign();
    await expect(db.design.updateMany({ where: { id: "base" }, data: { archivedAt: new Date() } })).rejects.toMatchObject({ code: "P2004" });
  });

  it("a where key the double does not know fails the test instead of being ignored", async () => {
    seedDesign(); // with no row the matcher never runs
    await expect(db.design.findFirst({ where: { archived: true }, select: { id: true } })).rejects.toThrow(/does not understand/);
  });
});

describe("rate limiting of the Canvas routes", () => {
  // The real @fastify/rate-limit with the real helper on a tiny app. The route tests above mock auth, so the ORDER of auth and
  // limiter, and the key, are proven here against the actual plugin.
  async function limited(max: number) {
    const [{ default: FastifyApp }, { default: rateLimit }, { userLimit }] = await Promise.all([import("fastify"), import("@fastify/rate-limit"), import("../lib/userRateLimit.js")]);
    const a = FastifyApp();
    // the same global limiter shape as src/index.ts: it would key every proxied browser on the shared address
    await a.register(rateLimit, { global: true, max: 1000, timeWindow: "1 minute", keyGenerator: (req) => req.ip });
    const seen: string[] = [];
    const auth = async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
      seen.push("auth");
      const who = req.headers["x-user"];
      if (!who) return reply.status(401).send({ error: "no" });
      req.user = { id: String(who) } as never;
      req.workspaceId = String(req.headers["x-ws"] ?? "ws-1");
    };
    a.post("/w", { preHandler: [auth], config: userLimit(max) }, async () => {
      seen.push("handler");
      return { ok: true };
    });
    await a.ready();
    const hit = (user?: string, ws?: string) => a.inject({ method: "POST", url: "/w", remoteAddress: "10.0.0.1", headers: { ...(user ? { "x-user": user } : {}), ...(ws ? { "x-ws": ws } : {}) } }).then((r) => r.statusCode);
    return { a, hit, seen };
  }

  it("two people behind the SAME address get separate allowances (the proxy's address is not the key)", async () => {
    const { a, hit } = await limited(2);
    expect([await hit("ann"), await hit("ann"), await hit("ann")]).toEqual([200, 200, 429]);
    expect([await hit("bob"), await hit("bob"), await hit("bob")]).toEqual([200, 200, 429]); // bob is not held back by ann
    await a.close();
  });

  it("the same person in another workspace has a separate allowance", async () => {
    const { a, hit } = await limited(1);
    expect([await hit("ann", "ws-1"), await hit("ann", "ws-1"), await hit("ann", "ws-2")]).toEqual([200, 429, 200]);
    await a.close();
  });

  it("authentication runs BEFORE the limiter: an unauthenticated request is a 401, never reaches the handler, and uses up nothing", async () => {
    const { a, hit, seen } = await limited(1);
    for (let i = 0; i < 5; i++) expect(await hit()).toBe(401); // never a 429, however many
    expect(seen.filter((s) => s === "handler")).toHaveLength(0);
    expect(await hit("ann")).toBe(200); // the 401s did not consume anyone's allowance
    await a.close();
  });

  it("the key: a person in a workspace is 'workspace:person'; with no person it falls back to the address, never to one shared key", async () => {
    const { userKey } = await import("../lib/userRateLimit.js");
    expect(userKey({ ip: "1.2.3.4" } as never)).toBe("1.2.3.4");
    expect(userKey({ ip: "1.2.3.4", user: { id: "u" } } as never)).toBe("1.2.3.4");
    expect(userKey({ ip: "1.2.3.4", user: { id: "u" }, workspaceId: "w" } as never)).toBe("w:u");
  });

  /** Every route `canvasRoutes` registers (the review routes included), with its limiter and its hooks, read as Fastify builds them. */
  async function describeRoutes(withGate: boolean) {
    const routes = new Map<string, { max?: number; hook?: string; keyed: boolean; pre: string[]; onRequest: number }>();
    const probe = Fastify();
    probe.addHook("onRoute", (r) => {
      const rl = (r.config as { rateLimit?: { max: number; hook?: string; keyGenerator?: unknown } } | undefined)?.rateLimit;
      const pre = ([] as unknown[]).concat(r.preHandler ?? []).map((f) => (f as { name?: string }).name ?? "");
      routes.set(`${String(r.method)} ${r.url}`, { max: rl?.max, hook: rl?.hook, keyed: typeof rl?.keyGenerator === "function", pre, onRequest: ([] as unknown[]).concat(r.onRequest ?? []).length });
    });
    await probe.register(multipart);
    await probe.register(canvasRoutes, { storage, ...(withGate ? {} : { gate: false }) } as never);
    await probe.ready();
    await probe.close();
    return routes;
  }

  it("EVERY Canvas route is limited per person after authentication (found by enumerating, not by a list), with the approved numbers", async () => {
    const routes = await describeRoutes(false);
    expect(routes.size).toBeGreaterThanOrEqual(23); // a floor, so an empty enumeration cannot pass
    for (const [name, r] of routes) {
      expect(r.keyed, `${name} is keyed by the signed-in person`).toBe(true);
      expect(r.hook, `${name} runs after authentication`).toBe("preHandler");
      expect(r.max, `${name} has a number`).toBeGreaterThan(0);
      expect(r.pre.includes("canvasWithAuth"), `${name} authenticates through the gated withAuth`).toBe(true);
    }
    // the numbers: the ones that existed are unchanged; reads are 120 a minute, the two deletes of designs 30
    const max = (k: string) => routes.get(k)?.max;
    expect(max("POST /canvas/instances/:id/submit")).toBe(10);
    expect(max("POST /canvas/reviews/:id/decision")).toBe(30);
    expect(max("DELETE /canvas/instances/:id")).toBe(30);
    expect(max("PUT /canvas/instances/:id")).toBe(120);
    expect(max("PUT /canvas/designs/:id")).toBe(120);
    expect(max("POST /canvas/instances")).toBe(30);
    expect(max("POST /canvas/designs")).toBe(30);
    expect(max("POST /canvas/designs/:id/publish")).toBe(10);
    expect(max("POST /canvas/assets")).toBe(30);
    expect(max("GET /canvas/assets/:id/content")).toBe(300);
    for (const read of ["GET /canvas/designs", "GET /canvas/designs/:id", "GET /canvas/instances", "GET /canvas/instances/:id", "GET /canvas/reviews", "GET /canvas/reviews/summary", "GET /canvas/reviews/:id", "GET /canvas/instances/:id/submissions", "GET /canvas/instances/:id/submissions/:number"]) expect(max(read), read).toBe(120);
    for (const del of ["DELETE /canvas/designs/:id", "DELETE /canvas/templates/:id/design"]) expect(max(del), del).toBe(30);
  });

  it("the auth gate covers EVERY Canvas route: a cookie-less flood beyond the budget is a 429 from the gate on each one, and the same flood is untouched when the gate is off", async () => {
    // Scope hooks are merged into a route only when Fastify is ready, so they are not visible in onRoute: prove it by behavior.
    // The auth double and the handlers are never reached by a refused request, so every route can be probed with no data.
    const routes = [...(await describeRoutes(true)).keys()];
    expect(routes.length).toBeGreaterThanOrEqual(23);
    const { createCanvasAuthGate } = await import("../lib/canvasAuthGate.js");
    const gated = Fastify();
    await gated.register(multipart);
    await gated.register(canvasRoutes, { storage, gate: createCanvasAuthGate({ params: { anon: 2 } }) } as never);
    await gated.ready();
    const open2 = Fastify();
    await open2.register(multipart);
    await open2.register(canvasRoutes, { storage, gate: false } as never);
    await open2.ready();
    h.authed = false; // the mocked authentication answers 401 to a request that reaches it
    let ip = 0;
    for (const key of routes) {
      const [method, pattern] = key.split(" ");
      const url = pattern.replace(":id", "abcdefghij").replace(":number", "1");
      const remoteAddress = `10.9.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`; // one address per route: the budget is per address
      const send = (a: FastifyInstance) => a.inject({ method: method as "GET", url, remoteAddress });
      const first = [(await send(gated)).statusCode, (await send(gated)).statusCode];
      const third = await send(gated);
      expect(first, `${key}: within the budget it reaches authentication and is refused there`).not.toContain(429);
      expect(third.statusCode, `${key}: beyond the budget the gate answers`).toBe(429);
      expect(third.headers["retry-after"], key).toBeTruthy();
      for (let i = 0; i < 4; i++) expect((await send(open2)).statusCode, `${key}: with the gate off nothing is counted`).not.toBe(429);
    }
    await gated.close();
    await open2.close();
  });

  it("both PUTs go through the JSON-only guard (before they read a body)", async () => {
    const routes = await describeRoutes(false);
    for (const put of ["PUT /canvas/designs/:id", "PUT /canvas/instances/:id"]) expect(routes.get(put)?.pre, put).toContain("jsonOnly");
  });
});
