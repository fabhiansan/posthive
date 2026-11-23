// The Edit Content page (docs/design/Edit Content · Path A / Path B): what the form holds, what a save sends, what it
// refuses and what the side cards say. Pure, so it is tested without a screen; components/post-editor reads it.
//
// The page edits the fields of the design and nothing else. A post can carry much more (a YouTube video, a Bluesky
// warning, a plan's notes): a save sends ONLY the keys the person changed, so everything else stays as it was stored.
import type { Account } from "@/components/PlatformPreview";
import { filterOf, dayLabel, type ListFilter } from "./content-list";
import { shortName } from "./dashboard-format";
import { APP_TZ_LABEL, formatTime, fromWibInput, toWibInput, wibDateKey } from "./datetime";
import type { DesignRequestView, Job } from "./jobTypes";
import { platformLabel } from "./platforms";
import { missingForReview, type MissingField } from "./submitReadiness";

/** The channels the page is made for (docs/content-types.md). Any other channel a post has is kept and only named. */
export const EDITOR_PLATFORMS = ["linkedin", "instagram"] as const;

export type PostFormat = "single" | "carousel";

export const FORMAT_OPTIONS: { value: PostFormat; label: string }[] = [
  { value: "single", label: "Single image" },
  { value: "carousel", label: "Carousel" },
];

/** What the server accepts for an image (PNG or JPG, 10 MB): the dropzone checks first so a wrong file never leaves the browser. */
export const IMAGE_TYPES = ["image/png", "image/jpeg"];
export const MAX_IMAGE_MB = 10;
/** Most files one post takes (an Instagram carousel is 10 slides). */
export const MAX_FILES = 10;

export type PerAccount = Record<string, { text?: string; commentText?: string }>;

export interface PostForm {
  title: string;
  text: string;
  /** As stored: an import may hold free text here, which stays until the person picks a real one. */
  pillar: string | null;
  category: string | null;
  format: PostFormat | "";
  /** WIB day "YYYY-MM-DD", or "" for a post with no date yet. */
  date: string;
  /** WIB "HH:MM". */
  time: string;
  accountIds: string[];
  mediaUrls: string[];
  designFigmaUrl: string;
  perAccount: PerAccount;
}

/** The keys of a post's content JSON that this page reads. */
export interface StoredContent {
  title?: string;
  text?: string;
  pillar?: string | null;
  category?: string | null;
  format?: string | null;
  mediaUrls?: string[];
  designFigmaUrl?: string;
  canvasInstanceId?: string | null;
  canvasTemplateId?: string | null;
  sourceRow?: number;
  importSource?: { fileName?: string };
  perAccount?: PerAccount;
}

export function parseContent(content: string): StoredContent {
  try {
    const v = JSON.parse(content) as unknown;
    return v && typeof v === "object" ? (v as StoredContent) : {};
  } catch {
    return {};
  }
}

export const EMPTY_FORM: PostForm = {
  title: "", text: "", pillar: null, category: null, format: "", date: "", time: "09:00",
  accountIds: [], mediaUrls: [], designFigmaUrl: "", perAccount: {},
};

export function formFromJob(job: Pick<Job, "scheduledFor" | "content" | "targets">): PostForm {
  const c = parseContent(job.content);
  // a post an API client made with no date holds the epoch: that is no date, not 1 January 1970
  const instant = job.scheduledFor ? new Date(job.scheduledFor) : null;
  const when = instant && instant.getTime() > 0 ? toWibInput(instant) : null;
  return {
    title: c.title ?? "",
    text: c.text ?? "",
    pillar: c.pillar ?? null,
    category: c.category ?? null,
    format: c.format === "single" || c.format === "carousel" ? c.format : "",
    date: when ? when.slice(0, 10) : "",
    time: when ? when.slice(11, 16) : "09:00",
    accountIds: job.targets.map((t) => t.accountId),
    mediaUrls: Array.isArray(c.mediaUrls) ? c.mediaUrls : [],
    designFigmaUrl: c.designFigmaUrl ?? "",
    perAccount: c.perAccount ?? {},
  };
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v) => b.includes(v));

/** The publishing instant of the form, or null while the day is empty. */
export const scheduledOf = (f: Pick<PostForm, "date" | "time">): Date | null => (f.date ? fromWibInput(`${f.date}T${f.time || "09:00"}`) : null);

/**
 * The body of PATCH /jobs/:id: only what differs from what was loaded. Pillar and category go together (the server checks
 * they agree). Nothing changed = {}, and then nothing is sent.
 */
export function changedFields(initial: PostForm, form: PostForm): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (form.title !== initial.title) out.title = form.title;
  if (form.text !== initial.text) out.text = form.text;
  if (form.pillar !== initial.pillar || form.category !== initial.category) {
    out.pillar = form.pillar;
    out.category = form.category;
  }
  if (form.format !== initial.format) out.format = form.format === "" ? null : form.format;
  if (form.date && (form.date !== initial.date || form.time !== initial.time)) out.scheduledFor = scheduledOf(form)!.toISOString();
  if (!sameSet(form.accountIds, initial.accountIds)) out.accountIds = form.accountIds;
  if (!sameList(form.mediaUrls, initial.mediaUrls)) out.mediaUrls = form.mediaUrls;
  if (form.designFigmaUrl !== initial.designFigmaUrl) out.designFigmaUrl = form.designFigmaUrl;
  if (JSON.stringify(form.perAccount) !== JSON.stringify(initial.perAccount)) out.perAccount = form.perAccount;
  return out;
}

/** Did the content change (not only the date)? A changed post that was sent back can be sent again. */
export function contentChanged(initial: PostForm, form: PostForm): boolean {
  return Object.keys(changedFields(initial, form)).some((key) => key !== "scheduledFor");
}

/** The body of POST /jobs for a new post, from the form as it is now. */
export function createBody(form: PostForm, draft: boolean): Record<string, unknown> {
  const when = scheduledOf(form);
  return {
    draft,
    accountIds: form.accountIds,
    ...(when ? { scheduledFor: when.toISOString() } : {}),
    content: {
      text: form.text,
      mediaUrls: form.mediaUrls,
      ...(form.title.trim() ? { title: form.title } : {}),
      ...(form.pillar || form.category ? { pillar: form.pillar, category: form.category } : {}),
      ...(form.format ? { format: form.format } : {}),
      ...(form.designFigmaUrl ? { designFigmaUrl: form.designFigmaUrl } : {}),
      ...(Object.keys(form.perAccount).length > 0 ? { perAccount: form.perAccount } : {}),
    },
  };
}

/** What the post still lacks before review: the server's own rule, run on the stored content with the form laid over it. */
export function editorMissing(stored: StoredContent, form: PostForm, accounts: readonly Pick<Account, "id" | "platform">[]): MissingField[] {
  return missingForReview({
    scheduledFor: scheduledOf(form),
    content: JSON.stringify({ ...stored, title: form.title, text: form.text, category: form.category, format: form.format, mediaUrls: form.mediaUrls }),
    targetPlatforms: accounts.filter((a) => form.accountIds.includes(a.id)).map((a) => a.platform),
  });
}

/** Why a person cannot edit this post at all (null: they can). The same rule as the server's canEditJob. */
export function editBlock(post: { status: string }, who: { canEditContent: boolean; canReview: boolean }): string | null {
  if (!who.canEditContent) return "Your role can't edit content.";
  if (post.status !== "draft" && post.status !== "pending") return "This post has gone out or is going out, so it can't be edited any more.";
  if (post.status === "pending" && !who.canReview) return "Approved posts are locked. Ask an admin to change them.";
  return null;
}

// ── Design request (Path B) ─────────────────────────────────────────────────

export type DeadlineProblem = "DEADLINE_PAST" | "DEADLINE_AFTER_PUBLISH";

export const DEADLINE_TEXT: Record<DeadlineProblem, string> = {
  DEADLINE_PAST: "The design deadline must be later than now.",
  DEADLINE_AFTER_PUBLISH: "The design deadline must be before the publishing date and time.",
};

/**
 * The same rule as the API's deadlineProblem. The deadline is optional (the caller asks only when one is set); it must be
 * after now and strictly before the moment the post goes out. `publishAt` is null while the post has no date.
 */
export function deadlineProblem(deadline: Date, now: Date, publishAt: Date | null): DeadlineProblem | null {
  if (deadline.getTime() <= now.getTime()) return "DEADLINE_PAST";
  if (publishAt && deadline.getTime() >= publishAt.getTime()) return "DEADLINE_AFTER_PUBLISH";
  return null;
}

/** "Wed, 4 Mar 2026, 17:00 WIB": a moment as the person reads the schedule (WIB, 24 hour). */
export function wibWhen(d: Date): string {
  return `${dayLabel(wibDateKey(d))}, ${formatTime(d)} ${APP_TZ_LABEL}`;
}

/** The deadline as the two inputs of the form hold it (WIB date and "HH:MM"); both empty when there is none. */
export function deadlineParts(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const [date, time] = toWibInput(new Date(iso)).split("T");
  return { date, time };
}

/** "Rina S. · due Wed, 4 Mar 2026, 17:00 WIB", or "· no deadline": who has the request and by when. The assignee is the person (the editor) or just the name (the drawer). */
export function requestLine(r: { assignee: { name: string } | string | null; deadline: string | null }): string {
  const name = typeof r.assignee === "string" ? r.assignee : r.assignee?.name;
  return `${name ? shortName(name) : "Designer removed"} · ${r.deadline ? `due ${wibWhen(new Date(r.deadline))}` : "no deadline"}`;
}

/** Which path the post is on, worked out and never stored: a request means B, else a published template for the category means A. */
export function pathOf(request: DesignRequestView | null | undefined, hasTemplate: boolean): "A" | "B" | null {
  if (request) return "B";
  return hasTemplate ? "A" : null;
}

const waiting = (r: DesignRequestView) => `Waiting for the design from ${r.assignee ? shortName(r.assignee.name) : "the designer"}. Cancel the request to send this post on.`;

/** Why Submit for Review is off right now (null: nothing stops it). The server checks all of this again. */
export function submitBlock(args: {
  approvalStatus: string | null | undefined;
  contentChanged: boolean;
  request: DesignRequestView | null | undefined;
}): string | null {
  const { approvalStatus, request } = args;
  if (request?.status === "sent") return waiting(request);
  if (approvalStatus === "pending") return "This post is in review.";
  if (approvalStatus === "rejected" && !args.contentChanged) return "Sent back for changes. Edit the post to send it again.";
  return null;
}

/** Why a save is off right now (null: nothing stops it): a field the server would refuse, so the person is told before, not after. */
export function saveBlock(form: PostForm): string | null {
  const link = designLinkProblem(form.designFigmaUrl);
  return link ? `Fix the design link first. ${link}` : null;
}

/** Why Schedule Post is off right now (null: nothing stops it). */
export function scheduleBlock(form: PostForm, request: DesignRequestView | null | undefined, now: Date = new Date()): string | null {
  if (request?.status === "sent") return waiting(request);
  if (!form.date) return "Pick a publishing date to schedule.";
  if (form.accountIds.length === 0) return "Pick a channel to schedule.";
  if (!form.text.trim()) return "Write the caption to schedule.";
  const when = scheduledOf(form);
  if (when && when <= now) return "The publishing time has already passed.";
  return null;
}

export interface EditorActions {
  /** The button that only saves; null when saving is the primary action. */
  secondary: string | null;
  primary: { kind: "submit" | "schedule" | "save"; label: string } | null;
}

/**
 * The buttons of the bar, by who is looking and where the post stands. Marketing under the review flow submits; an admin
 * schedules a draft or saves a scheduled post; Marketing without the flow can schedule only a NEW post (the server lets an
 * admin schedule an existing draft, not them), so on an existing draft they only save.
 */
export function actionsFor(a: { isNew: boolean; status: string; approvalStatus: string | null; canReview: boolean; canSubmitOwn: boolean }): EditorActions {
  if (!a.isNew && a.status !== "draft") return { secondary: null, primary: { kind: "save", label: "Save changes" } };
  // an admin reads a post in review in the review dialog; here they only edit it, and the review stays as it is
  if (!a.isNew && a.approvalStatus === "pending" && a.canReview) return { secondary: null, primary: { kind: "save", label: "Save changes" } };
  const primary = a.canSubmitOwn
    ? ({ kind: "submit", label: "Submit for Review" } as const)
    : a.canReview || a.isNew
      ? ({ kind: "schedule", label: "Schedule Post" } as const)
      : null;
  return { secondary: "Save as Draft", primary };
}

// ── What the cards say ──────────────────────────────────────────────────────

/** "Carousel · 5 slides", "Single image", or null while no format is picked. */
export function formatLine(format: PostFormat | "", files: number): string | null {
  if (!format) return null;
  if (format === "single") return "Single image";
  return files > 0 ? `Carousel · ${files} ${files === 1 ? "slide" : "slides"}` : "Carousel";
}

/** The breadcrumb's last part: "Row 1" for a post from a plan file, else its title. */
export function crumbLabel(stored: StoredContent): string {
  if (typeof stored.sourceRow === "number") return `Row ${stored.sourceRow}`;
  return stored.title?.trim() || "Untitled";
}

export interface WorkflowStep {
  filter: Exclude<ListFilter, "all">;
  label: string;
  note: string;
  state: "done" | "current" | "todo";
}

const STEPS: Record<Exclude<ListFilter, "all">, { label: string; note: string }> = {
  draft: { label: "Draft", note: "Editable" },
  review: { label: "In Review", note: "The approver reads it" },
  rejected: { label: "Revision Required", note: "Sent back with a note" },
  pending: { label: "Ready to Publish", note: "Approved, waits for its time" },
  done: { label: "Published", note: "Live on the selected channels" },
  failed: { label: "Failed", note: "A channel could not publish it" },
};

/** The steps of the Review workflow card, in the app's own statuses. Without the review flow there is no review step. */
export function workflowSteps(post: { status: string; approvalStatus: string | null }, approvalFlow: boolean): WorkflowStep[] {
  const now = filterOf(post);
  const order: Exclude<ListFilter, "all">[] = approvalFlow ? ["draft", "review", "rejected", "pending", "done"] : ["draft", "pending", "done"];
  if (now === "failed") order.push("failed");
  // a post sent back is "rejected"; without the review flow the position is still found by its own status
  const at = order.indexOf(now);
  return order.map((filter, i) => ({ filter, ...STEPS[filter], state: i < at ? "done" : i === at ? "current" : "todo" }));
}

// ── Old settings the page does not show ─────────────────────────────────────

export interface LegacyNotes {
  /** Channels other than LinkedIn and Instagram that the post goes to: kept as they are. */
  otherChannels: string[];
  /** A selected channel has its own caption text, and that text is what is published instead of the main caption. */
  customText: boolean;
  /** The post has a first comment, which is kept. */
  firstComment: boolean;
}

export function legacyNotes(form: PostForm, accounts: readonly Account[], commentText: string | null | undefined): LegacyNotes {
  const picked = accounts.filter((a) => form.accountIds.includes(a.id));
  return {
    otherChannels: [...new Set(picked.filter((a) => !(EDITOR_PLATFORMS as readonly string[]).includes(a.platform)).map((a) => platformLabel(a.platform)))],
    customText: picked.some((a) => (form.perAccount[a.id]?.text ?? "").trim() !== ""),
    firstComment: Boolean(commentText?.trim()),
  };
}

/** The per-channel captions dropped, their first comments kept: the main caption is what goes out. */
export function withMainCaption(perAccount: PerAccount): PerAccount {
  const out: PerAccount = {};
  for (const [id, o] of Object.entries(perAccount)) {
    if (o.commentText?.trim()) out[id] = { commentText: o.commentText };
  }
  return out;
}

/** An old post can hold a video. The page cannot show or add one: it is listed and can only be removed. */
export const isVideoUrl = (url: string): boolean => /\.(mp4|mov|m4v|webm)(\?.*)?$/i.test(url);

/** Why a design link cannot be saved (null: fine or empty). The same rule as the server's: an https address, 500 characters at most, no spaces. */
export function designLinkProblem(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (!url.startsWith("https://")) return "Use a link that starts with https://";
  if (url.length > 500 || /\s/.test(url)) return "That link is too long or has spaces in it.";
  try {
    new URL(url);
    return null;
  } catch {
    return "That is not a valid link.";
  }
}

/** A file the dropzone refuses before sending it (null: fine). */
export function imageProblem(file: { name: string; type: string; size: number }): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return `${file.name} is not a PNG or JPG file.`;
  if (file.size > MAX_IMAGE_MB * 1_000_000) return `${file.name} is over ${MAX_IMAGE_MB} MB.`;
  return null;
}
