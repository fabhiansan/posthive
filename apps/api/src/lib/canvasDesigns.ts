import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { decodeCursor, encodeCursor, type PageBoundary } from "./canvas.js";
import { INSTANCE, refuse, type Refusal } from "./canvasHttp.js";
import { canvasDesignMetadataProblem, pruneDesigns, type StoredDesign } from "./designImage.js";
import { isStoredUploadPath, toStoredUrl } from "./mediaUrl.js";
import type { StorageAdapter } from "./storage.js";

/**
 * Approved Canvas designs on a post (phase 7, T7). What the server establishes, and what it cannot:
 *   - the design is an APPROVED submission (DesignReviewRequest.status = 'approved'), the caller's own, in the active workspace;
 *   - the picture is a file stored by the Canvas route under that submission's own folder (the path binds it to the submission), is the
 *     caller's own upload (attachUploads), is a PNG that ends with its IEND chunk, and has exactly the snapshot's width and height.
 *   - it does NOT prove the pixels are the approved design: the picture is drawn in the browser and there is no server renderer. No
 *     pixel integrity, cryptographic or otherwise, is claimed. The PNG is never decoded here (shortcut: a PNG with a valid header and
 *     a damaged body passes; upgrade with a server-side decode if that ever matters).
 */

// ── The picture ─────────────────────────────────────────────────────────────

export const MAX_DESIGN_PNG_BYTES = 10_000_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const MAX_SIDE = 8192;

export class DesignImageRejected extends Error {
  constructor(
    message: string,
    readonly code: "NOT_PNG" | "SIZE_MISMATCH" | "TOO_LARGE",
  ) {
    super(message);
  }
}

const READ_BLOCK_BYTES = 64 * 1024;

/** Read at most MAX_DESIGN_PNG_BYTES into fixed-size blocks: a body delivered as millions of tiny chunks cannot amplify heap/array overhead. */
export async function readDesignPng(stream: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const blocks: Buffer[] = [];
  let block = Buffer.alloc(READ_BLOCK_BYTES);
  let used = 0;
  let size = 0;
  for await (const part of stream) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    for (let offset = 0; offset < chunk.length;) {
      if (used === READ_BLOCK_BYTES) {
        blocks.push(block);
        block = Buffer.alloc(READ_BLOCK_BYTES);
        used = 0;
      }
      const take = Math.min(READ_BLOCK_BYTES - used, chunk.length - offset);
      chunk.copy(block, used, offset, offset + take);
      used += take;
      offset += take;
      size += take;
      if (size > MAX_DESIGN_PNG_BYTES) throw new DesignImageRejected("The picture is larger than 10 MB.", "TOO_LARGE");
    }
  }
  if (size > 0) blocks.push(block.subarray(0, used));
  return Buffer.concat(blocks, size);
}

/** Throws DesignImageRejected unless `buf` is a PNG of exactly `want`. Reads the signature and the IHDR chunk by hand: nothing is decoded and no native library runs. */
export function checkDesignPng(buf: Buffer, want: { width: number; height: number }): void {
  if (buf.length > MAX_DESIGN_PNG_BYTES) throw new DesignImageRejected("The picture is larger than 10 MB.", "TOO_LARGE");
  // signature, then IHDR (length 13, type "IHDR") at the fixed offsets; the file must end with the IEND chunk (no truncation, no tail)
  const ok = buf.length >= 33 + IEND.length && buf.subarray(0, 8).equals(PNG_MAGIC) && buf.readUInt32BE(8) === 13 && buf.subarray(12, 16).toString("latin1") === "IHDR" && buf.subarray(buf.length - IEND.length).equals(IEND);
  if (!ok) throw new DesignImageRejected("The picture is not a complete PNG file.", "NOT_PNG");
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) throw new DesignImageRejected("The picture's size is not valid.", "NOT_PNG");
  if (width !== want.width || height !== want.height) throw new DesignImageRejected(`The picture is ${width}×${height}, but the approved design is ${want.width}×${want.height}.`, "SIZE_MISMATCH");
}

/** Where the Canvas route stores the picture of one submission; the folder is what binds a stored file to its submission. */
export const designFolder = (submissionId: string) => `canvas-designs/${submissionId}`;
const insideFolder = (url: string, submissionId: string) => url.startsWith(`/uploads/${designFolder(submissionId)}/`);

// ── Who may use which design ────────────────────────────────────────────────

type Db = Pick<Prisma.TransactionClient, "designSubmission">;

/**
 * One APPROVED submission of the caller's own, in the active workspace, with its size; null for anything else (another person's,
 * another workspace's, pending, changes requested, superseded, unknown). The approval status is the only criterion: an approved
 * request never changes again (trigger), so every approved version stays usable, not only the latest.
 */
export async function approvedSubmission(db: Db, id: string, workspaceId: string, userId: string): Promise<{ id: string; width: number; height: number } | null> {
  const row = await db.designSubmission.findFirst({
    where: { id, workspaceId, instance: { kind: INSTANCE, workspaceId, createdByUserId: userId }, review: { status: "approved" } },
    select: { id: true, document: true },
  });
  if (!row) return null;
  const { width, height } = (row.document ?? {}) as { width?: unknown; height?: unknown };
  return typeof width === "number" && typeof height === "number" ? { id: row.id, width, height } : null;
}

export interface AttachInput {
  /** What the request sent (already shape-checked), or undefined when it sent nothing: then the stored entries are only pruned. */
  sent: { submissionId: string; mediaUrl: string }[] | undefined;
  stored: StoredDesign[];
  /** The post's FINAL picture list, in stored spelling. */
  mediaUrls: string[];
  userId: string;
  workspaceId: string;
  db: Db;
  storage: Pick<StorageAdapter, "getBuffer">;
}

/**
 * The entries a post will store: pruned to the pictures it still has, with every NEW entry checked on the server from its own records
 * (never from anything the client claims). Entries the post already held are kept as they are (a draft is kept by the team, so the
 * author's design may be a colleague's). Runs BEFORE the media transaction, so no file is read under a lock; the transaction then locks
 * the Upload row (attachUploads), so a file deleted in between makes the save a 409 and never leaves a reference to a missing file.
 */
export async function resolveDesigns(a: AttachInput): Promise<{ designs: StoredDesign[] } | Refusal> {
  const candidates = a.sent === undefined ? a.stored : a.sent.map((e) => ({ submissionId: e.submissionId, mediaUrl: toStoredUrl(e.mediaUrl) }));
  const designs: StoredDesign[] = [];
  for (const e of pruneDesigns(candidates, a.mediaUrls)) {
    const held = a.stored.find((s) => s.mediaUrl === e.mediaUrl && s.submissionId === e.submissionId);
    if (held) {
      designs.push(held);
      continue;
    }
    // A file this app stored (never an external address): checked before the storage adapter is asked for it, so a URL of another shape
    // cannot reach a provider that would fail on it; the folder is what binds the file to the submission.
    if (!isStoredUploadPath(e.mediaUrl) || !insideFolder(e.mediaUrl, e.submissionId)) return refuse(409, "That picture is not the picture of this approved design.", "DESIGN_IMAGE_MISMATCH");
    const submission = await approvedSubmission(a.db, e.submissionId, a.workspaceId, a.userId);
    if (!submission) return refuse(409, "That design is not an approved design of yours in this workspace.", "DESIGN_NOT_APPROVED");
    let buf: Buffer;
    try {
      buf = await a.storage.getBuffer(e.mediaUrl);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT" || code === "EINVALIDKEY") return refuse(409, "The picture of this design is no longer available. Attach the design again.", "MEDIA_UNAVAILABLE");
      throw err;
    }
    try {
      checkDesignPng(buf, submission);
    } catch (err) {
      if (err instanceof DesignImageRejected) return refuse(409, err.message, "DESIGN_IMAGE_INVALID");
      throw err;
    }
    designs.push({ submissionId: e.submissionId, mediaUrl: e.mediaUrl, bytes: buf.length });
  }
  const metadataProblem = canvasDesignMetadataProblem({ mediaUrls: a.mediaUrls, canvasDesigns: designs });
  if (metadataProblem) return refuse(409, metadataProblem, "DESIGN_METADATA_REQUIRED");
  return { designs };
}

// ── The signed page cursor of the approved-designs list ─────────────────────
// The Phase 5 cursor (lib/canvas.ts) is shape-checked only. This one is signed and bound to the person and the workspace it was
// issued to: a cursor made up, altered, or replayed by someone else or in another workspace is refused, not merely filtered.

const MAC_BYTES = 32;
const CURSOR_MAX = 300;

/** HKDF of the existing ENCRYPTION_KEY (never rotated, see lib/encryption.ts); null when it is not configured. */
function cursorKey(): Buffer | null {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(hex, "hex"), Buffer.alloc(0), "canvas-approved-cursor", 32));
}

export const cursorsAvailable = (): boolean => cursorKey() !== null;

const macOf = (key: Buffer, workspaceId: string, userId: string, payload: string): Buffer => crypto.createHmac("sha256", key).update(`approved-v1\n${workspaceId}\n${userId}\n${payload}`).digest();

export function signCursor(row: { createdAt: Date; id: string }, workspaceId: string, userId: string): string {
  const key = cursorKey();
  if (!key) throw new Error("ENCRYPTION_KEY is not configured, so a cursor cannot be signed.");
  const payload = encodeCursor(row);
  return `${payload}.${macOf(key, workspaceId, userId, payload).toString("base64url")}`;
}

/** The boundary a cursor names, or null for ANYTHING that is not exactly what signCursor issued to this person in this workspace. Never throws. */
export function verifyCursor(raw: unknown, workspaceId: string, userId: string): PageBoundary | null {
  const key = cursorKey();
  if (!key || typeof raw !== "string" || raw.length === 0 || raw.length > CURSOR_MAX) return null;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [payload, mac] = parts;
  const given = Buffer.from(mac, "base64url");
  // exactly 32 bytes AND the canonical spelling (a lenient base64 tail would be a second spelling of the same MAC); checked before the
  // comparison because timingSafeEqual throws on buffers of different lengths
  if (given.length !== MAC_BYTES || given.toString("base64url") !== mac) return null;
  if (!crypto.timingSafeEqual(given, macOf(key, workspaceId, userId, payload))) return null;
  return decodeCursor(payload);
}
