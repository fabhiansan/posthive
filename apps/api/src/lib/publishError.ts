/**
 * What a person reads when a post does not go out. A platform answers with JSON, a status code and a
 * developer's sentence ("Requested version 20251101 is not active"); the drawer, the activity line and the
 * failure e-mail show the sentence from here instead. The raw text stays in the server log and in Sentry.
 *
 * One function turns any error into one or two plain sentences: what happened and what to do. It is also
 * safe to run on a text that is already plain, so rows saved before this existed are explained when they are read.
 */

/**
 * A platform said no. `message` keeps the raw answer for the log and for Sentry ("LinkedIn post failed: {...}");
 * `status` is the HTTP status, so explainPublishError does not have to dig it out of the text.
 */
export class PublishError extends Error {
  constructor(label: string, readonly body: string, readonly status: number) {
    super(`${label}: ${body}`);
    this.name = "PublishError";
  }
}

/** Display name of a platform id: "twitter" is "X". Keep in sync with apps/web/src/lib/platforms.ts. */
const NAMES: Record<string, string> = {
  bluesky: "Bluesky", threads: "Threads", linkedin: "LinkedIn", mastodon: "Mastodon", pixelfed: "Pixelfed",
  youtube: "YouTube", facebook: "Facebook", pinterest: "Pinterest", telegram: "Telegram", nostr: "Nostr",
  twitter: "X", instagram: "Instagram", tumblr: "Tumblr", lemmy: "Lemmy", googlebusiness: "Google Business",
  tiktok: "TikTok", discord: "Discord",
};

export function platformName(platform: string): string {
  return NAMES[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
}

/**
 * Most characters of text a platform takes, for the platforms that REJECT a longer post and whose adapter does not
 * cut it. (TikTok, Pinterest, YouTube and Lemmy cut the text themselves, and Mastodon's limit depends on the instance.)
 * Keep in sync with PLATFORM_LIMIT in apps/web/src/components/PlatformPreview.tsx.
 */
export const TEXT_LIMIT: Record<string, number> = { bluesky: 300, threads: 500, linkedin: 3000, instagram: 2200, discord: 2000, googlebusiness: 1500 };

/**
 * Characters as a person counts them: an emoji is one, a family emoji is one. This is what the compose page counts
 * (countGraphemes in apps/web/src/components/PlatformPreview.tsx), so a post the page accepts is not refused here.
 */
const lengthOf = (text: string): number => [...new Intl.Segmenter().segment(text)].length;

/** Said before the platform is called, so a long post fails with a number instead of a platform's JSON. Null: it fits. */
export function textLimitProblem(platform: string, text: string): string | null {
  const limit = TEXT_LIMIT[platform];
  // a text can have no more characters than UTF-16 units: one that is short enough in units needs no counting
  if (!limit || text.length <= limit) return null;
  const length = lengthOf(text);
  if (length <= limit) return null;
  return `This post has ${length.toLocaleString("en-US")} characters. ${platformName(platform)} allows up to ${limit.toLocaleString("en-US")}. Shorten it and try again.`;
}

/** The HTTP status inside a platform's answer: {"status":426}, "(400)", "API error: 401" or "post failed: 503 Service Unavailable". */
function statusOf(text: string): number | null {
  const m = /"status"\s*:\s*(\d{3})|\((\d{3})\)|(?:API error|failed|error):?\s*(\d{3})\b|\bstatus\s*:?\s*(\d{3})\b/i.exec(text);
  const n = m ? Number(m[1] ?? m[2] ?? m[3] ?? m[4]) : NaN;
  return n >= 100 && n <= 599 ? n : null;
}

const VERSION = /nonexistent_version|version \S+ is not active/i;
const EXPIRED = /invalid access token|access token.{0,40}(expired|invalid)|token (has )?(expired|been revoked)|expired token|revoked|invalid_token|invalid_grant|session has expired|oauthexception|unauthorized|authentication (expired|failed)|please reconnect|token refresh failed/i;
const PERMISSION = /permission|not authorized|insufficient|\bscope\b|forbidden|access denied/i;
// "quota" is YouTube's 403 for a used-up day; "limit reached" is Facebook's (#4) / (#17) / (#32), which arrive typed OAuthException
const RATE = /rate.?limit|too many requests|throttl|quota|limit reached/i;
// `econn` alone also matches "reconnect", which is what the adapters tell a person whose token has expired
const NETWORK = /fetch failed|\betimedout\b|\beconn(?:refused|reset|aborted)\b|\benotfound\b|network error|socket hang up/i;
const SLOW = /timed out|timeout/i;
// not a bare "exceed": "you have exceeded your quota" is a limit on the account, not on the text
const TOO_LONG = /too long|longer than|exceeds? (the )?(max|maximum|character|length)|character limit|maximum length|max(imum)? .{0,20}characters/i;
const DUPLICATE = /duplicate|already (posted|been posted)/i;
const MEDIA = /image|photo|video|media|aspect ratio|file size|mime/i;

/** `error` is whatever the adapter threw (or the text saved on an old row). */
export function explainPublishError(platform: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const text = raw.replace(/^(\w*Error:\s*)+/, "").trim();
  const status = error instanceof PublishError ? error.status : statusOf(text);
  const P = platformName(platform);

  if (status === 426 || VERSION.test(text)) {
    return `${P} changed how its connection works, and ours is out of date. Nothing is wrong with your post or your account. We have been alerted. Try again later.`;
  }
  // before the 401/403 rules: a used-up quota arrives as a 403, and Facebook's "request limit reached" as an OAuthException
  if (status === 429 || RATE.test(text)) {
    return `${P} is limiting how fast we can post. Wait a few minutes, then try again.`;
  }
  if (status === 401 || EXPIRED.test(text)) {
    return `Your ${P} connection has expired. Reconnect ${P} on the Accounts page, then send the post again.`;
  }
  if (status === 403 || PERMISSION.test(text)) {
    return `${P} did not allow this. Reconnect ${P} on the Accounts page and accept every permission it asks for.`;
  }
  if (status !== null && status >= 500) return `${P} had a problem on its side. Try again in a few minutes.`;
  if (NETWORK.test(text)) return `We could not reach ${P}. Try again in a few minutes.`;
  if (SLOW.test(text)) return `${P} is taking too long to answer. Try again in a few minutes.`;

  // A plain sentence the adapter wrote itself ("Instagram requires at least one image.") is already for a person.
  if (!/[{<]/.test(text) && text.length > 0 && text.length <= 200) return text;

  if (TOO_LONG.test(text)) return `The text is too long for ${P}. Shorten it and try again.`;
  if (DUPLICATE.test(text)) return `${P} refused the post because the same text was posted recently. Change the text and try again.`;
  if (status === 400 || status === 422 || status === 413) {
    return MEDIA.test(text)
      ? `${P} could not use the picture or video. Check the file type and size, then try again.`
      : `${P} rejected the post. Check the text and pictures, then try again.`;
  }
  return `Posting to ${P} failed. Try again, and contact support if it keeps happening.`;
}
