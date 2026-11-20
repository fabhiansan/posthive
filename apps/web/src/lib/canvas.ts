// Canvas client helpers: editor fonts, image assets (upload and private download), and saved designs.

import type { CanvasDocument, OverrideEntry as EngineOverrideEntry } from "posthive-canvas"; // types only: Konva must stay out of server rendering
import { API_BASE, apiFetch } from "./api";

const FONT_TIMEOUT_MS = 10_000;
// The faces the Inspector offers (Inter and KoHo, Regular 400 and Semibold 600). Konva does not redraw
// when a font arrives late, so every face it can pick is loaded before the editor opens.
const FONT_FACES: Array<[weight: number, variable: string]> = [
  [400, "--font-inter"],
  [600, "--font-inter"],
  [400, "--font-koho"],
  [600, "--font-koho"],
];

/**
 * Loads the faces the editor draws text with. Next's font loader gives each family a generated
 * name, exposed on <html> as --font-inter / --font-koho, so the real name is read from there.
 * Rejects if a face fails to load or takes longer than 10s, so the loader can offer a retry.
 */
export async function loadEditorFonts(): Promise<void> {
  const root = getComputedStyle(document.documentElement);
  const loading = Promise.all(
    FONT_FACES.map(([weight, variable]) => {
      const family = root.getPropertyValue(variable).trim() || "sans-serif";
      return document.fonts.load(`${weight} 16px ${family}`);
    }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Fonts took too long to load")), FONT_TIMEOUT_MS);
  });
  try {
    await Promise.race([loading, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The real font-family behind each name the editor offers, for the Konva stage. */
export function editorFonts(): Record<string, string> {
  const root = getComputedStyle(document.documentElement);
  const family = (variable: string) => root.getPropertyValue(variable).trim() || "sans-serif";
  return { Inter: family("--font-inter"), KoHo: family("--font-koho") };
}

// ── Image assets ────────────────────────────────────────────────────────────

/**
 * What the API returns for an asset. The storage path is never sent. `url` is kept for other API clients, but the
 * editor does not read it: it loads an image from its id alone (see assetContentUrl), because an id is the only
 * thing a saved design can name.
 */
export interface CanvasAsset {
  id: string;
  width: number;
  height: number;
  url: string;
}

/** Same pattern as LIMITS.id in apps/canvas/src/limits.ts (the web reads the engine only through a dynamic import). lib/canvas.test.ts checks they match. */
export const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type AssetErrorCode = "INVALID_ID" | "BAD_API_BASE" | "NOT_FOUND" | "FAILED";

/** Why an image could not be loaded. `code` lets the editor tell a missing image from a broken setup or a bad connection. */
export class AssetLoadError extends Error {
  code: AssetErrorCode;
  constructor(code: AssetErrorCode, message: string) {
    super(message);
    this.name = "AssetLoadError";
    this.code = code;
  }
}

/**
 * The one address an asset's bytes can come from: `<API base>/canvas/assets/<id>/content`. Nothing stored in a
 * design can change where it points: the only stored value that reaches it is the id, which must match ASSET_ID
 * (no `/`, `.`, `?`, `#`, `%`, `\` or space, so it cannot alter the path, query or host), and the base is the
 * build-time API_BASE. The base must be an absolute http(s) URL: an empty or relative one would send the request
 * to the web origin (Next.js, not the API), so it is refused here instead of being sent anywhere. Trailing
 * slashes on the base are dropped, so `…/api/` cannot give `//canvas`. `base` is a parameter only so tests can vary it.
 */
export function assetContentUrl(assetId: string, base: string = API_BASE): string {
  if (typeof assetId !== "string" || !ASSET_ID.test(assetId)) throw new AssetLoadError("INVALID_ID", "This image reference is not valid.");
  const badBase = () => new AssetLoadError("BAD_API_BASE", "Images can't be loaded because the API address is not configured.");
  // The host must start right after "//": URL() would otherwise quietly repair "http:/x", "http:x" or "https:\\x" into a destination nobody wrote.
  if (typeof base !== "string" || !/^https?:\/\/[^\s/?#\\]/i.test(base) || /[\s?#\\]/.test(base)) throw badBase();
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw badBase();
  }
  if (url.username || url.password) throw badBase();
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/canvas/assets/${assetId}/content`;
}

const MAX_ASSET_BYTES = 10_000_000;

/** Imports a PNG or SVG. The server checks the real content; this only spares an obviously too-large upload. */
export async function uploadCanvasAsset(file: File): Promise<CanvasAsset> {
  if (file.size > MAX_ASSET_BYTES) throw new Error("The file is larger than 10 MB.");
  const body = new FormData();
  body.append("file", file);
  return apiFetch<CanvasAsset>("/canvas/assets", { method: "POST", body });
}

async function fetchAssetBlob(assetId: string): Promise<Blob> {
  // The id and the API address are checked here, before anything is sent. The address is the API's (which in
  // production sits under /api): a bare relative fetch would reach Next.js and 404.
  const url = assetContentUrl(assetId);
  const get = () => fetch(url, { credentials: "include", cache: "no-store" });
  let res: Response;
  try {
    res = await get();
    if (res.status === 401) {
      // The access token may just have expired: let the shared refresh run (through a JSON call), then retry once.
      await apiFetch("/auth/session").catch(() => {});
      res = await get();
    }
  } catch {
    throw new AssetLoadError("FAILED", "The image could not be loaded.");
  }
  if (res.status === 404) throw new AssetLoadError("NOT_FOUND", "This image no longer exists.");
  if (!res.ok) throw new AssetLoadError("FAILED", "The image could not be loaded.");
  try {
    return await res.blob();
  } catch {
    throw new AssetLoadError("FAILED", "The image could not be loaded.");
  }
}

/**
 * Downloads a private asset by its id, with the person's cookies, and decodes it into an image the stage can
 * draw. It takes an id and nothing else, and never a URL (see assetContentUrl). The bytes live in memory for
 * this editor session only: nothing is cached by the browser (the API answers no-store) or written to storage,
 * so every open of the editor is authorized again. A blob URL is same-origin to the page, so exporting a
 * design never taints the canvas.
 */
export async function loadAsset(assetId: string): Promise<HTMLImageElement> {
  const blob = await fetchAssetBlob(assetId);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    return img;
  } catch {
    throw new AssetLoadError("FAILED", "The image could not be read.");
  } finally {
    // Once decoded the element keeps its own pixels, so the blob can be released at once instead of on unmount.
    URL.revokeObjectURL(objectUrl);
  }
}

// ── Saved designs ───────────────────────────────────────────────────────────
// Designer only (the API refuses anyone else). A failed call throws what apiFetch throws: an Error with `status` and `data`.

/** A published, immutable revision of a design. */
export interface RevisionInfo {
  number: number;
  designVersion: number;
  createdAt: string;
}

export interface DesignSummary {
  id: string;
  name: string;
  version: number;
  updatedAt: string;
  /** The template this design is made for (null: not attached to one). */
  template: { id: string; category: string; published: boolean } | null;
  /** Its latest published revision (null: none yet). */
  latestRevision: RevisionInfo | null;
}

export interface Design extends DesignSummary {
  document: CanvasDocument;
}

/** The list shows at most this many designs (the API's cap). */
export const DESIGN_LIST_MAX = 200;

const designPath = (id: string) => `/canvas/designs/${encodeURIComponent(id)}`;

export const listDesigns = () => apiFetch<{ designs: DesignSummary[] }>("/canvas/designs");
export const createDesign = (name?: string) => apiFetch<{ design: DesignSummary }>("/canvas/designs", { method: "POST", body: JSON.stringify(name === undefined ? {} : { name }) });
export const getDesign = (id: string) => apiFetch<{ design: Design }>(designPath(id));
/** Saves the document (and the name, when it changed) on top of `version`. Answers with the new version, or 409 when `version` is no longer the stored one. */
export const saveDesign = (id: string, body: { version: number; document: CanvasDocument; name?: string }) =>
  apiFetch<{ version: number }>(designPath(id), { method: "PUT", body: JSON.stringify(body) });
export const deleteDesign = (id: string) => apiFetch<{ ok: true }>(designPath(id), { method: "DELETE" });

// ── Revisions and templates (phase 4) ───────────────────────────────────────
// Publishing a revision freezes the saved design and the layers Marketing may change. It does not make anything visible to
// Marketing: that is the template's own Publish. `version` is the one the editor last saved (a 409 VERSION_CONFLICT otherwise).
// Error codes the pages read from `error.data.code`: NO_CHANGES, INVALID_PUBLISH, UNKNOWN_ASSET, TEMPLATE_HAS_DESIGN,
// DESIGN_LINKED, DESIGN_NEEDS_REVISION, SOURCE_REQUIRED.
export const publishDesign = (id: string, version: number) =>
  apiFetch<{ revision: RevisionInfo }>(`${designPath(id)}/publish`, { method: "POST", body: JSON.stringify({ version }) });

const templateDesignPath = (templateId: string) => `/canvas/templates/${encodeURIComponent(templateId)}/design`;
/** Creates a blank design named after the template's category and attaches it, in one step on the server: if it fails, nothing is left behind. */
export const createDesignForTemplate = (templateId: string) =>
  apiFetch<{ design: { id: string; name: string; version: number } }>(templateDesignPath(templateId), { method: "POST", body: JSON.stringify({}) });
export const attachDesign = (templateId: string, designId: string) =>
  apiFetch<{ designId: string }>(templateDesignPath(templateId), { method: "PUT", body: JSON.stringify({ designId }) });
export const detachDesign = (templateId: string) => apiFetch<{ ok: true }>(templateDesignPath(templateId), { method: "DELETE" });

// ── Marketing's designs: instances (phase 5) ────────────────────────────────
// A Marketing design stores no document: it pins one published revision and keeps only what the person changed. Every call
// is for the signed-in content editor and their own designs (a designer, or anyone else's design, is refused or a 404).
// Error codes the pages read from `error.data.code`: NO_CANVAS_REVISION, INVALID_OVERRIDES, DUPLICATE_NODE, UNKNOWN_NODE,
// LOCKED_NODE, TEXT_TOO_LONG, UNKNOWN_ASSET, INVALID_NAME, VERSION_CONFLICT, INVALID_LIMIT, INVALID_CURSOR.

/** One changed field: new text for a text layer, or the asset that replaces an image layer's image. The engine's own type (types only, like CanvasDocument), so the two can never drift. */
export type OverrideEntry = EngineOverrideEntry;

/** The two independent facts about a design's review (phase 6): the answer to the latest submission, and whether there is more work since. */
export type ReviewStatus = "pending" | "approved" | "changes_requested" | "superseded";

export interface ReviewSummary {
  /** The status of the NEWEST submission's review. An edit never changes it. null: nothing was submitted. */
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

/** Marketing may submit when nothing was submitted yet, or when the work differs from the newest submission (the API's submit rule is the real check). */
export const canSubmitReview = (r: Pick<ReviewSummary, "latestReviewStatus" | "hasChangesSinceSubmitted">): boolean => r.latestReviewStatus === null || r.hasChangesSinceSubmitted;

/** What was last submitted, as the editor needs it to compare with what is on screen. */
export interface SubmittedState {
  name: string;
  overrides: readonly EngineOverrideEntry[];
}

/**
 * The review facts as they are NOW, while the person types: the answer to the newest submission is the server's and never
 * changes with an edit; whether there are unsubmitted changes is recomputed from what is on screen (the name and the changes,
 * the same two things the server compares), so it follows an edit, and a revert to what was submitted, without a request.
 * `same` is the engine's sameOverrides. Nothing submitted: no changes to report.
 */
export function liveReview(
  base: ReviewSummary,
  submitted: SubmittedState | null,
  now: SubmittedState,
  same: (a: readonly EngineOverrideEntry[], b: readonly EngineOverrideEntry[]) => boolean,
): ReviewSummary {
  if (!submitted) return base;
  return { ...base, hasChangesSinceSubmitted: submitted.name !== now.name || !same(submitted.overrides, now.overrides) };
}

export interface InstanceSummary {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Set once the person has archived a design that was submitted: it can no longer be edited or submitted, only read. */
  archivedAt: string | null;
  review: ReviewSummary;
  /** The published revision this design was made from, which never changes. */
  baseRevision: { number: number };
}

/** One page of "my designs", newest created first. `nextCursor` is null on the last page. */
export interface InstancePage {
  instances: InstanceSummary[];
  nextCursor: string | null;
}

/** A design ready to draw: the pinned revision's document and manifest, and what the person changed on top of it. */
export interface InstanceDetail {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  overrides: OverrideEntry[];
  review: ReviewSummary;
  /** The name and changes of the newest submission (null: nothing submitted). */
  submitted: { name: string; overrides: OverrideEntry[] } | null;
  baseRevision: { number: number; createdAt: string };
  document: CanvasDocument;
  manifest: { schemaVersion: 1; fields: Array<{ nodeId: string; kind: "text" | "image" }> };
}

const instancePath = (id: string) => `/canvas/instances/${encodeURIComponent(id)}`;

/** Starts a design from a published template. The server picks the revision (the latest) and names the design after the template. */
export const createInstance = (templateId: string) =>
  apiFetch<{ instance: { id: string; name: string; version: number; createdAt: string; baseRevision: { number: number; createdAt: string } } }>("/canvas/instances", {
    method: "POST",
    body: JSON.stringify({ templateId }),
  });
/** One page of my designs. Pass the previous page's `nextCursor` for the next one. */
export const listInstances = (cursor?: string | null, limit?: number, archived?: boolean) => {
  const query = new URLSearchParams();
  if (limit !== undefined) query.set("limit", String(limit));
  if (cursor) query.set("cursor", cursor);
  if (archived) query.set("archived", "1"); // the archived designs, whose history stays readable
  const qs = query.toString();
  return apiFetch<InstancePage>(`/canvas/instances${qs ? `?${qs}` : ""}`);
};
export const getInstance = (id: string) => apiFetch<{ instance: InstanceDetail }>(instancePath(id));
/**
 * Saves the COMPLETE set of changes (not a patch): a field left out goes back to the revision's value, and [] resets
 * everything. Answers with the new version, or 409 when `version` is no longer the stored one.
 */
export const saveInstance = (id: string, body: { version: number; overrides: OverrideEntry[]; name?: string }) =>
  apiFetch<{ version: number }>(instancePath(id), { method: "PUT", body: JSON.stringify(body) });
/**
 * Removes one of my designs. One that was never submitted is deleted for good; one that has been submitted is ARCHIVED
 * instead (`archived: true`): it can no longer be edited or submitted, and its history stays. Asking again answers the same.
 */
export const deleteInstance = (id: string) => apiFetch<{ ok: true; archived?: true }>(instancePath(id), { method: "DELETE" });

// ── Design review (phase 6) ─────────────────────────────────────────────────
// Marketing submits one of its designs; the design team approves it or asks for changes. A submission is a snapshot the SERVER
// made from the pinned revision and the saved changes. Names are the people's current names, never an email; "Former team
// member" stands for an account that no longer exists. Error codes the pages read from `error.data.code`: NO_CHANGES,
// NO_REVIEWER, VERSION_CONFLICT, UNKNOWN_ASSET, DESIGN_ARCHIVED, NOT_PENDING, INVALID_REQUEST.

/** Submits the design at the version the editor last saved, with an optional note for the designer. */
export const submitInstance = (id: string, version: number, note?: string) =>
  apiFetch<{ submission: { id: string; number: number; createdAt: string }; review: { id: string; status: ReviewStatus } }>(`${instancePath(id)}/submit`, {
    method: "POST",
    body: JSON.stringify(note ? { version, note } : { version }),
  });

export interface SubmissionEntry {
  number: number;
  name: string;
  note: string | null;
  createdAt: string;
  status: ReviewStatus | null;
  comment: string | null;
  decidedAt: string | null;
  /** The designer who answered, by name; null while it waits. */
  reviewer: string | null;
}

/** A date and time as the Canvas pages show them. */
export const formatWhen = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** My submissions of one design, newest first (also for an archived design). `nextCursor` is the number to continue from; `archived` says the design can no longer be edited or submitted. */
export const listSubmissions = (id: string, cursor?: string | null) =>
  apiFetch<{ submissions: SubmissionEntry[]; nextCursor: string | null; archived: boolean }>(`${instancePath(id)}/submissions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);

export interface SubmissionDetail extends SubmissionEntry {
  baseRevision: { number: number };
  /** The document as it was submitted, ready to draw read-only. */
  document: CanvasDocument;
}
export const getSubmission = (id: string, number: number) => apiFetch<{ submission: SubmissionDetail }>(`${instancePath(id)}/submissions/${number}`);

export interface ReviewQueueEntry {
  id: string;
  status: ReviewStatus;
  createdAt: string;
  decidedAt: string | null;
  number: number;
  name: string;
  note: string | null;
  baseRevisionNumber: number;
  submitter: string | null;
  /** The person archived the design after submitting. The review is still decided like any other. */
  archivedBySubmitter: boolean;
}
export interface FieldChange {
  nodeId: string;
  name: string;
  kind: "text" | "image";
  before: string;
  after: string;
}
export interface ReviewDetail {
  review: { id: string; status: ReviewStatus; comment: string | null; createdAt: string; decidedAt: string | null; reviewer: string | null };
  submission: { number: number; name: string; note: string | null; createdAt: string; submitter: string | null; baseRevision: { number: number }; document: CanvasDocument };
  changes: FieldChange[];
  /** The design was renamed since the previous submission (null: not, or this is the first). */
  rename: { before: string; after: string } | null;
  history: Array<{ number: number; name: string; createdAt: string; reviewId: string | null; status: ReviewStatus | null; decidedAt: string | null }>;
  archivedBySubmitter: boolean;
}

/** The design team's side. `view` is what waits ("pending") or what was answered ("decided"). */
export const reviewSummaryCount = () => apiFetch<{ pending: number; latestSubmittedAt: string | null }>("/canvas/reviews/summary");
export const listReviews = (view: "pending" | "decided", cursor?: string | null) => {
  const query = new URLSearchParams({ status: view });
  if (cursor) query.set("cursor", cursor);
  return apiFetch<{ reviews: ReviewQueueEntry[]; nextCursor: string | null }>(`/canvas/reviews?${query}`);
};
export const getReview = (id: string) => apiFetch<ReviewDetail>(`/canvas/reviews/${encodeURIComponent(id)}`);
export const decideReview = (id: string, decision: "approve" | "request_changes", comment?: string) =>
  apiFetch<{ ok: true; review: { id: string; status: ReviewStatus } }>(`/canvas/reviews/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    body: JSON.stringify(comment ? { decision, comment } : { decision }),
  });
