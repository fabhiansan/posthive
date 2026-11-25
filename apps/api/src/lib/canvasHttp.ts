import type { FastifyReply, FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import type { ZodError } from "zod";
import { getUser, getWorkspaceId, requireContentEditorRole, requireTemplateManagerRole } from "./auth/withAuth.js";
import { LIMITS, firstIssue } from "./canvas.js";

/**
 * What every Canvas route file shares: the refusal shape, the id guard, the JSON-only guard and the two role gates.
 * (They lived inside routes/canvas.ts until the review routes needed them too.)
 */

export const KIND = "template"; // the designer's working copies
export const INSTANCE = "instance"; // what Marketing makes from a published template (phase 5)

/** A refusal as a status and a body, so a transaction can hand it back and the route can send it after the transaction ends. */
export type Refusal = { status: number; body: { error: string; code?: string } };
export const refuse = (status: number, error: string, code?: string): Refusal => ({ status, body: code ? { error, code } : { error } });
export const isRefusal = (x: unknown): x is Refusal => typeof x === "object" && x !== null && "status" in x && "body" in x;
export const errorCode = (err: unknown): string | undefined => (typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined);

/** A body the schema refused: which part it was decides the code, so the editor can say what to fix. */
export function invalidBody(error: ZodError) {
  const { field, message } = firstIssue(error);
  return { error: message, code: field === "document" ? "INVALID_DOCUMENT" : field === "name" ? "INVALID_NAME" : field === "overrides" ? "INVALID_OVERRIDES" : "INVALID_REQUEST" };
}

export const notFound = (reply: FastifyReply) => reply.status(404).send({ error: "Design not found" });

// Creating takes a JSON object. A request with no body, a form or multipart post (no preflight, so a cross-site page
// can send one) or a bare `null` must not quietly become anything: only an object sent as application/json is read.
export const jsonOnly = async (req: FastifyRequest, reply: FastifyReply) => {
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return reply.status(415).send({ error: "Send this request as JSON (Content-Type: application/json).", code: "UNSUPPORTED_MEDIA_TYPE" });
};

// An id that is not shaped like an id cannot name anything, so it is the same 404 as an unknown one, and nothing is
// queried. Without this a NUL in the path reaches PostgreSQL, which refuses it (error 22021), and the caller gets a 500.
// Always after the auth (and role) checks on purpose: a stranger learns nothing about what an id looks like. Real ids
// (cuid, uuid) all match LIMITS.id.
export const wellFormedId = (what: "Design" | "Asset" | "Template" | "Review" | "Submission") => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!LIMITS.id.test((req.params as { id: string }).id)) return reply.status(404).send({ error: `${what} not found` });
};

/** The filter of "one of MY designs": the workspace, the kind and the creator all come from the session, never from the request. Archived ones included. */
export const YOURS = (id: string, workspaceId: string, userId: string) => ({ id, workspaceId, kind: INSTANCE, createdByUserId: userId });

/**
 * Locks one of MY instances (any state, archived included, so the caller can tell "archived" from "not there") until the
 * transaction ends. Submit, archive and delete all take it FIRST and take no other lock (not the template's, not the template
 * design's), so they serialize on the instance and cannot form a cycle with the phase 4 and 5 order (Template, then Design).
 */
export async function lockInstance(tx: Prisma.TransactionClient, id: string, workspaceId: string, userId: string): Promise<{ archivedAt: Date | null } | null> {
  const rows = await tx.$queryRaw<{ archivedAt: Date | null }[]>`SELECT "archivedAt" FROM "Design" WHERE "id" = ${id} AND "workspaceId" = ${workspaceId} AND "kind" = ${INSTANCE} AND "createdByUserId" = ${userId} FOR UPDATE`;
  return rows[0] ?? null;
}

export const ARCHIVED = refuse(404, "This design was archived, so it can no longer be changed or submitted.", "DESIGN_ARCHIVED");

/** Designer only (templates, and the review of what Marketing submits). */
export const designerOnly = async (req: FastifyRequest, reply: FastifyReply) => {
  const forbidden = await requireTemplateManagerRole(getUser(req).id, getWorkspaceId(req));
  if (forbidden) return reply.status(403).send(forbidden);
};

/** Content editors only (owner, admin, member): Marketing's own designs. */
export const contentEditorOnly = async (req: FastifyRequest, reply: FastifyReply) => {
  const forbidden = await requireContentEditorRole(getUser(req).id, getWorkspaceId(req));
  if (forbidden) return reply.status(403).send(forbidden);
};
