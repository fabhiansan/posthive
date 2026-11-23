// Who may edit a post, and when an edit sends it back out of design review.
// Pure so the rules are testable without the database.

export interface EditableJobState {
  status: string;
  approvalStatus: string | null;
}

export type EditCheck = { ok: true } | { ok: false; status: 403 | 409; error: string; code?: string };

const MANAGE = new Set(["owner", "admin", "designer"]);

/**
 * Admin/owner: any draft or scheduled post.
 * Marketing (member): any draft, whoever made it, and only before approval — draft, in review or rejected. A quarter
 * plan is imported by one person and kept by the team, so a draft belongs to the workspace, not to its uploader.
 * Design team and unknown roles: never.
 */
export function canEditJob(role: string | null | undefined, job: EditableJobState): EditCheck {
  if (job.status !== "pending" && job.status !== "draft") {
    return { ok: false, status: 409, error: `Cannot edit a job with status "${job.status}"` };
  }
  if (role !== "owner" && role !== "admin" && role !== "member") {
    return { ok: false, status: 403, error: "Your role cannot edit content.", code: "FORBIDDEN" };
  }
  if (role === "member" && job.status === "pending") {
    return { ok: false, status: 403, error: "Approved posts are locked. Ask an admin to change them.", code: "FORBIDDEN" };
  }
  return { ok: true };
}

/**
 * The Canvas design a post opened from a template. Opening the Studio saves these two; that is not an edit of the post, so it
 * never sends it back out of review (`sameContent` ignores them). A COPY of a post must not keep them: two posts would share
 * one Studio design, and editing it for one would change the other.
 */
export const CANVAS_KEYS = ["canvasInstanceId", "canvasTemplateId"] as const;

/** The content JSON without the Studio link; the very same string when it has none (a copy is not re-formatted). */
export function withoutCanvasKeys(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return content;
    const copy = { ...(parsed as Record<string, unknown>) };
    if (!CANVAS_KEYS.some((k) => k in copy)) return content;
    for (const k of CANVAS_KEYS) delete copy[k];
    return JSON.stringify(copy);
  } catch {
    return content;
  }
}

// Drops empty values and sorts keys, so `perAccount: {}` or `mediaUrls: []` that the
// edit form always sends does not count as a change against content that omits them.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = canonical((value as Record<string, unknown>)[key]);
      const empty = v === undefined || v === null || v === "" ||
        (Array.isArray(v) && v.length === 0) ||
        (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
      if (!empty) out[key] = v;
    }
    return out;
  }
  return value;
}

/** True when two content JSON strings carry the same meaningful values, leaving out the top-level `ignore` keys. */
export function sameContent(a: string, b: string, ignore: readonly string[] = []): boolean {
  const without = (json: string): unknown => {
    const v = JSON.parse(json) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const copy = { ...(v as Record<string, unknown>) };
      for (const key of ignore) delete copy[key];
      return copy;
    }
    return v;
  };
  try {
    return JSON.stringify(canonical(without(a))) === JSON.stringify(canonical(without(b)));
  } catch {
    return a === b;
  }
}

/**
 * Changing content (title, caption, media, accounts, type) pulls a submitted or rejected draft
 * back to a plain draft, so it must be re-sent. A date-only change never does.
 * Manage roles edit without resetting the review.
 */
export function shouldResetReview(role: string | null | undefined, job: EditableJobState, contentChanged: boolean): boolean {
  if (!contentChanged) return false;
  if (role && MANAGE.has(role)) return false;
  return job.status === "draft" && (job.approvalStatus === "pending" || job.approvalStatus === "rejected");
}
