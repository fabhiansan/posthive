// What a post stores about the approved Canvas designs attached to it (content.canvasDesigns), and which channels cannot take them.
// Pure: no database, no storage. Mirrored for the editor in apps/web/src/lib/designImage.ts; keep the two rule tables identical.
//
// INVARIANT every writer keeps: each entry's mediaUrl is ALSO in content.mediaUrls. The media lock, claim, copy and release code
// (lib/mediaDelete.ts) builds its address list from mediaUrls only, so a design file is protected exactly like any other picture.

export interface StoredDesign {
  submissionId: string;
  mediaUrl: string;
  /** Size of the PNG as the SERVER read it when the design was attached; never taken from the client. */
  bytes?: number;
}

/** The entries of a stored post's content, as far as they are well formed. Anything else is ignored, never trusted. */
export function designsOfContent(content: unknown): StoredDesign[] {
  const list = typeof content === "object" && content !== null ? (content as { canvasDesigns?: unknown }).canvasDesigns : undefined;
  if (!Array.isArray(list)) return [];
  const out: StoredDesign[] = [];
  for (const e of list) {
    if (typeof e !== "object" || e === null) continue;
    const { submissionId, mediaUrl, bytes } = e as Record<string, unknown>;
    if (typeof submissionId !== "string" || typeof mediaUrl !== "string") continue;
    out.push({ submissionId, mediaUrl, ...(typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? { bytes } : {}) });
  }
  return out;
}

/** Only the entries whose picture is still on the post, each picture once. This is the rule that makes a removed picture leave no stale reference. */
export function pruneDesigns(entries: StoredDesign[], mediaUrls: string[]): StoredDesign[] {
  const on = new Set(mediaUrls);
  const seen = new Set<string>();
  return entries.filter((e) => on.has(e.mediaUrl) && !seen.has(e.mediaUrl) && seen.add(e.mediaUrl));
}

/** A URL written by the Canvas-design upload route. Its prefix is server-owned provenance, not an ordinary upload. */
export const isCanvasDesignUploadPath = (url: unknown): url is string => typeof url === "string" && url.startsWith("/uploads/canvas-designs/");

const asContent = (content: unknown): Record<string, unknown> | null => {
  const parsed = (() => {
    if (typeof content !== "string") return content;
    try { return JSON.parse(content) as unknown; } catch { return null; }
  })();
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
};

/** A Canvas-design picture without its server-validated metadata can never be treated as an ordinary upload. */
export function canvasDesignMetadataProblem(content: unknown): string | null {
  const parsed = asContent(content);
  if (!parsed) return null;
  const mediaUrls = Array.isArray(parsed.mediaUrls) ? parsed.mediaUrls : [];
  const described = new Set(designsOfContent(parsed).map((d) => d.mediaUrl));
  const everyMediaField = [...mediaUrls, parsed.youtubeThumbnailUrl, parsed.youtubeVideoUrl];
  return everyMediaField.some((url) => isCanvasDesignUploadPath(url) && !described.has(url))
    ? "A picture from an approved Canvas design is attached without its design details. Reattach the approved design before publishing."
    : null;
}

const NAME: Record<string, string> = { instagram: "Instagram", bluesky: "Bluesky", threads: "Threads", linkedin: "LinkedIn" };

// Each rule has a stated source. No other channel has a rule: its limits are UNKNOWN here, which is not the same as "compatible".
//  - Bluesky 976,562 bytes, Threads 8,000,000, LinkedIn 5,000,000: the ceilings lib/compress.ts already applies to every other upload.
//  - Instagram takes JPEG only for publishing (Meta's Content Publishing documentation). Documented, not tested in this repo.
const MAX_BYTES: Record<string, number> = { bluesky: 976_562, threads: 8_000_000, linkedin: 5_000_000 };
const JPEG_ONLY = new Set(["instagram"]);

const mb = (n: number) => `${(n / 1_000_000).toFixed(2)} MB`;

/**
 * One plain sentence per channel that cannot take the post's approved design pictures (always PNG, never converted). Empty = no known
 * problem (which does not prove every other channel accepts it).
 */
export function designImageProblems(content: unknown, platforms: Iterable<string>): string[] {
  const parsed = asContent(content);
  const metadataProblem = canvasDesignMetadataProblem(parsed);
  const designs = designsOfContent(parsed);
  if (designs.length === 0 && !metadataProblem) return [];
  const problems: string[] = [];
  for (const platform of new Set(platforms)) {
    if (metadataProblem) {
      problems.push(metadataProblem); // fail closed for every channel, including one with no size/format rule
      continue;
    }
    const name = NAME[platform] ?? platform;
    if (JPEG_ONLY.has(platform)) {
      problems.push(`${name} publishes JPEG pictures only, and an approved Canvas design is a PNG that Posthive does not convert. Remove the design or pick another channel.`);
      continue;
    }
    const max = MAX_BYTES[platform];
    const big = max === undefined ? undefined : designs.find((d) => d.bytes !== undefined && d.bytes > max);
    if (big?.bytes !== undefined && max !== undefined) problems.push(`${name} accepts pictures up to ${mb(max)}, and an approved Canvas design on this post is ${mb(big.bytes)}. Posthive does not shrink it. Remove the design or pick another channel.`);
  }
  return problems;
}
