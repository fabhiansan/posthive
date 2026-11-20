// What a person reads when a post does not go out: never a platform's JSON, a status code or a developer's sentence.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { PublishError, TEXT_LIMIT, explainPublishError, platformName, textLimitProblem } from "./publishError.js";

const say = (platform: string, message: string) => explainPublishError(platform, new Error(message));

describe("explainPublishError", () => {
  it("the retired LinkedIn version from the report: it is not the person's fault, and they are told so", () => {
    const text = say("linkedin", 'LinkedIn post failed: {"status":426,"code":"NONEXISTENT_VERSION","message":"Requested version 20251101 is not active"}');
    expect(text).toBe("LinkedIn changed how its connection works, and ours is out of date. Nothing is wrong with your post or your account. We have been alerted. Try again later.");
  });

  it("the same row as the drawer stored it before this existed, with its 'Error:' lead, reads the same", () => {
    const stored = 'Error: LinkedIn post failed: {"status":426,"code":"NONEXISTENT_VERSION","message":"Requested version 20251101 is not active"}';
    expect(explainPublishError("linkedin", stored)).toBe(say("linkedin", stored.replace(/^Error: /, "")));
    expect(explainPublishError("linkedin", stored)).toMatch(/^LinkedIn changed how its connection works/);
  });

  it.each([
    ["linkedin", 'LinkedIn post failed: {"status":401,"serviceErrorCode":65600,"code":"INVALID_ACCESS_TOKEN","message":"Invalid access token"}', "Your LinkedIn connection has expired. Reconnect LinkedIn on the Accounts page, then send the post again."],
    ["instagram", "Instagram token expired — please reconnect your Instagram account.", "Your Instagram connection has expired. Reconnect Instagram on the Accounts page, then send the post again."],
    ["twitter", "X authentication expired. Please reconnect your X account.", "Your X connection has expired. Reconnect X on the Accounts page, then send the post again."],
    ["linkedin", 'LinkedIn post failed: {"status":403,"code":"ACCESS_DENIED","message":"Not enough permissions to access: partnerApiPostsExternal.CREATE.20260901"}', "LinkedIn did not allow this. Reconnect LinkedIn on the Accounts page and accept every permission it asks for."],
    ["threads", 'Threads publish failed: {"error":{"message":"Too many requests","code":4}}', "Threads is limiting how fast we can post. Wait a few minutes, then try again."],
    ["facebook", 'Facebook photo post failed: {"status":429}', "Facebook is limiting how fast we can post. Wait a few minutes, then try again."],
    ["tumblr", 'Tumblr post failed: {"meta":{"status":503,"msg":"Service Unavailable"}}', "Tumblr had a problem on its side. Try again in a few minutes."],
    ["discord", "Discord post failed: fetch failed", "We could not reach Discord. Try again in a few minutes."],
    ["instagram", "Instagram media container timed out", "Instagram is taking too long to answer. Try again in a few minutes."],
    // the adapters' own words for an expired token say "reconnect": that is not a network failure
    ["youtube", "YouTube token refresh failed — please reconnect your YouTube account. (invalid_grant)", "Your YouTube connection has expired. Reconnect YouTube on the Accounts page, then send the post again."],
    ["discord", "Discord post failed: connect ECONNREFUSED 127.0.0.1:443", "We could not reach Discord. Try again in a few minutes."],
    ["mastodon", "Mastodon API error: getaddrinfo ENOTFOUND mastodon.example", "We could not reach Mastodon. Try again in a few minutes."],
    // a used-up quota is the account's limit, not the text's: it used to be explained as "the text is too long"
    ["youtube", 'YouTube upload init failed: 403 {"error":{"code":403,"message":"The request cannot be completed because you have exceeded your quota.","errors":[{"reason":"quotaExceeded"}]}}', "YouTube is limiting how fast we can post. Wait a few minutes, then try again."],
    // Facebook says "limit reached" as an OAuthException, which is also what an expired token is called
    ["facebook", 'Facebook text post failed: {"error":{"message":"(#4) Application request limit reached","type":"OAuthException","code":4}}', "Facebook is limiting how fast we can post. Wait a few minutes, then try again."],
    // a bare status after "failed:" (Tumblr and Threads send no JSON) was not read, and the raw line was shown
    ["tumblr", "Tumblr post failed: 503 ", "Tumblr had a problem on its side. Try again in a few minutes."],
    ["threads", "Threads container creation failed: 500 Internal Server Error", "Threads had a problem on its side. Try again in a few minutes."],
  ])("%s: %j is explained as a sentence", (platform, message, expected) => {
    expect(say(platform, message)).toBe(expected);
  });

  it("a PublishError carries its status, so a body that does not say it is still understood", () => {
    expect(explainPublishError("linkedin", new PublishError("LinkedIn post failed", "{}", 401))).toMatch(/^Your LinkedIn connection has expired/);
    expect(explainPublishError("linkedin", new PublishError("LinkedIn post failed", "", 503))).toBe("LinkedIn had a problem on its side. Try again in a few minutes.");
    expect(new PublishError("LinkedIn post failed", '{"a":1}', 400).message).toBe('LinkedIn post failed: {"a":1}'); // the raw answer stays for the log
  });

  it("a sentence an adapter already wrote for a person is kept as it is", () => {
    expect(say("instagram", "Instagram requires at least one image. Text-only posts are not supported.")).toBe("Instagram requires at least one image. Text-only posts are not supported.");
    expect(say("twitter", "X allows a maximum of 4 media items per post.")).toBe("X allows a maximum of 4 media items per post.");
  });

  it("a rejected post names the likely cause when the answer says it: too long, a duplicate, a bad picture", () => {
    expect(say("bluesky", `Bluesky post failed: {"error":"InvalidRequest","message":"Record/text must not be longer than 300 graphemes"}`)).toBe("The text is too long for Bluesky. Shorten it and try again.");
    expect(say("mastodon", 'Mastodon API error: {"error":"Validation failed: Text character limit of 500 exceeded"}')).toBe("The text is too long for Mastodon. Shorten it and try again.");
    expect(say("twitter", 'X post failed: {"status":400,"detail":"You are not allowed to create a Tweet with duplicate content."}')).toBe("X refused the post because the same text was posted recently. Change the text and try again.");
    expect(say("facebook", 'Facebook photo post failed: {"status":400,"message":"Invalid image aspect ratio"}')).toBe("Facebook could not use the picture or video. Check the file type and size, then try again.");
    expect(say("pinterest", 'Pinterest pin creation failed (400): {"message":"Invalid parameters"}')).toBe("Pinterest rejected the post. Check the text and pictures, then try again.");
  });

  it("'exceeded' alone is not a length: a daily cap or a size cap is not 'the text is too long'", () => {
    expect(say("pinterest", 'Pinterest pin creation failed (400): {"message":"You have exceeded your daily pin cap"}')).toBe("Pinterest rejected the post. Check the text and pictures, then try again.");
    expect(say("lemmy", 'Lemmy post failed: {"error":"exceeded the allowed number of posts"}')).toBe("Posting to Lemmy failed. Try again, and contact support if it keeps happening.");
  });

  it("anything it does not know still says which platform and what to do, with no JSON in it", () => {
    const text = say("lemmy", 'Lemmy post failed: {"error":"unknown","stack":"at x (file.js:1:1)"}');
    expect(text).toBe("Posting to Lemmy failed. Try again, and contact support if it keeps happening.");
  });

  it("whatever goes in, no JSON, braces, status code or 'Error:' comes out", () => {
    const inputs = [
      'LinkedIn post failed: {"status":426,"code":"NONEXISTENT_VERSION"}',
      'Error: Error: X post failed: {"title":"Forbidden","status":403}',
      "Threads container creation failed: 500 Internal Server Error",
      new TypeError("fetch failed"),
      "",
      null,
      undefined,
      { weird: true },
    ];
    for (const input of inputs) {
      const out = explainPublishError("linkedin", input);
      expect(out).not.toMatch(/[{}]|"status"|Error:|NONEXISTENT/);
      expect(out.length).toBeGreaterThan(10);
    }
  });

  it("an unknown platform id still gets a readable name", () => {
    expect(say("newthing", "boom: {}")).toBe("Posting to Newthing failed. Try again, and contact support if it keeps happening.");
  });
});

describe("a sentence it already made is shown as it is", () => {
  // The drawer explains EVERY saved reason, new rows (already a sentence, written by the runner) and old ones (raw JSON). If a
  // sentence of ours were read as an error and rewritten, the same failure would read differently in two places.
  const platforms = ["linkedin", "instagram", "twitter", "bluesky", "threads", "facebook", "tiktok", "pinterest", "discord"];
  const raw = [
    'LinkedIn post failed: {"status":426,"code":"NONEXISTENT_VERSION"}',
    'LinkedIn post failed: {"status":401,"code":"INVALID_ACCESS_TOKEN"}',
    'LinkedIn post failed: {"status":403,"code":"ACCESS_DENIED"}',
    'Threads publish failed: {"error":{"message":"Too many requests"}}',
    "Tumblr post failed: 503 Service Unavailable",
    "Discord post failed: fetch failed",
    "Instagram media container timed out",
    "Bluesky post failed: Record/text must not be longer than 300 graphemes",
    "X post failed: duplicate content",
    'Facebook photo post failed: {"status":400,"message":"Invalid image aspect ratio"}',
    'Pinterest pin creation failed (400): {"message":"Invalid parameters"}',
    "something nobody has seen before: {}",
  ];

  it.each(platforms)("%s: explaining an explanation changes nothing, for every kind of failure", (platform) => {
    const sentences = [
      ...raw.map((r) => explainPublishError(platform, r)),
      textLimitProblem("linkedin", "x".repeat(3214))!,
      "We tried to post this three times and it did not go through. Check your connection on the Accounts page, then send it again.",
      "Your subscription is on hold, so this post was not sent. Update your plan on the Billing page, then send it again.",
      "The post went out, but we lost track of it, so the first comment could not be added. Add the comment on the platform itself.",
    ];
    for (const s of sentences) expect(explainPublishError(platform, s)).toBe(s);
  });
});

describe("platformName", () => {
  it("names a platform the way a person says it: twitter is X", () => {
    expect(platformName("twitter")).toBe("X");
    expect(platformName("linkedin")).toBe("LinkedIn");
    expect(platformName("googlebusiness")).toBe("Google Business");
  });
});

describe("textLimitProblem", () => {
  it("says how long the post is and what the platform takes, before the platform is called", () => {
    expect(textLimitProblem("linkedin", "x".repeat(3214))).toBe("This post has 3,214 characters. LinkedIn allows up to 3,000. Shorten it and try again.");
  });
  it("a post that fits, exactly at the limit too, has no problem", () => {
    expect(textLimitProblem("linkedin", "x".repeat(3000))).toBeNull();
    expect(textLimitProblem("bluesky", "short")).toBeNull();
  });
  // The compose page counts what a person sees as one character (countGraphemes). Counting UTF-16 units refused a post the page
  // had accepted: 160 emoji are 160 on the page and 320 units, and "Bluesky allows up to 300" was said about a post of 160.
  it("counts an emoji as one character, like the compose page does", () => {
    expect(textLimitProblem("bluesky", "😀".repeat(160))).toBeNull();
    expect(textLimitProblem("bluesky", "😀".repeat(300))).toBeNull();
    expect(textLimitProblem("bluesky", "👨‍👩‍👧‍👦".repeat(60))).toBeNull(); // a family is 11 units and one character
  });
  it("still refuses a post that is long in characters, and says the number a person counts", () => {
    expect(textLimitProblem("bluesky", "😀".repeat(301))).toBe("This post has 301 characters. Bluesky allows up to 300. Shorten it and try again.");
    expect(textLimitProblem("bluesky", "a".repeat(250) + "😀".repeat(51))).toBe("This post has 301 characters. Bluesky allows up to 300. Shorten it and try again.");
  });
  it("a platform that cuts the text itself, or whose limit is not fixed, is never refused here", () => {
    for (const p of ["tiktok", "pinterest", "youtube", "lemmy", "mastodon", "twitter", "facebook", "telegram", "nostr", "tumblr"]) {
      expect(textLimitProblem(p, "x".repeat(100_000))).toBeNull();
    }
  });
});

describe("the limits agree with the compose page", () => {
  // The compose page warns at PLATFORM_LIMIT; the runner refuses at TEXT_LIMIT. If they drift, a post the page calls fine
  // is refused at publish time (or the other way round), which is exactly the surprise these messages exist to prevent.
  const source = fs.readFileSync(new URL("../../../web/src/components/PlatformPreview.tsx", import.meta.url), "utf8");
  const pageLimit = (platform: string) => {
    const m = new RegExp(String.raw`\b${platform}:\s*(\d+)`).exec(source.slice(source.indexOf("export const PLATFORM_LIMIT")));
    return m ? Number(m[1]) : null;
  };

  it.each(Object.entries(TEXT_LIMIT))("%s: the runner refuses above %i, the same as the page warns", (platform, limit) => {
    expect(pageLimit(platform)).toBe(limit);
  });
});
