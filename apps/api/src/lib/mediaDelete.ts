import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { externalMediaUrl, isStoredUploadPath } from "./mediaUrl.js";
import type { StorageAdapter } from "./storage.js";

/**
 * Who may attach an uploaded file to something, and who may delete it, without losing a file that is still in use.
 *
 * THE PROBLEM. A file can be used by several rows at once (a duplicate, a repeating post, a Library item, a template, a published post),
 * and PostJob.content is a JSON string, so the database cannot see which Upload a post uses: no foreign key can stop a delete. Checking
 * "is it still used?" and then deleting is not safe either, because a writer can attach the file between the check and the delete.
 *
 * THE PROTOCOL (Postgres, READ COMMITTED, row locks on the Upload row; no migration):
 *  - A WRITER that attaches a file calls attachUploads (a new attachment) or lockForCopy (a copy of an existing post) in the SAME
 *    transaction as the write that stores the reference. Both lock the Upload rows of the whole set in one statement, sorted, so two
 *    multi-file operations cannot deadlock. attachUploads then requires every NEW file to exist and be the caller's; lockForCopy requires
 *    that the post it copies from still exists (see there for why).
 *  - A DELETER calls releaseMedia, which in one transaction locks the same rows, checks the owner, scans EVERY place that can reference
 *    the file (not only the one being removed), deletes the Upload row only if nothing does, and unlinks the file AFTER the commit.
 *  The lock makes the two orders safe. Writer first: the deleter waits for the writer's commit, its scan then sees the new reference and
 *  keeps the file. Deleter first: the writer waits, finds the row gone, and fails cleanly (409). Either way no reference to a deleted file
 *  is made.
 *
 * WHAT THIS DOES NOT GUARANTEE, stated plainly:
 *  - It only protects writers that call these functions. Nothing in the database forces a writer to: a NEW code path that stores a media
 *    address without taking the lock can commit it between a deleter's scan and its commit, and the file is lost. mediaWriters.test.ts
 *    lists today's writers and fails when a new one appears unlisted; it cannot make a future writer correct. Making that impossible needs
 *    a reference table with a RESTRICT foreign key kept by a trigger: a migration, outside Gate S.
 *  - The scan is a substring search over PostJob.content and LibraryItem.mediaUrls for the stored address, so a reference written in some
 *    other form (a percent-encoded or re-based address) is not seen. Every writer stores the address exactly as /upload returned it.
 *  - A file whose Upload row does not exist is never deleted here (a leak, never a loss). A crash between the commit and the unlink leaves
 *    the file on disk with no row (also a leak). A file attached by a colleague other than the post's author is not removed when the post
 *    goes (it stays: a leak). The substring test can only over-report a reference, which keeps a file, never loses one.
 *  - The scan reads every PostJob row's content text (no index can help a substring), once per chunk of 100 files, on a delete only.
 *    Not measured on real data. Upgrade if it gets slow: a trigram index on PostJob.content (a migration, its own gate).
 */

type Tx = Prisma.TransactionClient;
type Db = Pick<typeof prisma, "$transaction"> & Tx;

/** A write named a file that was removed, or that the caller did not upload. The routes answer 409. */
export class MediaUnavailable extends Error {
  readonly code = "MEDIA_UNAVAILABLE";
  constructor() {
    super("One of the images was removed or was not uploaded by you. Upload it again.");
    this.name = "MediaUnavailable";
  }
}

/** A write named an address that is not a file of ours and is not allowed to be an outside address. The routes answer 400. */
export class BadMediaUrl extends Error {
  readonly code = "INVALID_MEDIA_URL";
  constructor(url: string) {
    super(`This address cannot be used as media: ${url.length > 80 ? `${url.slice(0, 80)}...` : url}. Attach an image you uploaded.`);
    this.name = "BadMediaUrl";
  }
}

/**
 * The 4xx a media problem becomes, for every writer: an image that was removed is a 409 the person can act on ("upload it again"), an
 * address that is not allowed is a 400. Anything else is not a media problem (null): the caller rethrows it.
 */
export function mediaProblem(err: unknown): { status: number; body: { error: string; code: string } } | null {
  if (err instanceof MediaUnavailable) return { status: 409, body: { error: err.message, code: err.code } };
  if (err instanceof BadMediaUrl) return { status: 400, body: { error: err.message, code: err.code } };
  return null;
}

interface UploadRow {
  url: string;
  userId: string;
  claimedAt: Date | null;
}

/** Locks the Upload rows that exist for these urls, in a fixed order, and returns them. Call inside a transaction. */
export async function lockUploads(tx: Tx, urls: Iterable<string>): Promise<Map<string, UploadRow>> {
  const unique = [...new Set(urls)].sort();
  if (!unique.length) return new Map();
  const rows = await tx.$queryRaw<UploadRow[]>`SELECT "url", "userId", "claimedAt" FROM "Upload" WHERE "url" = ANY(${unique}) ORDER BY "url" FOR UPDATE`;
  return new Map(rows.map((r) => [r.url, r]));
}

/**
 * For a WRITER that attaches files, inside the transaction that stores the reference.
 *  - Every url that is not in `keep` must be an Upload row of `userId` (it is then claimed, so the orphan cleaner leaves it alone), or
 *    MediaUnavailable (a stored path with no row, or somebody else's row) / BadMediaUrl (anything else).
 *  - `external`: the urls that may have NO row, because they are an outside address (a pasted YouTube link, a Library CSV's picture). They
 *    must pass externalMediaUrl. A url that does have a row is always treated as an upload, whatever list it is in.
 *  - `keep`: what the row being edited already references. An edit resends every address it holds, and a draft is kept by the team, so a
 *    kept file may be a colleague's, or have no row at all: those are locked, not required, not claimed.
 */
export async function attachUploads(
  tx: Tx,
  urls: Iterable<string>,
  how: { userId: string; keep?: Iterable<string>; external?: Iterable<string> },
): Promise<void> {
  const wanted = [...new Set(urls)];
  if (!wanted.length) return;
  const rows = await lockUploads(tx, wanted);
  const keep = new Set(how.keep ?? []);
  const external = new Set(how.external ?? []);
  const claim: string[] = [];
  for (const url of wanted) {
    if (keep.has(url)) continue;
    const row = rows.get(url);
    if (row) {
      if (row.userId !== how.userId) throw new MediaUnavailable();
      claim.push(url);
    } else if (isStoredUploadPath(url)) {
      throw new MediaUnavailable();
    } else if (!external.has(url) || !externalMediaUrl(url)) {
      throw new BadMediaUrl(url);
    }
  }
  if (claim.length) await tx.upload.updateMany({ where: { url: { in: claim }, userId: how.userId }, data: { claimedAt: new Date() } });
}

/**
 * For a WRITER that copies the files of an existing post or Library item into a new row (a duplicate, a repeat, a drip post).
 * The files are locked, then `stillThere` must confirm the row being copied from still exists. That second step is what makes the copy
 * safe: the source was read BEFORE this transaction, so a deleter may have removed the source, found nothing referencing the file, and
 * deleted it while this copy waited for the lock. If the source is still there once the lock is held, a deleter that comes later sees
 * the copy in its scan; if it is gone, the copy fails instead of pointing at a deleted file.
 */
export async function lockForCopy(tx: Tx, urls: Iterable<string>, stillThere: (tx: Tx) => Promise<boolean>): Promise<void> {
  const list = [...new Set(urls)];
  if (!list.length) return;
  await lockUploads(tx, list);
  if (!(await stillThere(tx))) throw new MediaUnavailable();
}

/** Runs `write` in a transaction that first takes the locks `prepare` asks for. With no files there is nothing to lock: it runs as it is. */
export async function withUploads<T>(urls: Iterable<string>, prepare: (tx: Tx) => Promise<void>, write: (db: Tx) => Promise<T>, db: Db = prisma): Promise<T> {
  if (![...urls].length) return write(db);
  return db.$transaction(
    async (tx) => {
      await prepare(tx);
      return write(tx);
    },
    { timeout: 30_000 },
  );
}

/**
 * The urls (of those asked about) that something still points to: a post, a Library item, a template, or a legacy template kit.
 * `ignoreJobs`: posts that do not count (the failed posts whose files the cleanup is removing: the post row stays, its files go).
 */
export async function referencedUrls(tx: Tx, urls: string[], ignoreJobs: string[] = []): Promise<Set<string>> {
  const found = new Set<string>();
  if (!urls.length) return found;
  // strpos, not LIKE: a file name can hold % and _. The stored address is a substring of the JSON text whichever field holds it.
  const inText = await tx.$queryRaw<{ url: string }[]>`
    SELECT u AS url FROM unnest(${urls}::text[]) AS u
    WHERE EXISTS (SELECT 1 FROM "PostJob" p WHERE p."id" <> ALL(${ignoreJobs}::text[]) AND strpos(p."content", u) > 0)
       OR EXISTS (SELECT 1 FROM "LibraryItem" l WHERE strpos(l."mediaUrls"::text, u) > 0)`;
  for (const r of inText) found.add(r.url);
  const [templates, legacy] = await Promise.all([
    tx.template.findMany({ where: { OR: [{ previewUrl: { in: urls } }, { slideUrls: { hasSome: urls } }] }, select: { previewUrl: true, slideUrls: true } }),
    tx.legacyTemplateMedia.findMany({ where: { url: { in: urls } }, select: { url: true } }),
  ]);
  for (const l of legacy) found.add(l.url);
  for (const t of templates) {
    if (t.previewUrl) found.add(t.previewUrl);
    for (const s of t.slideUrls ?? []) found.add(s);
  }
  return found;
}

/**
 * For a DELETER, after it has removed (or changed) the row that used to reference the files. Removes a file only when its Upload row
 * exists, belongs to an allowed owner, and nothing references it any more. Returns the urls it removed.
 *  - owners: the people whose uploads may go (the post's author, and the person acting: a draft is kept by the team, so the person editing
 *    may have uploaded the file or may be removing a colleague's).
 *  - "unclaimed": the orphan cleaner. Only rows nobody claimed; one that something references anyway (an upload attached through a path
 *    that did not claim it, before this existed) is claimed instead of deleted.
 *  - ignoreJobs: see referencedUrls. pauseMs: wait between batches of 10 unlinks (the failed-job cleanup spreads its deletes).
 */
export async function releaseMedia(
  storage: Pick<StorageAdapter, "delete">,
  urls: Iterable<string>,
  owners: Iterable<string> | "unclaimed",
  opts: { ignoreJobs?: string[]; pauseMs?: number; db?: Pick<typeof prisma, "$transaction"> } = {},
): Promise<string[]> {
  const db = opts.db ?? prisma;
  const ownerSet = owners === "unclaimed" ? null : new Set(owners);
  const candidates = [...new Set(urls)].filter((u) => typeof u === "string" && u.length > 0);
  const removed: string[] = [];
  for (let i = 0; i < candidates.length; i += 100) {
    const chunk = candidates.slice(i, i + 100);
    const doomed = await db.$transaction(
      async (tx) => {
        const rows = await lockUploads(tx, chunk);
        const eligible = chunk.filter((u) => {
          const row = rows.get(u);
          return !!row && (ownerSet ? ownerSet.has(row.userId) : row.claimedAt === null);
        });
        if (!eligible.length) return [];
        const used = await referencedUrls(tx, eligible, opts.ignoreJobs);
        const free = eligible.filter((u) => !used.has(u));
        if (!ownerSet && used.size) await tx.upload.updateMany({ where: { url: { in: [...used] }, claimedAt: null }, data: { claimedAt: new Date() } });
        if (free.length) await tx.upload.deleteMany({ where: { url: { in: free } } });
        return free;
      },
      { timeout: 30_000 },
    );
    // After the commit: the row is gone, so no writer can attach this file any more. An unlink that fails leaves a file with no row.
    for (let j = 0; j < doomed.length; j += 10) {
      await Promise.allSettled(doomed.slice(j, j + 10).map((u) => storage.delete(u)));
      if (opts.pauseMs && j + 10 < doomed.length) await new Promise((r) => setTimeout(r, opts.pauseMs));
    }
    removed.push(...doomed);
  }
  return removed;
}
