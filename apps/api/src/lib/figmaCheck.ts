// "Is this Figma link something Marketing can open?" Asked of Figma itself, with no token: its public oEmbed answer is 200
// with the file's title for a file shared as "anyone with the link", and 404 for a file that is private or does not exist.
// Figma does not document this address (its official oEmbed needs a token), so an answer we do not understand is never a
// refusal: the designer is warned and can still send. There is no frame count without the token.
import { isFigmaDesignUrl } from "./figmaLink.js";
import { safeFetch as realSafeFetch, SafeFetchError } from "./safeFetch.js";

export type FigmaCheck =
  /** Opens for anyone with the link; `title` is the file's name when Figma sent one. */
  | { state: "valid"; title: string | null }
  /** Not a figma.com file, design, prototype or board link. */
  | { state: "format" }
  /** Figma says it is not found: private, deleted or mistyped. */
  | { state: "private" }
  /** Figma could not be asked (timeout, error, an answer we do not know): the link is not proven either way. */
  | { state: "unreachable" };

const OEMBED = "https://www.figma.com/api/oembed";
const TOTAL_TIMEOUT_MS = 5_000;
/** An oEmbed answer is a small JSON object. */
const MAX_BYTES = 64 * 1024;

export async function checkFigmaLink(raw: string, fetcher: typeof realSafeFetch = realSafeFetch): Promise<FigmaCheck> {
  const url = raw.trim();
  if (!isFigmaDesignUrl(url)) return { state: "format" };
  try {
    const res = await fetcher(`${OEMBED}?url=${encodeURIComponent(url)}`, {
      headers: { accept: "application/json" },
      totalTimeoutMs: TOTAL_TIMEOUT_MS,
      connectTimeoutMs: TOTAL_TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      maxRedirects: 0,
    });
    if (res.status === 404) return { state: "private" };
    if (!res.ok) return { state: "unreachable" };
    const body: unknown = await res.json();
    const title = body && typeof body === "object" && typeof (body as { title?: unknown }).title === "string" ? (body as { title: string }).title.trim().slice(0, 200) : "";
    return { state: "valid", title: title || null };
  } catch (err) {
    if (!(err instanceof SafeFetchError)) console.warn("[figma] the check failed:", (err as Error).message);
    return { state: "unreachable" };
  }
}
