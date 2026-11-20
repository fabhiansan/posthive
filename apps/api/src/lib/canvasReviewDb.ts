import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import type { SubmissionFacts } from "./canvasReview.js";

/** Reads shared by the instance routes and the review routes. Every id passed in was already scoped to the workspace by the caller. */

const FACTS = {
  id: true,
  number: true,
  instanceVersion: true,
  name: true,
  overrides: true,
  createdAt: true,
  review: { select: { id: true, status: true, comment: true, decidedAt: true } },
} as const;

/** The newest submission of one instance and its review, without the document. */
export const latestSubmission = (client: Prisma.TransactionClient, instanceId: string): Promise<SubmissionFacts | null> =>
  client.designSubmission.findFirst({ where: { instanceId }, orderBy: { number: "desc" }, select: FACTS });

type LatestRow = Omit<SubmissionFacts, "review"> & { instanceId: string; reviewId: string | null; status: string | null; comment: string | null; decidedAt: Date | null };

/**
 * The newest submission of each of these instances, in ONE query. DISTINCT ON in the database, not Prisma's `distinct`, which
 * runs in memory and would read every submission (documents included) of every listed instance: there is no cap on how many an
 * instance has. (instanceId, number) is a unique index, so each instance is one index probe.
 */
export async function latestForInstances(ids: string[]): Promise<Map<string, SubmissionFacts>> {
  const out = new Map<string, SubmissionFacts>();
  if (ids.length === 0) return out;
  const rows = await prisma.$queryRaw<LatestRow[]>`
    SELECT DISTINCT ON (s."instanceId") s."instanceId", s."id", s."number", s."instanceVersion", s."name", s."overrides", s."createdAt",
           r."id" AS "reviewId", r."status", r."comment", r."decidedAt"
    FROM "DesignSubmission" s
    LEFT JOIN "DesignReviewRequest" r ON r."submissionId" = s."id"
    WHERE s."instanceId" = ANY(${ids}::text[])
    ORDER BY s."instanceId", s."number" DESC`;
  for (const r of rows) {
    out.set(r.instanceId, {
      id: r.id,
      number: r.number,
      instanceVersion: r.instanceVersion,
      name: r.name,
      overrides: r.overrides,
      createdAt: r.createdAt,
      review: r.reviewId && r.status ? { id: r.reviewId, status: r.status, comment: r.comment, decidedAt: r.decidedAt } : null,
    });
  }
  return out;
}

/** Shown where a person's account no longer exists. (A person who only left the workspace still has an account, and is named.) */
export const FORMER_MEMBER = "Former team member";

/**
 * People's CURRENT names, read when they are shown, never stored with a submission or a review: user ids carry no foreign key,
 * and keeping a name beside them would keep personal data after the account is deleted. Never an email.
 */
export async function namesOf(ids: Array<string | null | undefined>): Promise<(id: string | null | undefined) => string | null> {
  const wanted = [...new Set(ids.filter((i): i is string => typeof i === "string"))];
  const rows = wanted.length === 0 ? [] : await prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
  const byId = new Map(rows.map((u) => [u.id, u.name]));
  return (id) => (id ? (byId.get(id) ?? FORMER_MEMBER) : null);
}
