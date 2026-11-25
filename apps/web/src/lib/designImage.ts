// The approved Canvas designs on a post (content.canvasDesigns) and the channels that cannot take them.
// Mirrored from apps/api/src/lib/designImage.ts: keep the rule table identical. The SERVER is the authority (it refuses with a 409 and the runner
// fails the post); this only shows the problem earlier. Each rule has a source, and a channel with no rule is UNKNOWN here, not "compatible".

export interface PostDesign {
  submissionId: string;
  mediaUrl: string;
  /** The size the server measured when the design was attached. */
  bytes?: number;
}

export function designsOf(value: unknown): PostDesign[] {
  if (!Array.isArray(value)) return [];
  const out: PostDesign[] = [];
  for (const e of value) {
    if (typeof e !== "object" || e === null) continue;
    const { submissionId, mediaUrl, bytes } = e as Record<string, unknown>;
    if (typeof submissionId !== "string" || typeof mediaUrl !== "string") continue;
    out.push({ submissionId, mediaUrl, ...(typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? { bytes } : {}) });
  }
  return out;
}

/** Only the designs whose picture is still on the post, each picture once. */
export function pruneDesigns(designs: PostDesign[], mediaUrls: readonly string[]): PostDesign[] {
  const seen = new Set<string>();
  return designs.filter((d) => mediaUrls.includes(d.mediaUrl) && !seen.has(d.mediaUrl) && seen.add(d.mediaUrl));
}

const NAME: Record<string, string> = { instagram: "Instagram", bluesky: "Bluesky", threads: "Threads", linkedin: "LinkedIn" };
const MAX_BYTES: Record<string, number> = { bluesky: 976_562, threads: 8_000_000, linkedin: 5_000_000 };
const JPEG_ONLY = new Set(["instagram"]);
const mb = (n: number) => `${(n / 1_000_000).toFixed(2)} MB`;

/** One plain sentence per channel that cannot take the post's approved design pictures (a PNG that is never converted). */
export function designImageProblems(designs: PostDesign[], platforms: readonly string[]): string[] {
  if (designs.length === 0) return [];
  const problems: string[] = [];
  for (const platform of new Set(platforms)) {
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
