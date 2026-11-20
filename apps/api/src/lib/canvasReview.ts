import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { RevisionUnreadable, manifestSchema, readOverrides, sameOverrides, storable, type OverrideEntry } from "./canvas.js";

/**
 * Design review (phase 6): what Marketing submits and what a designer answers. Pure functions and request bodies only; the
 * routes (routes/canvasReview.ts) own every query. Nothing here reads a client's document: a submission is composed on the
 * SERVER from the pinned revision and the stored overrides.
 */

export const REVIEW_LIMITS = { note: 500, comment: 2000 } as const;
export const REVIEW_STATUSES = ["pending", "approved", "changes_requested", "superseded"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

// What a person types into a note or a comment: trimmed, with no control character except a line break or a tab, and nothing
// PostgreSQL cannot store. An empty result means "nothing was written".
const CONTROL_EXCEPT_WHITESPACE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const freeText = (max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().max(max, `Use up to ${max} characters.`).refine((s) => !CONTROL_EXCEPT_WHITESPACE.test(s) && storable(s), "Contains a character that cannot be stored."));

/** POST /canvas/instances/:id/submit. The version the editor saved and an optional note; nothing else (no document, no overrides). */
export const submitBody = z
  .object({ version: z.number().int().min(1).max(2_000_000_000), note: freeText(REVIEW_LIMITS.note).optional() })
  .strict();

/** POST /canvas/reviews/:id/decision. Asking for changes needs a comment saying what. */
export const decisionBody = z
  .object({ decision: z.enum(["approve", "request_changes"]), comment: freeText(REVIEW_LIMITS.comment).optional() })
  .strict()
  .superRefine((b, ctx) => {
    if (b.decision === "request_changes" && !b.comment) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["comment"], message: "Say what needs to change." });
  });

// ── Composing the snapshot on the server ────────────────────────────────────

/** The composed document did not come out as the pinned revision plus the permitted overrides. Nothing is written. */
export class ComposeFailed extends Error {}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const sameKeys = (a: Json, b: Json) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k));
};

/**
 * The revision's document with the overrides applied: `text` on a text layer and `assetId` on an image layer, and only
 * where the revision's manifest lists that layer with that kind. The same rules as the engine's applyOverrides
 * (apps/canvas/src/document.ts; canvas.test.ts compares the two), written for a stored document.
 *
 * Then the result is CHECKED, not trusted (verifyComposed): the layers, their order and their types are the revision's, and
 * every property is exactly the revision's except the permitted field of an overridden layer. This is deliberately not a
 * re-parse with the document schema, so a later tightening of that schema cannot make an old revision impossible to submit.
 * Throws RevisionUnreadable when the revision is not what publishing wrote, ComposeFailed when the check fails.
 * `entries` must already be validated and normalized (validateOverrides).
 */
export function composeDocument(revision: { document: unknown; manifest: unknown }, entries: readonly OverrideEntry[]): Json {
  const manifest = manifestSchema.safeParse(revision.manifest);
  if (!manifest.success) throw new RevisionUnreadable("The revision's manifest is not valid.");
  const base = revision.document;
  if (!isObject(base) || !Array.isArray(base.nodes) || !base.nodes.every(isObject)) throw new RevisionUnreadable("The revision's document has no valid layers.");
  const kinds = new Map(manifest.data.fields.map((f) => [f.nodeId, f.kind])); // Maps: "__proto__" must find nothing
  const byNode = new Map(entries.map((e) => [e.nodeId, e]));

  const nodes = (base.nodes as Json[]).map((n) => {
    const o = typeof n.id === "string" ? byNode.get(n.id) : undefined;
    const kind = typeof n.id === "string" ? kinds.get(n.id) : undefined;
    if (!o) return n;
    if (n.type === "text" && kind === "text" && "text" in o && o.text !== n.text) return { ...n, text: o.text };
    if (n.type === "image" && kind === "image" && "assetId" in o && o.assetId !== n.assetId) return { ...n, assetId: o.assetId };
    return n;
  });
  const composed = { ...base, nodes };
  verifyComposed(base, kinds, byNode, entries.length, composed);
  return composed;
}

/** The post-condition of composeDocument, derived again from the inputs on its own (it shares no code with the composing). */
function verifyComposed(base: Json, kinds: ReadonlyMap<string, "text" | "image">, byNode: ReadonlyMap<string, OverrideEntry>, entryCount: number, composed: Json): void {
  const fail = (why: string): never => {
    throw new ComposeFailed(why);
  };
  if (!sameKeys(base, composed)) fail("The document's own fields changed.");
  for (const k of Object.keys(base)) if (k !== "nodes" && !isDeepStrictEqual(base[k], composed[k])) fail(`The document's "${k}" changed.`);

  const was = base.nodes as Json[];
  const now = composed.nodes;
  if (!Array.isArray(now) || now.length !== was.length) fail("The number of layers changed.");
  let reflected = 0;
  was.forEach((before, i) => {
    const after = (now as unknown[])[i];
    if (!isObject(after)) return fail(`Layer ${i} is not an object.`);
    if (before.id !== after.id || before.type !== after.type) return fail(`Layer ${i} changed its id, type or place.`);
    if (!sameKeys(before, after)) return fail(`Layer ${String(before.id)} gained or lost a property.`);
    const entry = typeof before.id === "string" ? byNode.get(before.id) : undefined;
    const kind = typeof before.id === "string" ? kinds.get(before.id) : undefined;
    // The one property an override may set on this layer, if any.
    const field = entry && before.type === "text" && kind === "text" && "text" in entry ? "text" : entry && before.type === "image" && kind === "image" && "assetId" in entry ? "assetId" : null;
    for (const k of Object.keys(before)) {
      if (k === field) {
        if (after[k] !== (entry as unknown as Json)[k]) fail(`Layer ${String(before.id)}: "${k}" is not the overridden value.`);
        reflected++;
      } else if (!isDeepStrictEqual(before[k], after[k])) {
        fail(`Layer ${String(before.id)}: "${k}" changed, and it may not.`);
      }
    }
  });
  if (reflected !== entryCount) fail("An override was not applied to the layer it names (or names one twice).");
}

// ── What counts as a change ─────────────────────────────────────────────────

/** What the latest submission of an instance recorded, as far as a comparison needs. */
export interface LatestSubmission {
  instanceVersion: number;
  name: string;
  overrides: unknown;
}

/** The instance as it is stored now. `overrides` is the normalized entry list (readOverrides). */
export interface WorkingState {
  version: number;
  name: string;
  overrides: readonly OverrideEntry[];
}

/**
 * Whether the instance differs from its latest submission in anything a reviewer sees: its name and its (normalized)
 * overrides. The note, the version, the dates and the composed document do not count (the document is derived from the
 * overrides and the pinned revision, which never changes). Nothing submitted yet is always a change.
 *
 * The version is a cheap exact test for "same": only a save that changes the stored overrides or the name bumps it. A
 * different version does NOT prove a different design (A, then B, then A again), so the content is compared as well, and
 * the same state may be submitted again after another one in between: there is no unique key on the content.
 */
export function changedSince(latest: LatestSubmission | null, now: WorkingState): boolean {
  if (!latest) return true;
  if (latest.instanceVersion === now.version) return false;
  const stored = readOverrides(latest.overrides);
  if (!stored) return true; // a snapshot that cannot be read proves nothing: let the person submit again
  return latest.name !== now.name || !sameOverrides(stored, now.overrides);
}

/** The latest submission and its review, with what the summary reports about them. */
export interface SubmissionFacts extends LatestSubmission {
  id: string;
  number: number;
  createdAt: Date;
  review: { id: string; status: string; comment: string | null; decidedAt: Date | null } | null;
}

export interface ReviewSummary {
  latestReviewStatus: ReviewStatus | null;
  hasChangesSinceSubmitted: boolean;
  submissionNumber: number | null;
  submittedVersion: number | null;
  workingVersion: number;
  submittedAt: string | null;
  latestReviewId: string | null;
  comment: string | null;
  decidedAt: string | null;
}

const isStatus = (s: unknown): s is ReviewStatus => (REVIEW_STATUSES as readonly unknown[]).includes(s);

/**
 * Review state is two independent facts (R3 §3.8): the status of the MOST RECENT submission's review, which a newer working
 * version never hides or changes, and whether the current work differs from that submission. "Approved" is a statement about
 * the submitted snapshot; an edit never clears it, it only sets `hasChangesSinceSubmitted`. Nothing submitted: null and false.
 */
export function reviewSummary(latest: SubmissionFacts | null, now: WorkingState): ReviewSummary {
  if (!latest) {
    return { latestReviewStatus: null, hasChangesSinceSubmitted: false, submissionNumber: null, submittedVersion: null, workingVersion: now.version, submittedAt: null, latestReviewId: null, comment: null, decidedAt: null };
  }
  const status = latest.review?.status;
  return {
    latestReviewStatus: isStatus(status) ? status : null,
    hasChangesSinceSubmitted: changedSince(latest, now),
    submissionNumber: latest.number,
    submittedVersion: latest.instanceVersion,
    workingVersion: now.version,
    submittedAt: latest.createdAt.toISOString(),
    latestReviewId: latest.review?.id ?? null,
    comment: latest.review?.comment ?? null,
    decidedAt: latest.review?.decidedAt?.toISOString() ?? null,
  };
}

// ── What a designer sees changed ────────────────────────────────────────────

export interface FieldChange {
  nodeId: string;
  name: string;
  kind: "text" | "image";
  before: string;
  after: string;
}

/**
 * The text and image fields that differ between two composed documents of the same revision (the previous submission, or the
 * revision itself for the first one, and this submission). Layers are matched by id, in the later document's order.
 */
export function changedFields(before: unknown, after: unknown): FieldChange[] {
  const layers = (doc: unknown): Json[] => (isObject(doc) && Array.isArray(doc.nodes) ? (doc.nodes as unknown[]).filter(isObject) : []);
  const was = new Map(layers(before).map((n) => [n.id, n]));
  const out: FieldChange[] = [];
  for (const n of layers(after)) {
    const p = was.get(n.id);
    if (!p || typeof n.id !== "string") continue;
    const name = typeof n.name === "string" ? n.name : n.id;
    if (n.type === "text" && typeof n.text === "string" && typeof p.text === "string" && n.text !== p.text) out.push({ nodeId: n.id, name, kind: "text", before: p.text, after: n.text });
    if (n.type === "image" && typeof n.assetId === "string" && typeof p.assetId === "string" && n.assetId !== p.assetId) out.push({ nodeId: n.id, name, kind: "image", before: p.assetId, after: n.assetId });
  }
  return out;
}
