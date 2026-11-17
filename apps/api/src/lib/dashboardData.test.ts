import { describe, expect, it } from "vitest";
import {
  addDays,
  dayWhere,
  designActivities,
  isDateKey,
  listWhere,
  mediaOf,
  monthOf,
  pillarOf,
  quarterCount,
  quarterOf,
  rangeWhere,
  readyToSchedule,
  tasksWhere,
  toPost,
  toQueuePost,
  wibKey,
  wibStart,
  type PostRecord,
  type QueueRecord,
} from "./dashboardData.js";

describe("the WIB day", () => {
  it("is the Jakarta day, not the UTC one: 17:00 UTC is already tomorrow in WIB", () => {
    expect(wibKey(new Date("2026-11-09T16:59:59Z"))).toBe("2026-11-09");
    expect(wibKey(new Date("2026-11-09T17:00:00Z"))).toBe("2026-11-10");
    expect(wibKey(new Date("2026-12-31T20:00:00Z"))).toBe("2027-01-01");
  });

  it("a day starts at 17:00 UTC the evening before", () => {
    expect(wibStart("2026-11-09").toISOString()).toBe("2026-11-08T17:00:00.000Z");
    expect(wibKey(wibStart("2026-11-09"))).toBe("2026-11-09");
  });

  it("adds days across a month and a year", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-11-09", -9)).toBe("2026-10-31");
  });

  it("knows a real day from a made-up one", () => {
    expect(isDateKey("2026-11-09")).toBe(true);
    expect(isDateKey("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-31", "2026-13-01", "2026-1-1", "09-11-2026", "", "2026-11-09T00:00", null, undefined, 20261109]) {
      expect(isDateKey(bad), String(bad)).toBe(false);
    }
  });

  it("refuses a year the calendar does not cover: 0000 is a real day to JavaScript but its WIB start is a negative year Postgres rejects (a 500)", () => {
    for (const bad of ["0000-01-01", "0001-06-15", "1999-12-31", "2101-01-01", "9999-12-31"]) {
      expect(isDateKey(bad), bad).toBe(false);
    }
    for (const ok of ["2000-01-01", "2026-11-09", "2100-12-31"]) expect(isDateKey(ok), ok).toBe(true);
  });
});

describe("quarters and months", () => {
  it("a quarter is three whole months, named like the dashboard names it", () => {
    expect(quarterOf("2026-11-09")).toEqual({ label: "Q4 2026", start: "2026-10-01", end: "2027-01-01" });
    expect(quarterOf("2026-01-01")).toEqual({ label: "Q1 2026", start: "2026-01-01", end: "2026-04-01" });
    expect(quarterOf("2026-03-31")).toEqual({ label: "Q1 2026", start: "2026-01-01", end: "2026-04-01" });
    expect(quarterOf("2026-04-01")).toEqual({ label: "Q2 2026", start: "2026-04-01", end: "2026-07-01" });
    expect(quarterOf("2026-09-30")).toEqual({ label: "Q3 2026", start: "2026-07-01", end: "2026-10-01" });
  });

  it("the end of a quarter is the first day AFTER it, so the last day belongs to it", () => {
    const q = quarterOf("2026-12-31");
    expect(q.label).toBe("Q4 2026");
    expect("2026-12-31" < q.end).toBe(true);
    expect(quarterOf(q.end).label).toBe("Q1 2027");
  });

  it("a month, including December", () => {
    expect(monthOf("2026-11-09")).toEqual({ start: "2026-11-01", end: "2026-12-01" });
    expect(monthOf("2026-12-31")).toEqual({ start: "2026-12-01", end: "2027-01-01" });
    expect(monthOf("2028-02-29")).toEqual({ start: "2028-02-01", end: "2028-03-01" });
  });
});

describe("what each list holds", () => {
  const base = { workspaceId: "ws" };
  const now = new Date("2026-11-09T05:00:00Z"); // 12:00 WIB on the 9th
  const clauses = (w: unknown) => JSON.stringify(w);

  it("every list starts from the workspace and what the role may see", () => {
    for (const kind of ["upcoming", "attention", "risk", "activity"] as const) {
      expect(listWhere(base, kind, now)).toMatchObject({ AND: [base, expect.anything()] });
    }
  });

  it("upcoming counts from the start of today in WIB, not from this minute: a post at 08:00 today is still upcoming at noon", () => {
    const json = clauses(listWhere(base, "upcoming", now));
    expect(json).toContain("2026-11-08T17:00:00.000Z");
    expect(json).toContain('"scheduledFor":null');
  });

  it("attention includes a scheduled post that is still pending 15 minutes after its time: it did not go out and nothing else lists it", () => {
    const where = listWhere(base, "attention", now) as { AND: [unknown, { OR: Array<Record<string, unknown>> }] };
    const overdue = where.AND[1].OR.find((c) => c.status === "pending");
    // 12:00 WIB is 05:00Z; 15 minutes before it is 04:45Z
    expect(overdue).toMatchObject({ status: "pending", scheduledFor: { lt: new Date("2026-11-09T04:45:00.000Z") } });
  });

  it("attention leaves out a draft that came from a plan file (an import saves past dates as archive drafts)", () => {
    const where = listWhere(base, "attention", now) as { AND: [unknown, { OR: Array<Record<string, unknown>> }] };
    const pastDraft = where.AND[1].OR.find((c) => c.status === "draft" && "scheduledFor" in c);
    expect(pastDraft).toMatchObject({ importKey: null, scheduledFor: { lt: now } });
    expect(clauses(where)).toContain('"approvalStatus":"rejected"');
    expect(clauses(where)).toContain("post_failed");
  });

  it("at risk is a draft due in the next three days that was not sent back", () => {
    const json = clauses(listWhere(base, "risk", now));
    expect(json).toContain('"status":"draft"');
    expect(json).toContain("2026-11-12T05:00:00.000Z");
    expect(json).toContain('"not":"rejected"');
  });

  it("recent activity is what changed in the last seven days", () => {
    expect(clauses(listWhere(base, "activity", now))).toContain("2026-11-02T05:00:00.000Z");
  });

  it("a day is [start, next start) in WIB, and a range includes its last day", () => {
    expect(clauses(dayWhere(base, "2026-11-09"))).toContain('"gte":"2026-11-08T17:00:00.000Z","lt":"2026-11-09T17:00:00.000Z"');
    expect(clauses(rangeWhere(base, "2026-10-26", "2026-12-06"))).toContain('"gte":"2026-10-25T17:00:00.000Z","lt":"2026-12-06T17:00:00.000Z"');
  });

  it("ready to schedule is a plain draft with a date still ahead and an account, so an archive draft is not counted", () => {
    const json = clauses(readyToSchedule(now));
    expect(json).toContain('"scheduledFor":{"gte":"2026-11-09T05:00:00.000Z"}');
    expect(json).toContain('"targets":{"some":{}}');
    expect(json).toContain('"notIn":["pending","rejected"]');
  });

  it("my tasks are the signed-in person's own posts of that day that are not done", () => {
    const json = clauses(tasksWhere(base, "user-1", "2026-11-09"));
    expect(json).toContain('"userId":"user-1"');
    expect(json).toContain('"draft"');
    expect(json).toContain('"running"');
    expect(json).not.toContain("done");
  });
});

describe("toPost", () => {
  const record = (patch: Partial<PostRecord> = {}): PostRecord => ({
    id: "p1",
    status: "pending",
    approvalStatus: null,
    scheduledFor: new Date("2026-11-18T02:00:00Z"),
    content: JSON.stringify({ title: "5 Habits", text: "A long caption", designCopy: "x".repeat(5000), mediaUrls: [] }),
    user: { name: "Putri" },
    targets: [{ account: { platform: "instagram" } }],
    ...patch,
  });

  it("keeps what a list needs and nothing of the content (a design copy can be long)", () => {
    const post = toPost(record());
    expect(post).toEqual({
      id: "p1",
      title: "5 Habits",
      status: "pending",
      approvalStatus: null,
      scheduledFor: "2026-11-18T02:00:00.000Z",
      channels: ["instagram"],
      owner: "Putri",
      category: null,
      thumbnail: null,
    });
    expect(JSON.stringify(post)).not.toContain("xxxx");
  });

  it("a title is cut to 200 characters: a plan cell can hold a paragraph", () => {
    expect(toPost(record({ content: JSON.stringify({ title: "t".repeat(900) }) })).title).toHaveLength(200);
  });

  it("the category is what the plan file named, trimmed, or null", () => {
    expect(toPost(record({ content: JSON.stringify({ title: "T", category: "  Industry insight " }) })).category).toBe("Industry insight");
    expect(toPost(record({ content: JSON.stringify({ title: "T", category: 7 }) })).category).toBeNull();
    expect(toPost(record({ content: JSON.stringify({ title: "T", category: "c".repeat(500) }) })).category).toHaveLength(60);
  });

  describe("thumbnail", () => {
    const thumb = (mediaUrls: unknown) => toPost(record({ content: JSON.stringify({ title: "T", mediaUrls }) })).thumbnail;

    it("is the first picture: one of our uploads or an http(s) address", () => {
      expect(thumb(["/uploads/a.png", "/uploads/b.png"])).toBe("/uploads/a.png");
      expect(thumb(["https://cdn.example/a.jpg"])).toBe("https://cdn.example/a.jpg");
    });

    it("skips a video and takes the next picture; a post with only a video has none", () => {
      expect(thumb(["/uploads/clip.MP4", "/uploads/b.png"])).toBe("/uploads/b.png");
      expect(thumb(["/uploads/clip.mov?x=1"])).toBeNull();
    });

    it("never hands the browser anything but an upload path or an http(s) URL", () => {
      expect(thumb(["javascript:alert(1)", "data:image/png;base64,AAAA", "//evil.example/a.png", "../secret.png"])).toBeNull();
      expect(thumb(["/uploads/" + "a".repeat(600)])).toBeNull();
    });

    it("takes an upload only in the shape storage gives it, so a '..' cannot aim the viewer's browser at another API path", () => {
      expect(thumb(["/uploads/9f1c-aa.png"])).toBe("/uploads/9f1c-aa.png");
      expect(thumb(["/uploads/avatars/9f1c-aa.jpg"])).toBe("/uploads/avatars/9f1c-aa.jpg");
      expect(thumb(["/uploads/../auth/threads"])).toBeNull();
      expect(thumb(["/uploads/%2e%2e/auth/threads.png"])).toBeNull();
      expect(thumb(["/uploads/a/b/c.png"])).toBeNull();
      expect(thumb(["/uploads/a.png?next=/auth/threads"])).toBeNull();
      // the next one is fine: the bad entry is skipped, not the whole post
      expect(thumb(["/uploads/../x.png", "/uploads/ok.png"])).toBe("/uploads/ok.png");
    });

    it("is null when there is no media, or it is not a list, or it holds something else", () => {
      expect(thumb([])).toBeNull();
      expect(thumb("/uploads/a.png")).toBeNull();
      expect(thumb([7, null, {}])).toBeNull();
      expect(toPost(record({ content: "{}" })).thumbnail).toBeNull();
    });
  });

  it("an untitled post is called by the start of its caption, cut to 80 characters", () => {
    expect(toPost(record({ content: JSON.stringify({ text: "  Hello world  " }) })).title).toBe("Hello world");
    expect(toPost(record({ content: JSON.stringify({ text: "y".repeat(200) }) })).title).toHaveLength(80);
  });

  it("a post with no title and no caption is Untitled, and broken content does not throw", () => {
    expect(toPost(record({ content: "{}" })).title).toBe("Untitled");
    expect(toPost(record({ content: "not json" })).title).toBe("Untitled");
    for (const odd of ["null", "7", "[1,2]", '"text"']) expect(toPost(record({ content: odd })).title, odd).toBe("Untitled");
  });

  it("the channels are the accounts it goes to, once each", () => {
    const two = toPost(record({ targets: [{ account: { platform: "instagram" } }, { account: { platform: "instagram" } }, { account: { platform: "linkedin" } }] }));
    expect(two.channels).toEqual(["instagram", "linkedin"]);
  });

  it("a draft from a plan file with no account yet shows the channels the file named", () => {
    const post = toPost(record({ status: "draft", targets: [], content: JSON.stringify({ title: "T", platforms: ["linkedin", "instagram", 7] }) }));
    expect(post.channels).toEqual(["linkedin", "instagram"]);
  });

  it("the owner is the person the plan file named, else who created it, else nobody", () => {
    expect(toPost(record({ content: JSON.stringify({ title: "T", picContent: " Rina S. " }) })).owner).toBe("Rina S.");
    expect(toPost(record({ user: null })).owner).toBeNull();
  });

  it("a post with no date keeps null", () => {
    expect(toPost(record({ scheduledFor: null })).scheduledFor).toBeNull();
  });
});

describe("quarterCount: the quarter, per content category", () => {
  type Row = { status: string; content: string };
  const row = (status: string, content: Record<string, unknown> | string = {}): Row => ({
    status,
    content: typeof content === "string" ? content : JSON.stringify(content),
  });
  const cat = (name: string, extra: Record<string, unknown> = {}) => ({ category: name, ...extra });
  /** The status counts the database would give for exactly these posts, plus posts the count never reads (no category). */
  const withStatuses = (rows: Row[], unread: Record<string, number> = {}) => {
    const by = new Map<string, number>();
    for (const r of rows) by.set(r.status, (by.get(r.status) ?? 0) + 1);
    for (const [status, n] of Object.entries(unread)) by.set(status, (by.get(status) ?? 0) + n);
    return [...by].map(([status, _count]) => ({ status, _count }));
  };
  const count = (rows: Row[], unread: Record<string, number> = {}) => quarterCount(withStatuses(rows, unread), rows);

  it("an empty quarter has nothing planned and no milestones", () => {
    expect(quarterCount([], [])).toEqual({ planned: 0, published: 0, milestones: [], uncategorized: 0 });
  });

  it("the totals come from the status counts, not from the posts that were read: nothing is cut or guessed", () => {
    const byStatus = [{ status: "draft", _count: 4 }, { status: "pending", _count: 3 }, { status: "done", _count: 5 }, { status: "post_done", _count: 1 }, { status: "failed", _count: 2 }];
    expect(quarterCount(byStatus, [])).toEqual({ planned: 15, published: 6, milestones: [], uncategorized: 15 });
  });

  it("thousands of posts that carry no category (automatic drip posts) are counted exactly and never have to be read", () => {
    const result = quarterCount([{ status: "pending", _count: 9000 }, { status: "done", _count: 40 }], [row("done", cat("Case Study"))]);
    expect(result).toMatchObject({ planned: 9040, published: 40, uncategorized: 9039 });
    expect(result.milestones).toEqual([{ category: "Case Study", planned: 1, posted: 1, scheduled: 0 }]);
  });

  it("groups by the canonical category: a plan cell with other case or spaces is the same category", () => {
    const { milestones } = count([row("draft", cat(" product features ")), row("draft", cat("Product Features")), row("draft", cat("AMA"))]);
    expect(milestones).toEqual([
      { category: "Product Features", planned: 2, posted: 0, scheduled: 0 },
      { category: "Ask Me Anything", planned: 1, posted: 0, scheduled: 0 },
    ]);
  });

  it("every status counts as planned, but only a post that went out is posted and only a waiting one is scheduled", () => {
    const rows = [
      row("done", cat("Case Study")), row("post_done", cat("Case Study")), row("comment_done", cat("Case Study")),
      row("pending", cat("Case Study")), row("running", cat("Case Study")),
      row("draft", cat("Case Study")), row("failed", cat("Case Study")), row("post_failed", cat("Case Study")),
    ];
    const result = count(rows);
    expect(result.milestones).toEqual([{ category: "Case Study", planned: 8, posted: 3, scheduled: 2 }]);
    expect(result).toMatchObject({ planned: 8, published: 3, uncategorized: 0 });
  });

  it("a draft whose plan row says Published was posted outside the app: it is posted in its bar and in the total, on top of the posts that went out", () => {
    const { milestones, published } = count([
      row("done", cat("Blog Post")),
      row("draft", cat("Blog Post", { sourceStatus: "Published" })),
      row("draft", cat("Blog Post", { sourceStatus: " published " })),
      row("draft", cat("Blog Post", { sourceStatus: "Draft" })),
    ]);
    expect(milestones).toEqual([{ category: "Blog Post", planned: 4, posted: 3, scheduled: 0 }]);
    expect(published).toBe(3);
  });

  it("the file's status does not rescue a post that failed or is waiting: only a draft was left unrecorded by the import", () => {
    const result = count([row("failed", cat("Blog Post", { sourceStatus: "Published" })), row("pending", cat("Blog Post", { sourceStatus: "Published" }))]);
    expect(result.milestones).toEqual([{ category: "Blog Post", planned: 2, posted: 0, scheduled: 1 }]);
    expect(result.published).toBe(0);
  });

  it("a Published plan row with no category is still in the published total, and in no bar", () => {
    const result = count([row("draft", { sourceStatus: "Published" })]);
    expect(result).toMatchObject({ planned: 1, published: 1, uncategorized: 1, milestones: [] });
  });

  it("a post with an unknown category, a non-text one or a broken content column is uncategorized, and never throws", () => {
    const result = count([row("draft", cat("Made Up")), row("draft", "{not json"), row("draft", "null"), row("draft", cat(7 as unknown as string)), row("done", cat("Made Up"))]);
    expect(result).toMatchObject({ planned: 5, published: 1, uncategorized: 5, milestones: [] });
  });

  it("the largest target comes first, ties in the order of the content types list", () => {
    const rows = [
      row("draft", cat("Internal Event")), row("draft", cat("Internal Event")),
      row("draft", cat("Blog Post")),
      row("draft", cat("Product Features")),
    ];
    expect(count(rows).milestones.map((m) => m.category)).toEqual(["Internal Event", "Product Features", "Blog Post"]);
  });
});

describe("the designer's review queue", () => {
  const record = (patch: Partial<QueueRecord> = {}, content: Record<string, unknown> = {}): QueueRecord => ({
    id: "p1",
    status: "draft",
    approvalStatus: "pending",
    scheduledFor: new Date("2026-11-17T02:00:00Z"),
    content: JSON.stringify({ title: "Backcasting 2026", mediaUrls: ["/uploads/a.png", "/uploads/b.png"], category: "Case Study", ...content }),
    submittedAt: new Date("2026-11-14T02:00:00Z"),
    submitCount: 2,
    submittedBy: { name: "Dewi K." },
    user: { name: "Putri A." },
    ...patch,
  });

  it("says who sent it and when, which round it is, and what it is made of, and sends no content", () => {
    const post = toQueuePost(record());
    expect(post).toEqual({
      id: "p1",
      status: "draft",
      approvalStatus: "pending",
      title: "Backcasting 2026",
      thumbnail: "/uploads/a.png",
      pillar: "Promotional",
      media: { images: 2, video: false, mediaType: null, youtubeType: null },
      submitCount: 2,
      submittedAt: "2026-11-14T02:00:00.000Z",
      submittedBy: "Dewi K.",
      scheduledFor: "2026-11-17T02:00:00.000Z",
    });
    expect(JSON.stringify(post)).not.toContain("content");
  });

  it("a post that was waiting before the send was recorded: the author, and no time", () => {
    const post = toQueuePost(record({ submittedBy: null, submittedAt: null }));
    expect(post.submittedBy).toBe("Putri A.");
    expect(post.submittedAt).toBeNull();
  });

  it("a post saved with no date (the epoch, by the MCP and the public API) has no date, not 1 January 1970", () => {
    expect(toQueuePost(record({ scheduledFor: new Date(0) })).scheduledFor).toBeNull();
    expect(toQueuePost(record({ scheduledFor: null })).scheduledFor).toBeNull();
  });

  it("no picture: no thumbnail", () => {
    expect(toQueuePost(record({}, { mediaUrls: [] })).thumbnail).toBeNull();
  });

  describe("pillarOf", () => {
    it("is the saved one, else the category's, else none", () => {
      expect(pillarOf({ pillar: "Educational", category: "Case Study" })).toBe("Educational");
      expect(pillarOf({ category: "Blog Post" })).toBe("Educational");
      expect(pillarOf({ category: "ama" })).toBeNull(); // Ask Me Anything is outside the four pillars
      expect(pillarOf({ category: "Not a category" })).toBeNull();
      expect(pillarOf({})).toBeNull();
    });
  });

  describe("mediaOf", () => {
    it("counts pictures, and leaves out a video and links the browser will not open", () => {
      expect(mediaOf({ mediaUrls: ["/uploads/a.png", "/uploads/b.jpg", "/uploads/c.mp4", "javascript:alert(1)", "/uploads/../x.png"] })).toMatchObject({ images: 2, video: true });
    });

    it("a post with no media at all, or a broken list", () => {
      expect(mediaOf({})).toEqual({ images: 0, video: false, mediaType: null, youtubeType: null });
      expect(mediaOf({ mediaUrls: "nope" })).toMatchObject({ images: 0, video: false });
    });

    it("a YouTube video the post points at is a video", () => {
      expect(mediaOf({ youtubeVideoUrl: "https://youtu.be/x", youtubeType: "short" })).toMatchObject({ video: true, youtubeType: "short" });
    });

    it("a Reel or a Story says so; the plain post type says nothing", () => {
      expect(mediaOf({ mediaType: "reel" }).mediaType).toBe("reel");
      expect(mediaOf({ mediaType: "story" }).mediaType).toBe("story");
      expect(mediaOf({ mediaType: "post" }).mediaType).toBeNull();
      expect(mediaOf({ mediaType: "carousel" }).mediaType).toBeNull();
    });
  });
});

describe("designActivities", () => {
  const since = new Date("2026-11-10T00:00:00Z");
  const at = (iso: string) => new Date(iso);
  const content = (title: string) => JSON.stringify({ title });
  const sources = () => ({
    submitted: [
      { content: content("When Environmental Data"), submittedAt: at("2026-11-17T02:12:00Z"), submittedById: "putri", submittedBy: { name: "Putri A." }, user: { name: "Putri A." } },
      { content: content("Satellite Imagery 101"), submittedAt: at("2026-11-11T07:22:00Z"), submittedById: "rina", submittedBy: { name: "Rina S." }, user: { name: "Rina S." } },
    ],
    reviewed: [
      { content: content("Behind the Scenes"), approvalStatus: "approved", reviewedAt: at("2026-11-17T01:55:00Z"), reviewedByUserId: "dewi", reviewedBy: { name: "Dewi K." } },
      { content: content("Backcasting"), approvalStatus: "rejected", reviewedAt: at("2026-11-16T09:40:00Z"), reviewedByUserId: "dewi", reviewedBy: { name: "Dewi K." } },
    ],
    templates: [{ name: "Insight Carousel v3", pillar: "Educational", createdAt: at("2026-11-16T07:10:00Z"), userId: "dewi", user: { name: "Dewi K." } }],
  });

  it("merges sends, answers and uploaded templates, newest first", () => {
    const events = designActivities("dewi", sources(), since, 10);
    expect(events.map((e) => [e.kind, e.title])).toEqual([
      ["submitted", "When Environmental Data"],
      ["approved", "Behind the Scenes"],
      ["revision", "Backcasting"],
      ["template", "Insight Carousel v3"],
      ["submitted", "Satellite Imagery 101"],
    ]);
  });

  it("marks what the viewer did, and not what someone else did", () => {
    const events = designActivities("dewi", sources(), since, 10);
    expect(events.map((e) => e.mine)).toEqual([false, true, true, true, false]);
  });

  it("keeps only the newest few", () => {
    expect(designActivities("dewi", sources(), since, 2).map((e) => e.title)).toEqual(["When Environmental Data", "Behind the Scenes"]);
  });

  it("leaves out an event older than the window", () => {
    const old = new Date("2026-11-17T00:00:00Z");
    expect(designActivities("dewi", sources(), old, 10)).toHaveLength(2);
  });

  it("a template carries its pillar; a post does not", () => {
    const events = designActivities("dewi", sources(), since, 10);
    expect(events.find((e) => e.kind === "template")?.pillar).toBe("Educational");
    expect(events.find((e) => e.kind === "approved")?.pillar).toBeNull();
  });

  it("a review that is neither an approval nor a revision, or has no time, is not an event", () => {
    const src = sources();
    src.reviewed = [
      { content: content("X"), approvalStatus: "pending", reviewedAt: at("2026-11-17T01:00:00Z"), reviewedByUserId: "dewi", reviewedBy: null },
      { content: content("Y"), approvalStatus: "approved", reviewedAt: null as unknown as Date, reviewedByUserId: "dewi", reviewedBy: null },
    ];
    src.submitted = [];
    src.templates = [];
    expect(designActivities("dewi", src, since, 10)).toEqual([]);
  });

  it("a person who was removed has no name, and the event still shows", () => {
    const src = sources();
    src.reviewed[0].reviewedBy = null;
    const approved = designActivities("dewi", src, since, 10).find((e) => e.kind === "approved");
    expect(approved?.by).toBeNull();
  });

  it("sends nothing but the event: no content, no sort key", () => {
    const [first] = designActivities("dewi", sources(), since, 1);
    expect(Object.keys(first).sort()).toEqual(["at", "by", "kind", "mine", "pillar", "title"]);
  });
});
