import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { getUser, getWorkspaceId } from "../lib/auth/withAuth.js";
import { canvasWithAuth as withAuth } from "../lib/canvasAuthGate.js"; // the gated withAuth, see lib/canvasAuthGate.ts
import { prisma } from "../lib/prisma.js";
import { INSTANCE_PAGE, RevisionUnreadable, decodeCursor, encodeCursor, parseLimit, readOverrides, validateOverrides } from "../lib/canvas.js";
import { ARCHIVED, YOURS, contentEditorOnly, designerOnly, errorCode, invalidBody, isRefusal, jsonOnly, lockInstance, notFound, refuse, wellFormedId } from "../lib/canvasHttp.js";
import { changedFields, changedSince, composeDocument, decisionBody, submitBody } from "../lib/canvasReview.js";
import { latestSubmission, namesOf } from "../lib/canvasReviewDb.js";
import { userLimit } from "../lib/userRateLimit.js";

/**
 * Design review (phase 6). Marketing submits one of its designs; a designer approves it or asks for changes. Two kinds of
 * caller and nothing in between: Marketing (owner, admin, member) works on ITS OWN designs only, a designer reviews every
 * submission of the workspace, and neither can do the other's part. This is separate from the PostJob approval flow (jobs.ts).
 *
 * What is stored: a submission is an immutable snapshot composed on the SERVER (lib/canvasReview.ts composeDocument), a review
 * request leaves "pending" exactly once. Nothing here updates or deletes a submission. Names are read from User when shown and
 * are never stored; no response carries an email.
 */

const DEFAULT_PAGE = INSTANCE_PAGE.default;
const WHOLE = /^[1-9][0-9]{0,8}$/;

// The two views of the queue: still waiting, or answered (a superseded request was replaced, so it is in neither).
const queueStatus = (view: "pending" | "decided") => (view === "pending" ? "pending" : { in: ["approved", "changes_requested"] });

export async function canvasReviewRoutes(app: FastifyInstance): Promise<void> {
  // ── Marketing ─────────────────────────────────────────────────────────────

  // Submit for review. ONE transaction that takes the instance's row lock first (the lock archive and delete take too), and no
  // other lock: not the template's, not the template design's, so it cannot form a cycle with the phase 4 and 5 lock order. The
  // locked row is what everything below reads, so the snapshot is exactly the stored state, and a second tab's identical
  // request waits, then finds nothing changed.
  app.post("/canvas/instances/:id/submit", { preHandler: [withAuth, contentEditorOnly, wellFormedId("Design"), jsonOnly], config: userLimit(10) }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const userId = getUser(req).id;
    const { id } = req.params as { id: string };
    const parsed = submitBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(invalidBody(parsed.error));
    const { version, note } = parsed.data;

    let outcome;
    try {
      outcome = await prisma.$transaction(async (tx) => {
        const locked = await lockInstance(tx, id, workspaceId, userId);
        if (!locked) return refuse(404, "Design not found");
        if (locked.archivedAt) return ARCHIVED;

        const row = await tx.design.findFirst({
          where: { ...YOURS(id, workspaceId, userId), archivedAt: null },
          select: { version: true, name: true, overrides: true, baseRevision: { select: { id: true, document: true, manifest: true } } },
        });
        if (!row) return refuse(404, "Design not found");
        const stored = readOverrides(row.overrides);
        if (!row.baseRevision || !stored) throw new Error(`Design ${id} is not a valid instance.`); // damaged, not missing: fails closed, nothing is written
        if (row.version !== version) return refuse(409, "This design was changed somewhere else. Reload it and try again.", "VERSION_CONFLICT");

        // Review is the design team's: with nobody to answer, a submission would wait for ever.
        if ((await tx.workspaceMember.count({ where: { workspaceId, role: "designer" } })) === 0) {
          return refuse(409, "This workspace has no designer to review designs yet. Ask an admin to invite one.", "NO_REVIEWER");
        }

        const latest = await latestSubmission(tx, id);
        if (!changedSince(latest, { version: row.version, name: row.name, overrides: stored })) return refuse(409, "Nothing has changed since you last submitted this design.", "NO_CHANGES");

        // The stored set is checked against the pinned revision again, like a save: a set that no longer validates, or a revision
        // that is not what publishing wrote, is damage and fails closed (a logged 500, nothing written).
        const checked = validateOverrides(row.baseRevision, stored);
        if (!checked.ok) throw new Error(`The overrides of design ${id} no longer validate: ${checked.code}`);
        const assetIds = [...new Set(checked.fields.flatMap((f) => ("assetId" in f ? [f.assetId] : [])))];
        if (assetIds.length > 0 && (await tx.designAsset.count({ where: { id: { in: assetIds }, workspaceId } })) !== assetIds.length) {
          return refuse(409, "An image in this design is no longer available in this workspace. Replace it and try again.", "UNKNOWN_ASSET");
        }
        const document = composeDocument(row.baseRevision, checked.fields);

        // The previous pending review (if any) is replaced: both columns in one statement, because of the table's CHECK.
        await tx.designReviewRequest.updateMany({ where: { pendingInstanceId: id, status: "pending" }, data: { status: "superseded", pendingInstanceId: null } });
        const submission = await tx.designSubmission.create({
          data: {
            workspaceId,
            instanceId: id,
            number: (latest?.number ?? 0) + 1,
            instanceVersion: row.version,
            name: row.name,
            note: note || null,
            baseRevisionId: row.baseRevision.id,
            overrides: row.overrides as Prisma.InputJsonObject, // exactly what the instance held
            document: document as Prisma.InputJsonObject,
            submittedByUserId: userId,
          },
          select: { id: true, number: true, createdAt: true },
        });
        const review = await tx.designReviewRequest.create({ data: { workspaceId, submissionId: submission.id, status: "pending", pendingInstanceId: id }, select: { id: true, status: true } });
        return { submission, review };
      });
    } catch (err) {
      // The unique keys are only a backstop behind the lock: reaching one means an identical submission was just made.
      if (errorCode(err) === "P2002") return reply.status(409).send({ error: "Nothing has changed since you last submitted this design.", code: "NO_CHANGES" });
      if (err instanceof RevisionUnreadable) throw new Error(`The revision behind design ${id} cannot be read: ${err.message}`);
      throw err;
    }
    if (isRefusal(outcome)) return reply.status(outcome.status).send(outcome.body);
    return reply.status(201).send(outcome);
  });

  // My submissions of one design, newest first, with the answers (no documents). Readable whether or not the design is archived:
  // they come from the snapshots, not from the instance.
  app.get("/canvas/instances/:id/submissions", { preHandler: [withAuth, contentEditorOnly, wellFormedId("Design")], config: userLimit(120) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { limit: rawLimit, cursor: rawCursor } = req.query as { limit?: unknown; cursor?: unknown };
    const limit = parseLimit(rawLimit);
    if (limit === null) return reply.status(400).send({ error: "limit must be a whole number from 1 to 100", code: "INVALID_LIMIT" });
    if (rawCursor !== undefined && !(typeof rawCursor === "string" && WHOLE.test(rawCursor))) return reply.status(400).send({ error: "cursor is not valid. Start again from the first page.", code: "INVALID_CURSOR" });
    const design = await prisma.design.findFirst({ where: YOURS(id, getWorkspaceId(req), getUser(req).id), select: { archivedAt: true } });
    if (!design) return notFound(reply);

    const rows = await prisma.designSubmission.findMany({
      where: { instanceId: id, ...(rawCursor === undefined ? {} : { number: { lt: Number(rawCursor) } }) },
      orderBy: { number: "desc" },
      take: limit + 1,
      select: { number: true, name: true, note: true, createdAt: true, review: { select: { status: true, comment: true, decidedAt: true, decidedByUserId: true } } },
    });
    const page = rows.slice(0, limit);
    const nameOf = await namesOf(page.map((s) => s.review?.decidedByUserId));
    return reply.header("Cache-Control", "no-store").send({
      submissions: page.map(({ review, ...s }) => ({ ...s, status: review?.status ?? null, comment: review?.comment ?? null, decidedAt: review?.decidedAt ?? null, reviewer: nameOf(review?.decidedByUserId) })),
      nextCursor: rows.length > limit ? String(page[page.length - 1].number) : null,
      archived: design.archivedAt !== null, // the page says so, whichever address it was opened from
    });
  });

  // One of my submissions as it was submitted: the composed document, ready to draw read-only.
  app.get("/canvas/instances/:id/submissions/:number", { preHandler: [withAuth, contentEditorOnly, wellFormedId("Design")], config: userLimit(120) }, async (req, reply) => {
    const { id, number } = req.params as { id: string; number: string };
    if (!WHOLE.test(number)) return reply.status(404).send({ error: "Submission not found" });
    if (!(await prisma.design.findFirst({ where: YOURS(id, getWorkspaceId(req), getUser(req).id), select: { id: true } }))) return notFound(reply);
    const s = await prisma.designSubmission.findFirst({
      where: { instanceId: id, number: Number(number) },
      select: { number: true, name: true, note: true, createdAt: true, document: true, baseRevision: { select: { number: true } }, review: { select: { status: true, comment: true, decidedAt: true, decidedByUserId: true } } },
    });
    if (!s) return reply.status(404).send({ error: "Submission not found" });
    const nameOf = await namesOf([s.review?.decidedByUserId]);
    const { review, baseRevision, ...rest } = s;
    return reply.header("Cache-Control", "no-store").send({
      submission: { ...rest, baseRevision: { number: baseRevision.number }, status: review?.status ?? null, comment: review?.comment ?? null, decidedAt: review?.decidedAt ?? null, reviewer: nameOf(review?.decidedByUserId) },
    });
  });

  // ── The design team ───────────────────────────────────────────────────────

  // What the indicator in the top bar polls.
  app.get("/canvas/reviews/summary", { preHandler: [withAuth, designerOnly], config: userLimit(120) }, async (req, reply) => {
    const where = { workspaceId: getWorkspaceId(req), status: "pending" };
    const [pending, newest] = await Promise.all([
      prisma.designReviewRequest.count({ where }),
      prisma.designReviewRequest.findFirst({ where, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    ]);
    return reply.header("Cache-Control", "no-store").send({ pending, latestSubmittedAt: newest?.createdAt ?? null });
  });

  // The queue: waiting for review (default), or already answered. Newest submitted first, in pages like "my designs".
  app.get("/canvas/reviews", { preHandler: [withAuth, designerOnly], config: userLimit(120) }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const { status, limit: rawLimit, cursor: rawCursor } = req.query as { status?: unknown; limit?: unknown; cursor?: unknown };
    if (status !== undefined && status !== "pending" && status !== "decided") return reply.status(400).send({ error: "status must be pending or decided", code: "INVALID_STATUS" });
    const limit = parseLimit(rawLimit ?? String(DEFAULT_PAGE));
    if (limit === null) return reply.status(400).send({ error: "limit must be a whole number from 1 to 100", code: "INVALID_LIMIT" });
    const boundary = rawCursor === undefined ? null : decodeCursor(rawCursor);
    if (rawCursor !== undefined && boundary === null) return reply.status(400).send({ error: "cursor is not valid. Start again from the first page.", code: "INVALID_CURSOR" });

    const mine = { workspaceId, status: queueStatus(status === "decided" ? "decided" : "pending") };
    const after = boundary ? new Date(boundary.t) : null;
    const rows = await prisma.designReviewRequest.findMany({
      where: boundary && after ? { AND: [mine, { OR: [{ createdAt: { lt: after } }, { createdAt: after, id: { lt: boundary.i } }] }] } : mine,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        status: true,
        createdAt: true,
        decidedAt: true,
        submission: { select: { number: true, name: true, note: true, submittedByUserId: true, baseRevision: { select: { number: true } }, instance: { select: { archivedAt: true } } } },
      },
    });
    const page = rows.slice(0, limit);
    const nameOf = await namesOf(page.map((r) => r.submission.submittedByUserId));
    return reply.header("Cache-Control", "no-store").send({
      reviews: page.map(({ submission: s, ...r }) => ({
        ...r,
        number: s.number,
        name: s.name,
        note: s.note,
        baseRevisionNumber: s.baseRevision.number,
        submitter: nameOf(s.submittedByUserId),
        archivedBySubmitter: s.instance.archivedAt !== null,
      })),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    });
  });

  // One submission to review: the document as submitted, what changed since the previous submission (or since the published
  // revision, for the first one), and the earlier submissions of the same design.
  app.get("/canvas/reviews/:id", { preHandler: [withAuth, designerOnly, wellFormedId("Review")], config: userLimit(120) }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };
    const review = await prisma.designReviewRequest.findFirst({
      where: { id, workspaceId },
      select: {
        id: true,
        status: true,
        comment: true,
        createdAt: true,
        decidedAt: true,
        decidedByUserId: true,
        submission: {
          select: { instanceId: true, number: true, name: true, note: true, createdAt: true, submittedByUserId: true, document: true, baseRevisionId: true, baseRevision: { select: { number: true } }, instance: { select: { archivedAt: true } } },
        },
      },
    });
    if (!review) return reply.status(404).send({ error: "Review not found" });
    const s = review.submission;

    const previous = await prisma.designSubmission.findFirst({ where: { instanceId: s.instanceId, number: { lt: s.number } }, orderBy: { number: "desc" }, select: { document: true, name: true } });
    const before = previous ? previous.document : (await prisma.designRevision.findFirst({ where: { id: s.baseRevisionId }, select: { document: true } }))?.document;
    const history = await prisma.designSubmission.findMany({
      where: { instanceId: s.instanceId },
      orderBy: { number: "desc" },
      take: 50, // shortcut: no paging of the history; the newest 50 are enough to see how a design got here
      select: { number: true, name: true, createdAt: true, review: { select: { id: true, status: true, decidedAt: true } } },
    });
    const nameOf = await namesOf([s.submittedByUserId, review.decidedByUserId]);
    return reply.header("Cache-Control", "no-store").send({
      review: { id: review.id, status: review.status, comment: review.comment, createdAt: review.createdAt, decidedAt: review.decidedAt, reviewer: nameOf(review.decidedByUserId) },
      submission: { number: s.number, name: s.name, note: s.note, createdAt: s.createdAt, submitter: nameOf(s.submittedByUserId), baseRevision: { number: s.baseRevision.number }, document: s.document },
      changes: changedFields(before, s.document),
      // The name counts as a change for resubmitting, so it is shown as one (nothing to compare with for the first submission).
      rename: previous && previous.name !== s.name ? { before: previous.name, after: s.name } : null,
      history: history.map((h) => ({ number: h.number, name: h.name, createdAt: h.createdAt, reviewId: h.review?.id ?? null, status: h.review?.status ?? null, decidedAt: h.review?.decidedAt ?? null })),
      archivedBySubmitter: s.instance.archivedAt !== null,
    });
  });

  // Approve, or ask for changes (a comment is required). One conditional UPDATE: only a review that is still pending can be
  // decided, so two designers, or a designer and a newer submission, cannot both win. Nothing is read first, and the instance
  // is not touched at all: an archived design's pending review is decided exactly like any other.
  app.post("/canvas/reviews/:id/decision", { preHandler: [withAuth, designerOnly, wellFormedId("Review"), jsonOnly], config: userLimit(30) }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const userId = getUser(req).id;
    const { id } = req.params as { id: string };
    const parsed = decisionBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(invalidBody(parsed.error));
    const { decision, comment } = parsed.data;
    const status = decision === "approve" ? "approved" : "changes_requested";

    const { count } = await prisma.designReviewRequest.updateMany({
      where: { id, workspaceId, status: "pending" },
      data: { status, pendingInstanceId: null, comment: comment || null, decidedByUserId: userId, decidedAt: new Date() },
    });
    if (count === 0) {
      if (!(await prisma.designReviewRequest.findFirst({ where: { id, workspaceId }, select: { id: true } }))) return reply.status(404).send({ error: "Review not found" });
      return reply.status(409).send({ error: "This review was already answered, or a newer submission replaced it. Reload the queue.", code: "NOT_PENDING" });
    }
    return reply.send({ ok: true, review: { id, status } });
  });
}
