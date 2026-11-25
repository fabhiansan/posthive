import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

// Track active SSE connections per userId — evicted on close
const sseConnections = new Map<string, number>();
const SSE_MAX_PER_USER = 3;
import { schedulePostJob, postJobQueue } from "../lib/queue.js";
import { withAuth, getUser, getWorkspaceId, getWorkspaceRole, isManageRole, requireManageRole, isContentEditorRole, requireContentEditorRole, isDraftVisibleTo, jobVisibilityWhere, CONTENT_EDITOR_FORBIDDEN, MANAGE_FORBIDDEN_MSG, ACCESS_COOKIE_NAME } from "../lib/auth/withAuth.js";
import { authProvider } from "../lib/auth/index.js";
import { enforcePlan } from "../lib/enforcePlan.js";
import { getPlan } from "../lib/plans.js";
import type { StorageAdapter } from "../lib/storage.js";
import { adapters } from "../adapters/index.js";
import { attachUploads, lockUploads, MediaUnavailable, mediaProblem, releaseMedia, withUploads } from "../lib/mediaDelete.js";
import { contentMediaUrls, mediaUrlList, toStoredUrl } from "../lib/mediaUrl.js";
import { bucketJobCounts, jobFilterWhere } from "../lib/jobFilters.js";
import { CANVAS_KEYS, canEditJob, sameContent, shouldResetReview } from "../lib/jobEditRules.js";
import { promoteRefusal } from "../lib/promoteGate.js";
import { missingForReview, type MissingField } from "../lib/submitReadiness.js";
import { firstSubmission, nextSubmission } from "../lib/submitStamp.js";
import { CATEGORIES, PILLARS, pillarFor, type Category, type Pillar } from "../lib/contentTypes.js";
import { safeLink } from "../lib/contentList.js";
import { IN_DESIGN, NOT_IN_DESIGN, designRequestSelect, toDesignRequestView } from "../lib/designRequest.js";
import { LIMITS } from "../lib/canvas.js";
import { isRefusal } from "../lib/canvasHttp.js";
import { resolveDesigns } from "../lib/canvasDesigns.js";
import { canvasDesignMetadataProblem, designImageProblems, designsOfContent, isCanvasDesignUploadPath } from "../lib/designImage.js";
import { notify, notifyAdmins } from "../lib/notifications.js";

// The approved Canvas designs on a post (T7): only the id of the approved submission and the picture's address are read from the client.
// What is stored (and the size in bytes) comes from the server's own records, see lib/canvasDesigns.ts. It is NOT in CONTENT_KEYS: PATCH
// resolves it together with mediaUrls so that it can never name a picture the post no longer has.
const canvasDesignsBody = z.array(z.object({ submissionId: z.string().regex(LIMITS.id), mediaUrl: z.string().max(2048) })).max(10);

/** A post that is about to move toward publishing cannot carry an approved design a channel cannot take: say which and why (409), never publish it silently. */
const incompatible = (content: unknown, platforms: Iterable<string>) => {
  const problems = designImageProblems(content, platforms);
  return problems.length === 0 ? null : { status: 409, body: { error: problems.join(" "), code: "DESIGN_IMAGE_INCOMPATIBLE", problems } };
};


/**
 * A draft that can be sent for review: not in review and not sent back. It is part of the WHERE of the send itself
 * (not only of the check before it), so two sends at the same moment cannot both win and count two rounds.
 * `OR`, not `not`: a Prisma `not` drops the rows whose approvalStatus is NULL.
 */
const SUBMITTABLE: Prisma.PostJobWhereInput[] = [{ approvalStatus: null }, { approvalStatus: "approved" }];

const TARGET_SELECT = {
  id: true, accountId: true, status: true,
  platformPostId: true, error: true, attempts: true,
  account: { select: { platform: true, displayName: true, avatarUrl: true } },
};

const perAccountOverrideSchema = z.object({
  text: z.string().optional(),
  commentText: z.string().optional(),
});

// Content type (docs/content-types.md). The pillar always follows the category; a
// pillar alone is allowed while the category is still undecided.
type ContentType = { pillar: Pillar | null; category: Category | null };

type ReadinessJob = { scheduledFor: Date | null; content: string; targets: { account: { platform: string } | null }[] };

/** Input for missingForReview from a job row, plus a display title for reports. */
function readinessInput(job: ReadinessJob) {
  let title = "Untitled";
  try {
    const c = JSON.parse(job.content) as { title?: string; text?: string };
    title = c.title?.trim() || c.text?.trim() || "Untitled";
  } catch { /* keep fallback */ }
  return {
    title,
    scheduledFor: job.scheduledFor,
    content: job.content,
    targetPlatforms: job.targets.map((t) => t.account?.platform).filter((p): p is string => !!p),
  };
}

function contentType(pillar: Pillar | null | undefined, category: Category | null | undefined): ContentType | { error: string } {
  if (!category) return { pillar: pillar ?? null, category: null };
  const derived = pillarFor(category);
  if (pillar !== undefined && pillar !== derived) return { error: `${category} belongs to ${derived ?? "no pillar"}` };
  return { pillar: derived, category };
}

// The Figma (or any https) link to the customised design, or the copywriting / supporting-assets link; "" clears it
const designLink = z.string().trim().max(500).refine((v) => v === "" || (v.startsWith("https://") && safeLink(v) !== null), "Use an https link");

// Content keys PATCH /jobs/:id may change. A key that is not sent keeps its stored value; null or "" clears it.
const CONTENT_KEYS = [
  "text", "mediaUrls", "mediaType", "youtubeType", "youtubeVideoMode", "youtubeVideoUrl", "youtubeThumbnailUrl",
  "pixelfedSensitive", "pixelfedVisibility", "youtubeVisibility", "youtubeTags", "youtubeMadeForKids",
  "linkedinVisibility", "blueskyLanguage", "blueskyContentWarning", "perAccount",
  "format", "designFigmaUrl", "designCopy", "assetNotes", "canvasInstanceId", "canvasTemplateId",
] as const;

const createJobBody = z.object({
  scheduledFor: z.string().datetime().optional(),
  draft: z.boolean().default(false),
  content: z.object({
    text: z.string().default(""),
    mediaUrls: z.array(z.string()).max(10).default([]),
    altTexts: z.array(z.string()).optional(),
    mediaType: z.enum(["post", "reel", "story"]).optional(),
    youtubeType: z.enum(["short", "video"]).optional(),
    youtubeVideoMode: z.enum(["upload", "url"]).optional(),
    youtubeVideoUrl: z.string().optional(),
    youtubeThumbnailUrl: z.string().optional(),
    locationId: z.string().optional(),
    userTags: z.array(z.string()).optional(),
    collaborators: z.array(z.string()).optional(),
    pixelfedSensitive: z.boolean().optional(),
    pixelfedVisibility: z.enum(["public", "unlisted", "private"]).optional(),
    youtubeVisibility: z.enum(["public", "unlisted", "private"]).optional(),
    youtubeTags: z.array(z.string()).optional(),
    youtubeMadeForKids: z.boolean().optional(),
    linkedinVisibility: z.enum(["PUBLIC", "CONNECTIONS"]).optional(),
    blueskyLanguage: z.string().optional(),
    blueskyContentWarning: z.string().optional(),
    perAccount: z.record(z.string().cuid(), perAccountOverrideSchema).optional(),
    title: z.string().max(200).optional(),
    pillar: z.enum(PILLARS).nullable().optional(),
    category: z.enum(CATEGORIES).nullable().optional(),
    format: z.enum(["single", "carousel"]).nullable().optional(),
    designFigmaUrl: designLink.optional(),
    canvasDesigns: canvasDesignsBody.optional(),
    designCopy: designLink.optional(),
    assetNotes: designLink.optional(),
  }),
  commentText: z.string().optional(),
  // A draft may have no account yet (the Edit Content page saves one before a channel is picked); scheduling needs one
  accountIds: z.array(z.string().cuid()).default([]),
  dryRun: z.boolean().default(false),
  repeatInterval: z.enum(["daily", "weekly", "monthly"]).optional(),
  repeatEndsAt: z.string().datetime().optional(),
});

export async function jobRoutes(app: FastifyInstance, { storage }: { storage: StorageAdapter }): Promise<void> {

  // Design-approval gate — when workspace.approvalRequired is on, non-manage
  // roles (marketing members) cannot schedule directly; their posts become
  // drafts awaiting review instead of entering the queue.
  const needsReviewGate = async (userId: string, workspaceId: string): Promise<boolean> => {
    if (isManageRole(await getWorkspaceRole(userId, workspaceId))) return false;
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { approvalRequired: true } });
    return ws?.approvalRequired ?? false;
  };

  // Create a new scheduled job
  app.post("/jobs", { preHandler: [withAuth], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);

    // Tim Desain is read-only on content (docs/role-access-matrix.md)
    const roleBlocked = await requireContentEditorRole(userId, workspaceId);
    if (roleBlocked) return reply.status(403).send(roleBlocked);

    const parsed = createJobBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const { scheduledFor, draft, content, commentText, accountIds, dryRun, repeatInterval, repeatEndsAt } = parsed.data;

    if (!draft && !scheduledFor) {
      return reply.status(400).send({ error: "scheduledFor is required when not saving as draft" });
    }
    if (!draft && accountIds.length === 0) {
      return reply.status(400).send({ error: "Pick at least one account" });
    }
    const { pillar, category, canvasDesigns: sentDesigns, ...postContent } = content;
    const type = pillar !== undefined || category !== undefined ? contentType(pillar, category) : null;
    if (type && "error" in type) return reply.status(400).send({ error: type.error });
    // The address of an upload may arrive with the API's own origin in front (the docs show it): stored, it is always the path the upload gave
    const listed = mediaUrlList(postContent.mediaUrls ?? []);
    if (listed === null) return reply.status(400).send({ error: "mediaUrls must be a list of addresses of at most 2048 characters", code: "INVALID_MEDIA_URL" });
    postContent.mediaUrls = listed;
    if (postContent.youtubeThumbnailUrl) postContent.youtubeThumbnailUrl = toStoredUrl(postContent.youtubeThumbnailUrl);
    if (postContent.youtubeVideoUrl) postContent.youtubeVideoUrl = toStoredUrl(postContent.youtubeVideoUrl);
    // Approved Canvas designs: checked on the server from its own records, and only for pictures the post really has (a subset of mediaUrls)
    const resolved = await resolveDesigns({ sent: sentDesigns ?? [], stored: [], mediaUrls: postContent.mediaUrls, userId, workspaceId, db: prisma, storage });
    if (isRefusal(resolved)) return reply.status(resolved.status).send(resolved.body);
    const storedContent = resolved.designs.length > 0 ? { ...postContent, canvasDesigns: resolved.designs } : postContent;
    const metadataProblem = canvasDesignMetadataProblem(storedContent);
    if (metadataProblem) return reply.status(400).send({ error: metadataProblem, code: "DESIGN_METADATA_REQUIRED" });

    // Approval gate — member posts in approval-enabled workspaces stay drafts
    // awaiting design review; scheduledFor is kept as the requested time.
    const needsReview = !draft && (await needsReviewGate(userId, workspaceId));

    // Non-scheduling gates (reels, overrides, images) — no race risk, check outside tx
    if (content.mediaType === "reel" || content.mediaType === "story") {
      const reelBlocked = await enforcePlan(userId, workspaceId, "reels");
      if (reelBlocked) return reply.status(402).send(reelBlocked);
    }
    if (content.perAccount && Object.keys(content.perAccount).length > 0) {
      const overrideBlocked = await enforcePlan(userId, workspaceId, "overrides");
      if (overrideBlocked) return reply.status(402).send(overrideBlocked);
    }
    if (content.mediaUrls.length > 0) {
      const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
      const planCfg = getPlan(ws?.plan ?? "cancelled");
      if (content.mediaUrls.length > planCfg.maxImagesPerPost) {
        return reply.status(402).send({
          error: `Your ${planCfg.name} plan allows up to ${planCfg.maxImagesPerPost} images per post. Upgrade to Pro for up to 10.`,
          code: "PLAN_LIMIT",
          upgradeRequired: true,
        });
      }
    }

    // Verify accounts belong to this workspace
    const accounts = await prisma.account.findMany({
      where: { id: { in: accountIds }, workspaceId },
      select: { id: true, platform: true },
    });
    if (accounts.length !== accountIds.length) {
      return reply.status(400).send({ error: "One or more accountIds not found" });
    }
    if (!draft) {
      const blocked = incompatible(storedContent, accounts.map((a) => a.platform));
      if (blocked) return reply.status(blocked.status).send(blocked.body);
    }

    // Wrap plan-limit check + job creation in a transaction with an advisory lock
    // so concurrent bulk-CSV requests can't all pass the count check simultaneously.
    let planError: Awaited<ReturnType<typeof enforcePlan>> = null;
    // The pictures are locked, checked (each is an upload of this person that still exists, or the post is refused) and claimed in the
    // SAME transaction that stores the post, so a delete of the file cannot slip in between (lib/mediaDelete.ts)
    const attached = [...postContent.mediaUrls, ...(postContent.youtubeThumbnailUrl ? [postContent.youtubeThumbnailUrl] : [])];
    const external = postContent.youtubeVideoUrl ? [postContent.youtubeVideoUrl] : [];
    let job;
    try {
      job = await prisma.$transaction(async (tx) => {
      await attachUploads(tx, [...attached, ...external], { userId, external });
      if (!draft && !needsReview) {
        // Lock per workspace — serializes concurrent scheduling requests (Postgres only)
        if (!process.env.DATABASE_URL?.startsWith("file:")) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`;
        }
        planError = await enforcePlan(userId, workspaceId, "scheduling", tx);
        if (planError) return null;
      }
      return tx.postJob.create({
        data: {
          scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
          status: draft || needsReview ? "draft" : "pending",
          approvalStatus: needsReview ? "pending" : null,
          ...(needsReview ? firstSubmission(userId) : {}),
          // Pillar is derived from the category, never trusted from the client
          content: JSON.stringify(type ? { ...storedContent, ...type } : storedContent),
          commentText: commentText ?? null,
          dryRun,
          userId,
          workspaceId,
          repeatInterval: repeatInterval ?? null,
          repeatEndsAt: repeatEndsAt ? new Date(repeatEndsAt) : null,
          targets: { create: accountIds.map((accountId) => ({ accountId })) },
        },
        include: { targets: { select: TARGET_SELECT } },
      });
      }, { timeout: 30_000 });
    } catch (err) {
      const problem = mediaProblem(err);
      if (problem) return reply.status(problem.status).send(problem.body);
      throw err;
    }

    if (planError) return reply.status(402).send(planError);
    if (!job) return reply.status(500).send({ error: "Failed to create job" });

    if (!draft && !needsReview) {
      await schedulePostJob(job.id, new Date(scheduledFor!));
    }

    return reply.status(201).send(job);
  });

  // SSE stream — scoped to current user.
  // EventSource can't send cookies cross-origin so auth token comes via ?token= query param.
  app.get("/jobs/stream", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const origin = req.headers.origin ?? process.env.WEB_URL ?? "http://localhost:3000";
    const sseHeaders: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
    };

    const token = (req.query as Record<string, string>)?.token ?? req.cookies?.[ACCESS_COOKIE_NAME];
    const user = token ? await authProvider.validateAccessToken(token) : null;

    if (!user) {
      reply.raw.writeHead(401, sseHeaders);
      reply.raw.write(`data: ${JSON.stringify({ error: "unauthorized" })}\n\n`);
      reply.raw.end();
      return;
    }

    const { id: userId } = user;

    // Enforce per-user SSE connection limit
    const activeConns = sseConnections.get(userId) ?? 0;
    if (activeConns >= SSE_MAX_PER_USER) {
      reply.raw.writeHead(429, { ...sseHeaders, "Retry-After": "10" });
      reply.raw.write(`data: ${JSON.stringify({ error: "too_many_connections" })}\n\n`);
      reply.raw.end();
      return;
    }
    sseConnections.set(userId, activeConns + 1);

    // Resolve workspaceId for stream scoping — same logic as withAuth
    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        activeWorkspaceId: true,
        workspaceMembers: { orderBy: { joinedAt: "asc" }, take: 1, select: { workspaceId: true } },
      },
    });
    const streamWorkspaceId = dbUser?.activeWorkspaceId ?? dbUser?.workspaceMembers[0]?.workspaceId ?? null;

    // Draft visibility — see jobVisibilityWhere; secure default for non-members
    const streamRole = streamWorkspaceId ? await getWorkspaceRole(userId, streamWorkspaceId) : null;

    reply.raw.writeHead(200, sseHeaders);

    const fetchJobs = async () => {
      const jobs = await prisma.postJob.findMany({
        where: streamWorkspaceId
          ? { workspaceId: streamWorkspaceId, ...jobVisibilityWhere(streamRole, userId) }
          : { userId },
        orderBy: { scheduledFor: "desc" },
        take: 20,
        select: {
          id: true, status: true, scheduledFor: true, content: true, commentText: true,
          createdAt: true, updatedAt: true, workspaceId: true, userId: true,
          approvalStatus: true, reviewNote: true,
          repeatInterval: true, repeatEndsAt: true, repeatParentId: true,
          targets: { select: TARGET_SELECT },
        },
      });
      return JSON.stringify(jobs);
    };

    let lastPayload = "";
    try {
      lastPayload = await fetchJobs();
      reply.raw.write(`data: ${lastPayload}\n\n`);
    } catch { /* ignore */ }

    const poll = setInterval(async () => {
      try {
        const payload = await fetchJobs();
        if (payload !== lastPayload) { lastPayload = payload; reply.raw.write(`data: ${payload}\n\n`); }
      } catch { /* ignore */ }
    }, 30_000);

    const keepAlive = setInterval(() => { reply.raw.write(": ping\n\n"); }, 25000);

    req.raw.on("close", () => {
      clearInterval(poll);
      clearInterval(keepAlive);
      const cur = sseConnections.get(userId) ?? 1;
      if (cur <= 1) sseConnections.delete(userId);
      else sseConnections.set(userId, cur - 1);
    });
    await new Promise<void>((resolve) => req.raw.on("close", resolve));
  });

  // List jobs for current workspace — cursor-paginated.
  // Plain drafts are hidden from owner/admin (they only see their own); in-review
  // items stay visible to approvers; Marketing sees everything.
  app.get("/jobs", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const query = req.query as { cursor?: string; limit?: string; status?: string; review?: string; platform?: string };
    const limit = Math.min(Number(query.limit ?? 50), 100);
    const cursor = query.cursor ?? undefined;
    // `review=pending` is the legacy spelling of `status=review`
    const statusFilter = query.review === "pending" ? "review" : query.status;

    const role = await getWorkspaceRole(userId, workspaceId);
    // Visibility and filter both may use OR — combine with AND so neither overrides the other
    const and: Prisma.PostJobWhereInput[] = [jobVisibilityWhere(role, userId)];
    if (statusFilter) and.push(jobFilterWhere(statusFilter) ?? { status: statusFilter });
    if (query.platform) and.push({ targets: { some: { account: { platform: query.platform } } } });
    const where: Prisma.PostJobWhereInput = { workspaceId, AND: and };

    const jobs = await prisma.postJob.findMany({
      where,
      orderBy: { scheduledFor: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, status: true, scheduledFor: true, content: true, commentText: true,
        createdAt: true, updatedAt: true, workspaceId: true, userId: true,
        approvalStatus: true, reviewNote: true, reviewedByUserId: true, reviewedAt: true,
        reviewedBy: { select: { name: true } },
        repeatInterval: true, repeatEndsAt: true, repeatParentId: true,
        targets: { select: TARGET_SELECT },
      },
    });

    const hasMore = jobs.length > limit;
    const items = hasMore ? jobs.slice(0, limit) : jobs;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    return reply.send({ items, nextCursor, hasMore });
  });

  // Per-filter counts for the Posts chips. Computed over every visible job, so
  // they never depend on the active status filter or sort — only on the platform.
  app.get("/jobs/counts", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { platform } = req.query as { platform?: string };
    const role = await getWorkspaceRole(userId, workspaceId);
    const and: Prisma.PostJobWhereInput[] = [jobVisibilityWhere(role, userId)];
    if (platform) and.push({ targets: { some: { account: { platform } } } });
    const rows = await prisma.postJob.groupBy({
      by: ["status", "approvalStatus"],
      where: { workspaceId, AND: and },
      _count: true,
    });
    return reply.send(bucketJobCounts(rows));
  });

  // Single job detail — scoped to workspace. Hidden drafts 404 so they can't
  // be probed by URL (no existence leak).
  app.get("/jobs/:id", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };
    const role = await getWorkspaceRole(userId, workspaceId);
    const job = await prisma.postJob.findFirst({
      where: { id, workspaceId },
      include: { targets: { select: TARGET_SELECT }, designRequest: { select: designRequestSelect(workspaceId) } },
    });
    if (!job) return reply.status(404).send({ error: "Job not found" });
    if (!isDraftVisibleTo(role, userId, job)) return reply.status(404).send({ error: "Job not found" });
    const { designRequest, ...rest } = job;
    return reply.send({ ...rest, designRequest: designRequest ? toDesignRequestView(designRequest) : null });
  });

  // Update a pending job (content, commentText, scheduledFor — all optional)
  app.patch("/jobs/:id", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };
    const body = z.object({
      scheduledFor: z.string().datetime().optional(),
      title: z.string().max(200).optional(),
      text: z.string().optional(),
      commentText: z.string().optional(),
      mediaUrls: z.array(z.string()).max(10).optional(),
      mediaType: z.enum(["post", "reel", "story"]).optional(),
      youtubeType: z.enum(["short", "video"]).optional(),
      youtubeVideoMode: z.enum(["upload", "url"]).optional(),
      youtubeVideoUrl: z.string().optional(),
      youtubeThumbnailUrl: z.string().optional(),
      pixelfedSensitive: z.boolean().optional(),
      pixelfedVisibility: z.enum(["public", "unlisted", "private"]).optional(),
      youtubeVisibility: z.enum(["public", "unlisted", "private"]).optional(),
      youtubeTags: z.array(z.string()).optional(),
      youtubeMadeForKids: z.boolean().optional(),
      linkedinVisibility: z.enum(["PUBLIC", "CONNECTIONS"]).optional(),
      blueskyLanguage: z.string().optional(),
      blueskyContentWarning: z.string().optional(),
      accountIds: z.array(z.string().cuid()).optional(),
      perAccount: z.record(z.string().cuid(), perAccountOverrideSchema).optional(),
      // Sent together; category null clears both
      pillar: z.enum(PILLARS).nullable().optional(),
      category: z.enum(CATEGORIES).nullable().optional(),
      format: z.enum(["single", "carousel"]).nullable().optional(),
      designFigmaUrl: designLink.optional(),
      designCopy: designLink.optional(),
      assetNotes: designLink.optional(),
      // The Canvas design the post opened from its template; saved when the Studio is opened
      canvasInstanceId: z.string().cuid().nullable().optional(),
      canvasTemplateId: z.string().cuid().nullable().optional(),
      canvasDesigns: canvasDesignsBody.optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
    if (body.data.mediaUrls) {
      const listed = mediaUrlList(body.data.mediaUrls);
      if (listed === null) return reply.status(400).send({ error: "mediaUrls must be a list of addresses of at most 2048 characters", code: "INVALID_MEDIA_URL" });
      body.data.mediaUrls = listed;
    }
    if (body.data.youtubeThumbnailUrl) body.data.youtubeThumbnailUrl = toStoredUrl(body.data.youtubeThumbnailUrl);
    if (body.data.youtubeVideoUrl) body.data.youtubeVideoUrl = toStoredUrl(body.data.youtubeVideoUrl);
    const typeChanged = body.data.pillar !== undefined || body.data.category !== undefined;
    const type = typeChanged ? contentType(body.data.pillar, body.data.category) : null;
    if (type && "error" in type) return reply.status(400).send({ error: type.error });

    const job = await prisma.postJob.findFirst({
      where: { id, workspaceId },
      select: { status: true, content: true, commentText: true, approvalStatus: true, userId: true, targets: { select: { accountId: true, account: { select: { platform: true } } } } },
    });
    if (!job) return reply.status(404).send({ error: "Job not found" });
    const role = await getWorkspaceRole(userId, workspaceId);
    // Tim Desain (and unknown roles) cannot edit content — read-only + approve/reject
    if (!isContentEditorRole(role)) {
      return reply.status(403).send(CONTENT_EDITOR_FORBIDDEN);
    }
    // Marketing: any draft, before approval only. Admin/owner: any draft or scheduled post.
    const editCheck = canEditJob(role, job);
    if (!editCheck.ok) {
      return reply.status(editCheck.status).send({ error: editCheck.error, ...(editCheck.code ? { code: editCheck.code } : {}) });
    }
    // Only a plain draft (or one sent back) can be left with no account: a post in review or scheduled needs a channel
    if (body.data.accountIds?.length === 0 && (job.status !== "draft" || job.approvalStatus === "pending")) {
      return reply.status(400).send({ error: "Pick at least one account" });
    }

    const updateData: Record<string, unknown> = {};

    if (body.data.scheduledFor) {
      updateData.scheduledFor = new Date(body.data.scheduledFor);
    }
    const changes: Record<string, unknown> = {};
    for (const key of CONTENT_KEYS) if (body.data[key] !== undefined) changes[key] = body.data[key];
    if (body.data.title !== undefined) changes.title = body.data.title.trim();
    // Approved Canvas designs, resolved against the FINAL picture list: an entry never outlives its picture, and a new one is checked on the
    // server. What the post already holds is kept as it is (the author's own design may be a colleague's draft). The final media set is
    // computed for EVERY edit so a text-only write cannot resurrect a picture a concurrent edit removed.
    const current = (() => { try { return JSON.parse(job.content) as Record<string, unknown>; } catch { return {} as Record<string, unknown>; } })();
    const finalMedia = body.data.mediaUrls ?? (Array.isArray(current.mediaUrls) ? current.mediaUrls.filter((u): u is string => typeof u === "string").map((u) => toStoredUrl(u)) : []);
    if (body.data.mediaUrls !== undefined || body.data.canvasDesigns !== undefined) {
      const stored = designsOfContent(current);
      const resolved = await resolveDesigns({ sent: body.data.canvasDesigns, stored, mediaUrls: finalMedia, userId, workspaceId, db: prisma, storage });
      if (isRefusal(resolved)) return reply.status(resolved.status).send(resolved.body);
      if (JSON.stringify(resolved.designs) !== JSON.stringify(stored)) changes.canvasDesigns = resolved.designs;
    }
    if (Object.keys(changes).length > 0 || typeChanged) {
      const existing = JSON.parse(job.content) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...existing, ...changes, ...(type ?? {}) };
      if (Array.isArray(merged.canvasDesigns) && merged.canvasDesigns.length === 0) delete merged.canvasDesigns; // no design left: no key left
      updateData.content = JSON.stringify(merged);
    }
    const metadataProblem = canvasDesignMetadataProblem(updateData.content ?? job.content);
    if (metadataProblem) return reply.status(409).send({ error: metadataProblem, code: "DESIGN_METADATA_REQUIRED" });
    if (body.data.commentText !== undefined) {
      updateData.commentText = body.data.commentText || null;
    }
    // A scheduled or queued post is already moving toward publishing: an edit may not add a design a channel cannot take
    if (job.status !== "draft" && (updateData.content !== undefined || body.data.accountIds !== undefined)) {
      const platforms = body.data.accountIds
        ? (await prisma.account.findMany({ where: { id: { in: body.data.accountIds }, workspaceId }, select: { platform: true } })).map((a) => a.platform)
        : job.targets.flatMap((t) => (t.account ? [t.account.platform] : []));
      const blocked = incompatible((updateData.content as string | undefined) ?? job.content, platforms);
      if (blocked) return reply.status(blocked.status).send(blocked.body);
    }

    // Only a real content change (not the date, not a re-save of the same values)
    // sends a submitted/rejected draft back out of review.
    const accountsChanged = body.data.accountIds !== undefined &&
      (body.data.accountIds.length !== job.targets.length ||
        body.data.accountIds.some((a) => !job.targets.some((t) => t.accountId === a)));
    const contentChanged =
      (updateData.content !== undefined && !sameContent(updateData.content as string, job.content, CANVAS_KEYS)) ||
      (updateData.commentText !== undefined && updateData.commentText !== job.commentText) ||
      accountsChanged;
    if (shouldResetReview(role, job, contentChanged)) {
      updateData.approvalStatus = null;
      updateData.reviewNote = null;
      updateData.reviewedByUserId = null;
      updateData.reviewedAt = null;
    }

    // What this edit attaches. An edit resends every address the post already holds (those are only locked, not re-checked: an older post may
    // hold an address that predates these rules, and a draft is kept by the team, so a kept file may be a colleague's); a NEW one must be an
    // upload of this person that still exists, or an outside address where outside addresses are allowed (the YouTube video link).
    const held = new Set(contentMediaUrls(job.content).map((u) => toStoredUrl(u)));
    const canvasUrls = finalMedia.filter(isCanvasDesignUploadPath);
    const attached = [
      ...(body.data.mediaUrls !== undefined || canvasUrls.length > 0 ? finalMedia : []),
      ...(body.data.youtubeThumbnailUrl ? [body.data.youtubeThumbnailUrl] : []),
      ...(body.data.youtubeVideoUrl ? [body.data.youtubeVideoUrl] : []),
    ];
    const external = body.data.youtubeVideoUrl ? [body.data.youtubeVideoUrl] : [];
    let updated;
    try {
      updated = await withUploads(
        attached,
        async (tx) => {
          await attachUploads(tx, attached, { userId, keep: held, external });
          // A metadata-only edit still locks the final pictures. A Canvas picture must still have its Upload row once the lock is held;
          // otherwise a concurrent remove could delete it after resolveDesigns read it and this write would resurrect a dangling reference.
          if (canvasUrls.length > 0) {
            const rows = await lockUploads(tx, canvasUrls);
            if (canvasUrls.some((url) => !rows.has(url))) throw new MediaUnavailable();
          }
        },
        (db) => db.postJob.update({ where: { id }, data: updateData }),
      );
    } catch (err) {
      const problem = mediaProblem(err);
      if (problem) return reply.status(problem.status).send(problem.body);
      throw err;
    }

    if (body.data.accountIds) {
      const newIds = body.data.accountIds;
      const currentTargets = await prisma.postJobTarget.findMany({
        where: { postJobId: id },
        select: { id: true, accountId: true },
      });

      const toRemove = currentTargets.filter(t => !newIds.includes(t.accountId));
      const toAdd = newIds.filter(nid => !currentTargets.some(t => t.accountId === nid));

      if (toAdd.length > 0) {
        const valid = await prisma.account.findMany({ where: { id: { in: toAdd }, workspaceId }, select: { id: true } });
        if (valid.length !== toAdd.length) return reply.status(400).send({ error: "One or more accountIds not found" });
      }

      if (toRemove.length > 0) {
        await prisma.postJobTarget.deleteMany({ where: { id: { in: toRemove.map(t => t.id) } } });
      }
      if (toAdd.length > 0) {
        await prisma.postJobTarget.createMany({ data: toAdd.map(accountId => ({ postJobId: id, accountId })) });
      }
    }

    // Files this edit dropped: removed only when nothing else uses them (another post, a repeat or a duplicate, a Library item, a template),
    // under the same locks as the writers above. A draft is kept by the team, so the file may be a colleague's upload: the author's and the
    // editor's uploads go, anyone else's stays. Best effort: a failure leaves a file behind, never breaks the edit.
    if (body.data.mediaUrls !== undefined || body.data.youtubeThumbnailUrl !== undefined) {
      try {
        const now = new Set(contentMediaUrls(updated.content));
        await releaseMedia(storage, [...held].filter((u) => !now.has(u)), [job.userId, userId]);
      } catch (err) {
        req.log.warn({ err }, "media of an edited post was not cleaned up");
      }
    }

    if (body.data.scheduledFor) {
      const blocked = await enforcePlan(userId, workspaceId, "scheduling");
      if (blocked) return reply.status(402).send(blocked);
      // Drafts (including those awaiting design approval) are never queued —
      // they enter the queue only via the approve endpoint.
      if (updated.status !== "draft") {
        await postJobQueue.remove(id);
        await schedulePostJob(id, new Date(body.data.scheduledFor));
      }
    }

    return reply.send(updated);
  });

  // Promote a draft to a scheduled job — this is the approve action.
  // Only owner/admin/ (design team) may promote; a draft awaiting
  // review gets approvalStatus=approved before entering the queue.
  app.post("/jobs/:id/schedule", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };
    const body = z.object({ scheduledFor: z.string().datetime() }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "scheduledFor is required" });

    const role = await getWorkspaceRole(userId, workspaceId);
    if (!isManageRole(role)) {
      return reply.status(403).send({ error: MANAGE_FORBIDDEN_MSG, code: "FORBIDDEN" });
    }

    const job = await prisma.postJob.findFirst({ where: { id, workspaceId }, select: { status: true, approvalStatus: true, userId: true, submittedById: true, content: true, designRequest: { select: { status: true } }, targets: { select: { id: true, account: { select: { platform: true } } } } } });
    // Other people's plain drafts are hidden from approvers — only in-review ones can be promoted
    if (!job || !isDraftVisibleTo(role, userId, job)) return reply.status(404).send({ error: "Job not found" });
    if (job.status !== "draft") return reply.status(409).send({ error: "Only draft jobs can be scheduled" });
    // The design is with the designer, or there is no account to post to (approving a post already in review is unaffected)
    const refused = promoteRefusal(job);
    if (refused) return reply.status(refused.status).send(refused.body);
    // Approving also publishes: an approved Canvas design a channel cannot take is refused here, with the reason
    const designBlocked = incompatible(job.content, job.targets.flatMap((t) => (t.account ? [t.account.platform] : [])));
    if (designBlocked) return reply.status(designBlocked.status).send(designBlocked.body);

    const blocked = await enforcePlan(userId, workspaceId, "scheduling");
    if (blocked) return reply.status(402).send(blocked);

    const scheduledFor = new Date(body.data.scheduledFor);
    const updated = await prisma.postJob.update({
      where: { id },
      data: {
        status: "pending",
        scheduledFor,
        reviewNote: null,
        ...(job.approvalStatus === "pending"
          ? { approvalStatus: "approved", reviewedByUserId: userId, reviewedAt: new Date() }
          : {}),
      },
      include: { targets: { select: TARGET_SELECT } },
    });

    await schedulePostJob(id, scheduledFor);
    // approving a post that was in review answers the person who sent it
    if (job.approvalStatus === "pending") {
      await notify([{ workspaceId, userId: job.submittedById ?? job.userId, kind: "post_approved", postJobId: id, actorId: userId }]);
    }
    return reply.send(updated);
  });

  // Reject a post awaiting design approval — sent back to the creator with a note.
  app.post("/jobs/:id/reject", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };
    const body = z.object({ note: z.string().min(1).max(2000).trim() }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "A review note is required" });

    const forbidden = await requireManageRole(userId, workspaceId);
    if (forbidden) return reply.status(403).send(forbidden);

    const job = await prisma.postJob.findFirst({ where: { id, workspaceId }, select: { status: true, approvalStatus: true, userId: true, submittedById: true } });
    if (!job) return reply.status(404).send({ error: "Job not found" });
    if (job.status !== "draft" || job.approvalStatus !== "pending") {
      return reply.status(409).send({ error: "Only posts awaiting review can be rejected" });
    }

    const updated = await prisma.postJob.update({
      where: { id },
      data: {
        approvalStatus: "rejected",
        reviewNote: body.data.note,
        reviewedByUserId: userId,
        reviewedAt: new Date(),
      },
      include: { targets: { select: TARGET_SELECT } },
    });
    await notify([{ workspaceId, userId: job.submittedById ?? job.userId, kind: "post_sent_back", postJobId: id, actorId: userId }]);
    return reply.send(updated);
  });

  // Submit a draft for design approval (approval-enabled workspaces only).
  app.post("/jobs/:id/submit", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };

    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { approvalRequired: true } });
    if (!ws?.approvalRequired) return reply.status(400).send({ error: "Approval is not enabled for this workspace" });

    const job = await prisma.postJob.findFirst({
      where: { id, workspaceId },
      select: { status: true, approvalStatus: true, scheduledFor: true, content: true, designRequest: { select: { status: true } }, targets: { select: { account: { select: { platform: true } } } } },
    });
    if (!job) return reply.status(404).send({ error: "Job not found" });
    if (job.status !== "draft") return reply.status(409).send({ error: "Only drafts can be submitted for review" });
    if (job.approvalStatus === "pending") return reply.status(409).send({ error: "Already awaiting review" });
    // Sent back by the reviewer: the same content is not sent again. An edit that changes it clears the rejection (PATCH).
    if (job.approvalStatus === "rejected") return reply.status(409).send({ error: "Sent back for changes. Change the post before sending it again.", code: "NEEDS_CHANGES" });
    const role = await getWorkspaceRole(userId, workspaceId);
    // Submitting is a content-editor action (designer reviews, never submits)
    // Any draft of the workspace: a plan is imported by one person and kept by the team
    if (!isContentEditorRole(role)) return reply.status(403).send(CONTENT_EDITOR_FORBIDDEN);
    // The design is with the designer: Marketing cancels the request or waits for the design
    if (job.designRequest?.status === "sent") return reply.status(409).send(IN_DESIGN);
    const missing = missingForReview(readinessInput(job));
    if (missing.length > 0) {
      return reply.status(422).send({ error: `Complete the required fields first: ${missing.join(", ")}.`, code: "INCOMPLETE", missing });
    }
    const designBlocked = incompatible(job.content, readinessInput(job).targetPlatforms);
    if (designBlocked) return reply.status(designBlocked.status).send(designBlocked.body);

    try {
      const updated = await prisma.postJob.update({
        where: { id, workspaceId, status: "draft", OR: SUBMITTABLE, ...NOT_IN_DESIGN },
        data: { approvalStatus: "pending", reviewNote: null, reviewedByUserId: null, reviewedAt: null, ...nextSubmission(userId) },
        include: { targets: { select: TARGET_SELECT } },
      });
      await notifyAdmins(workspaceId, "review_submitted", [id], userId);
      return reply.send(updated);
    } catch (err) {
      // P2025: no row matches any more: another send (or the reviewer) got there between the check above and this write
      if ((err as { code?: string }).code === "P2025") return reply.status(409).send({ error: "Already awaiting review" });
      throw err;
    }
  });

  // Bulk "Send for Design Approval": complete drafts are submitted, the rest are skipped with a reason.
  app.post("/jobs/submit-bulk", { preHandler: [withAuth], config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const body = z.object({ ids: z.array(z.string().cuid()).min(1).max(100) }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "ids must be 1-100 job ids" });

    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { approvalRequired: true } });
    if (!ws?.approvalRequired) return reply.status(400).send({ error: "Approval is not enabled for this workspace" });
    const role = await getWorkspaceRole(userId, workspaceId);
    if (!isContentEditorRole(role)) return reply.status(403).send(CONTENT_EDITOR_FORBIDDEN);

    const jobs = await prisma.postJob.findMany({
      where: { id: { in: body.data.ids }, workspaceId },
      select: { id: true, status: true, approvalStatus: true, scheduledFor: true, content: true, designRequest: { select: { status: true } }, targets: { select: { account: { select: { platform: true } } } } },
    });
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const submit: string[] = [];
    const skipped: { id: string; title: string; reason: string; missing?: MissingField[] }[] = [];

    for (const id of body.data.ids) {
      const job = byId.get(id);
      if (!job) { skipped.push({ id, title: "Unknown post", reason: "Post not found" }); continue; }
      const title = readinessInput(job).title;
      if (job.status !== "draft") {
        skipped.push({ id, title, reason: "Not a draft" });
      } else if (job.approvalStatus === "pending") {
        skipped.push({ id, title, reason: "Already in review" });
      } else if (job.approvalStatus === "rejected") {
        skipped.push({ id, title, reason: "Sent back for changes: change it first" });
      } else if (job.designRequest?.status === "sent") {
        skipped.push({ id, title, reason: "Design requested: waiting for the designer" });
      } else {
        const missing = missingForReview(readinessInput(job));
        const designProblems = designImageProblems(job.content, readinessInput(job).targetPlatforms);
        if (missing.length > 0) skipped.push({ id, title, reason: "Missing required fields", missing });
        else if (designProblems.length > 0) skipped.push({ id, title, reason: designProblems.join(" ") });
        else submit.push(id);
      }
    }

    if (submit.length > 0) {
      await prisma.postJob.updateMany({
        where: { id: { in: submit }, workspaceId, status: "draft", OR: SUBMITTABLE, ...NOT_IN_DESIGN },
        data: { approvalStatus: "pending", reviewNote: null, reviewedByUserId: null, reviewedAt: null, ...nextSubmission(userId) },
      });
      await notifyAdmins(workspaceId, "review_submitted", submit, userId);
    }
    return reply.send({ submitted: submit, skipped });
  });

  // Retry only the failed targets on a partially-failed job.
  // Tim Desain cannot retry (matrix US-16: Admin/Marketing); Marketing only retries own posts.
  app.post("/jobs/:id/retry-failed", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };

    const role = await getWorkspaceRole(userId, workspaceId);
    if (!isContentEditorRole(role)) {
      return reply.status(403).send(CONTENT_EDITOR_FORBIDDEN);
    }
    const job = await prisma.postJob.findFirst({
      where: { id, workspaceId },
      include: { targets: { select: { id: true, status: true } } },
    });
    if (!job) return reply.status(404).send({ error: "Job not found" });
    if (role === "member" && job.userId !== userId) {
      return reply.status(403).send({ error: "You can only retry your own posts.", code: "FORBIDDEN" });
    }
    if (job.status === "running") return reply.status(409).send({ error: "Job is currently running" });

    const failedTargetIds = job.targets
      .filter((t) => t.status === "post_failed")
      .map((t) => t.id);

    if (failedTargetIds.length === 0) {
      return reply.status(400).send({ error: "No failed targets to retry" });
    }

    // Reset failed targets and job status, then re-queue for immediate execution
    await prisma.postJobTarget.updateMany({
      where: { id: { in: failedTargetIds } },
      data: { status: "pending", error: null, attempts: 0 },
    });

    const scheduledFor = new Date(Date.now() + 5000); // 5s from now
    await prisma.postJob.update({
      where: { id },
      data: { status: "pending", scheduledFor },
    });

    await postJobQueue.remove(id).catch(() => {});
    await schedulePostJob(id, scheduledFor);

    return reply.status(200).send({ retrying: failedTargetIds.length });
  });

  // Delete a job and clean up associated media
  app.delete("/jobs/:id", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };

    const job = await prisma.postJob.findFirst({ where: { id, workspaceId }, select: { status: true, content: true, userId: true } });
    if (!job) return reply.status(404).send({ error: "Job not found" });
    if (job.status === "running") return reply.status(409).send({ error: "Cannot delete a job that is currently running" });
    const role = await getWorkspaceRole(userId, workspaceId);
    // Tim Desain is read-only on content (docs/role-access-matrix.md)
    if (!isContentEditorRole(role)) {
      return reply.status(403).send(CONTENT_EDITOR_FORBIDDEN);
    }
    if ((role !== "owner" && role !== "admin") && job.userId !== userId) {
      return reply.status(403).send({ error: "You can only delete your own posts.", code: "FORBIDDEN" });
    }

    // Remove from queue if pending
    if (job.status === "pending") await postJobQueue.remove(id).catch(() => {});

    // Targets are deleted automatically via onDelete: Cascade
    await prisma.postJob.delete({ where: { id } });

    // The post no longer references its files, so they can be considered: each goes only if it is the author's (or the person deleting)
    // and nothing else uses it (a duplicate, a repeat, a Library item, a template, another post). Best effort, after the post is gone.
    try {
      await releaseMedia(storage, contentMediaUrls(job.content), [job.userId, userId]);
    } catch (err) {
      req.log.warn({ err }, "media of a deleted post was not cleaned up");
    }

    return reply.status(204).send();
  });

  // DELETE /jobs/bulk — delete up to 500 jobs in one request
  app.delete("/jobs/bulk", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);

    const parsed = z.object({
      ids: z.array(z.string().cuid()).min(1).max(500),
    }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const { ids } = parsed.data;

    // Fetch all jobs — verify ownership + skip running
    const jobs = await prisma.postJob.findMany({
      where: { id: { in: ids }, workspaceId },
      select: { id: true, status: true, content: true, userId: true },
    });

    const role = await getWorkspaceRole(userId, workspaceId);
    // Tim Desain is read-only on content (docs/role-access-matrix.md)
    if (!isContentEditorRole(role)) {
      return reply.status(403).send(CONTENT_EDITOR_FORBIDDEN);
    }
    const isAdmin = role === "owner" || role === "admin";

    const deletableIds: string[] = [];
    const mediaUrlsToDelete: string[] = [];
    const owners = new Set<string>([userId]);

    for (const job of jobs) {
      if (job.status === "running") continue;
      if (!isAdmin && job.userId !== userId) continue;
      deletableIds.push(job.id);
      owners.add(job.userId);
      mediaUrlsToDelete.push(...contentMediaUrls(job.content));
    }

    if (!deletableIds.length) return reply.status(200).send({ deleted: 0 });

    // Remove pending jobs from queue in parallel
    const pendingIds = jobs.filter(j => j.status === "pending" && deletableIds.includes(j.id)).map(j => j.id);
    await Promise.allSettled(pendingIds.map(id => postJobQueue.remove(id)));

    // Bulk delete — targets cascade
    const { count } = await prisma.postJob.deleteMany({ where: { id: { in: deletableIds } } });

    // Then the files, once the posts are gone: two of these posts may share a file (a duplicate, a repeat), and it goes only when the
    // last one is deleted (template designs and Library items that use a file keep it too)
    try {
      await releaseMedia(storage, mediaUrlsToDelete, owners);
    } catch (err) {
      req.log.warn({ err }, "media of deleted posts was not cleaned up");
    }

    return reply.status(200).send({ deleted: count });
  });

  // GET /jobs/targets/:targetId/analytics
  app.get("/jobs/targets/:targetId/analytics", { preHandler: [withAuth] }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const { targetId } = req.params as { targetId: string };

    const target = await prisma.postJobTarget.findFirst({
      where: { id: targetId, postJob: { workspaceId } },
      select: {
        platformPostId: true,
        status: true,
        accountId: true,
        account: { select: { platform: true, credentials: true, expiresAt: true, warnedExpiryAt: true, createdAt: true, updatedAt: true, id: true, userId: true, workspaceId: true, displayName: true, avatarUrl: true, refreshToken: true } },
      },
    });

    if (!target) return reply.status(404).send({ error: "Target not found" });
    if (!target.platformPostId) return reply.status(400).send({ error: "Post not yet published" });

    const adapter = adapters.find(a => a.name === target.account.platform);
    if (!adapter?.getAnalytics) {
      return reply.status(400).send({ error: "Analytics not supported for this platform" });
    }

    try {
      const analytics = await adapter.getAnalytics(target.account, target.platformPostId);
      return reply.send(analytics);
    } catch (err) {
      return reply.status(502).send({ error: err instanceof Error ? err.message : "Failed to fetch analytics" });
    }
  });
}
