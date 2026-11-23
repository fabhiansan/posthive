import { isBlockedHost } from "./ssrf.js";

// What a media address on a post may look like. Two kinds exist and they are checked differently:
//
//  1. A file this app stored ("/uploads/<uuid>.jpg", or the adapter's own public address). It is never judged by its SHAPE: a writer accepts
//     it only when it is exactly the url of an Upload row the caller owns (lib/mediaDelete.ts, attachUploads), and the row's url is something
//     the server generated. toStoredUrl only maps the one other spelling people use (the API's own origin in front of /uploads/, which the
//     public API docs show) to the stored one, so it can match the row.
//  2. An address somebody else hosts, which the server downloads later (a Library CSV's image column, a YouTube video pasted by url).
//     externalMediaUrl is the whole rule for those: http(s), no credentials, no control characters, a host that is not blocked on its face.
//     Whether the name RESOLVES somewhere private is decided when it is fetched (lib/safeFetch.ts), not here.

const MAX_URL = 2048;

/**
 * The shape of a file this app stored under /uploads/: segments of letters, digits, "." "_" "-" that do not START with a dot, so no ".", "..",
 * and no dot-folder (the private Canvas folder is ".canvas-private"). Used wherever a path is turned into something that is fetched or read,
 * not to decide who may attach a file (that is the Upload row).
 */
export const isStoredUploadPath = (url: unknown): url is string =>
  typeof url === "string" && url.length <= MAX_URL && /^\/uploads\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(url);

/** Every address in a post's content that can be a stored file: the pictures and videos, the YouTube thumbnail and the YouTube video address. */
export function contentMediaUrls(content: string): string[] {
  try {
    const c = JSON.parse(content) as { mediaUrls?: unknown; youtubeThumbnailUrl?: unknown; youtubeVideoUrl?: unknown };
    return [...(Array.isArray(c.mediaUrls) ? c.mediaUrls : []), c.youtubeThumbnailUrl, c.youtubeVideoUrl].filter((u): u is string => typeof u === "string" && u.length > 0);
  } catch {
    return [];
  }
}

/** A list of media addresses from a request, in their stored spelling: an array of strings (each at most 2048 characters), or null. */
export function mediaUrlList(value: unknown, env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (!Array.isArray(value) || value.some((u) => typeof u !== "string" || u.length > MAX_URL)) return null;
  return (value as string[]).map((u) => toStoredUrl(u, env));
}

/** The stored spelling of an upload's address: "<API origin>/uploads/x.jpg" becomes "/uploads/x.jpg". Anything else is returned as it is. */
export function toStoredUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  for (const base of [env.PUBLIC_API_URL, env.API_URL]) {
    const origin = base?.replace(/\/+$/, "");
    if (origin && url.startsWith(`${origin}/uploads/`)) return url.slice(origin.length);
  }
  return url;
}

/** The address itself when it is an acceptable external media address, otherwise null. */
export function externalMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_URL || /[\u0000-\u001f\u007f\s\\]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || isBlockedHost(url.hostname)) return null;
  return value;
}
