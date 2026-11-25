import { describe, expect, it } from "vitest";
import { missingForReview } from "./submitReadiness";
import {
  EMPTY_FORM,
  actionsFor,
  changedFields,
  contentChanged,
  crumbLabel,
  createBody,
  deadlineParts,
  deadlineProblem,
  editBlock,
  editorMissing,
  formFromJob,
  formatLine,
  imageProblem,
  isVideoUrl,
  legacyNotes,
  pathOf,
  requestLine,
  saveBlock,
  scheduleBlock,
  submitBlock,
  wibWhen,
  withMainCaption,
  workflowSteps,
  type PostForm,
} from "./post-editor";
import type { DesignRequestView } from "./jobTypes";

const STORED = {
  title: "When Environmental Data Leads to Enforcement",
  text: "Most regional monitoring fails.",
  pillar: "Educational",
  category: "Geospatial Insight/Expertise",
  format: "carousel",
  mediaUrls: ["/uploads/a.png", "/uploads/b.png"],
  youtubeTags: ["geo"],
  sourceRow: 1,
};

const job = (patch: Record<string, unknown> = {}) => ({
  scheduledFor: "2026-03-07T01:00:00.000Z",
  content: JSON.stringify(STORED),
  targets: [{ accountId: "acc-li" }, { accountId: "acc-bs" }],
  ...patch,
}) as never;

const loaded = (): PostForm => formFromJob(job());

describe("formFromJob", () => {
  it("reads the form from the stored post: the date and time in WIB, the accounts of its targets, the stored pictures", () => {
    expect(loaded()).toMatchObject({
      title: STORED.title,
      category: "Geospatial Insight/Expertise",
      format: "carousel",
      date: "2026-03-07",
      time: "08:00",
      accountIds: ["acc-li", "acc-bs"],
      mediaUrls: ["/uploads/a.png", "/uploads/b.png"],
    });
  });

  it("a post with no date has no day and the default time; an unknown format is none", () => {
    const f = formFromJob(job({ scheduledFor: null, content: JSON.stringify({ format: "reel" }) }));
    expect(f).toMatchObject({ date: "", time: "09:00", format: "" });
  });

  it("broken content JSON is an empty form, not a crash", () => {
    expect(formFromJob(job({ content: "not json" }))).toMatchObject({ title: "", mediaUrls: [] });
  });
});

describe("changedFields: a save sends only what the person changed", () => {
  it("nothing changed sends nothing", () => {
    expect(changedFields(loaded(), loaded())).toEqual({});
  });

  it("only the title", () => {
    expect(changedFields(loaded(), { ...loaded(), title: "New title" })).toEqual({ title: "New title" });
  });

  it("never sends what the page does not edit: YouTube tags, the plan's notes and channels like Bluesky stay as stored", () => {
    const body = changedFields(loaded(), { ...loaded(), text: "Changed" });
    expect(Object.keys(body)).toEqual(["text"]);
    expect(body).not.toHaveProperty("accountIds");
    expect(body).not.toHaveProperty("mediaType");
    expect(body).not.toHaveProperty("youtubeTags");
  });

  it("pillar and category go as a pair, even when only one of them changed", () => {
    expect(changedFields(loaded(), { ...loaded(), category: "Blog Post" })).toEqual({ pillar: "Educational", category: "Blog Post" });
  });

  it("the date goes as an instant, only when the day or the time changed and a day is set", () => {
    expect(changedFields(loaded(), { ...loaded(), time: "09:30" })).toEqual({ scheduledFor: "2026-03-07T02:30:00.000Z" });
    expect(changedFields(loaded(), { ...loaded(), date: "2026-03-09" })).toEqual({ scheduledFor: "2026-03-09T01:00:00.000Z" });
    // the server cannot clear a date, so an emptied day is not sent
    expect(changedFields(loaded(), { ...loaded(), date: "" })).toEqual({});
  });

  it("the accounts are compared as a set: the same channels in another order are no change; an added one is sent whole", () => {
    expect(changedFields(loaded(), { ...loaded(), accountIds: ["acc-bs", "acc-li"] })).toEqual({});
    expect(changedFields(loaded(), { ...loaded(), accountIds: ["acc-li", "acc-bs", "acc-ig"] })).toEqual({ accountIds: ["acc-li", "acc-bs", "acc-ig"] });
  });

  it("a format is sent, and cleared as null", () => {
    expect(changedFields(loaded(), { ...loaded(), format: "single" })).toEqual({ format: "single" });
    expect(changedFields(loaded(), { ...loaded(), format: "" })).toEqual({ format: null });
  });

  it("pictures are sent in their order; a link is sent, and an emptied one is sent as empty to clear it", () => {
    expect(changedFields(loaded(), { ...loaded(), mediaUrls: ["/uploads/b.png", "/uploads/a.png"] })).toEqual({ mediaUrls: ["/uploads/b.png", "/uploads/a.png"] });
    expect(changedFields(loaded(), { ...loaded(), designFigmaUrl: "https://figma.com/design/x" })).toEqual({ designFigmaUrl: "https://figma.com/design/x" });
    const withLink = { ...loaded(), designFigmaUrl: "https://figma.com/design/x" };
    expect(changedFields(withLink, { ...withLink, designFigmaUrl: "" })).toEqual({ designFigmaUrl: "" });
  });
});

describe("contentChanged", () => {
  it("a date-only change is not a content change (the server does not send the post back out of review for it either)", () => {
    expect(contentChanged(loaded(), { ...loaded(), time: "10:00" })).toBe(false);
    expect(contentChanged(loaded(), { ...loaded(), text: "x" })).toBe(true);
  });
});

describe("createBody", () => {
  const form: PostForm = { ...EMPTY_FORM, text: "Caption", title: "T", category: "Blog Post", pillar: "Educational", format: "single", date: "2026-03-07", time: "08:00", accountIds: ["acc-li"] };

  it("a draft is sent as a draft with the date as an instant", () => {
    expect(createBody(form, true)).toMatchObject({
      draft: true,
      accountIds: ["acc-li"],
      scheduledFor: "2026-03-07T01:00:00.000Z",
      content: { text: "Caption", title: "T", category: "Blog Post", pillar: "Educational", format: "single", mediaUrls: [] },
    });
  });

  it("leaves out what is empty: no title, no day, no format, no link", () => {
    const body = createBody({ ...EMPTY_FORM, text: "x" }, true) as { content: Record<string, unknown> } & Record<string, unknown>;
    expect(body).not.toHaveProperty("scheduledFor");
    expect(body.content).not.toHaveProperty("title");
    expect(body.content).not.toHaveProperty("format");
    expect(body.content).not.toHaveProperty("designFigmaUrl");
    expect(body.content).not.toHaveProperty("pillar");
  });
});

describe("editorMissing is the server's rule on the post as the form has it", () => {
  const accounts = [{ id: "acc-li", platform: "linkedin" }, { id: "acc-bs", platform: "bluesky" }];
  const stored = { ...STORED };

  it("a complete post lacks nothing", () => {
    expect(editorMissing(stored, loaded(), accounts)).toEqual([]);
  });

  it("names what the form lacks, in the server's order, including the format", () => {
    const empty: PostForm = { ...EMPTY_FORM };
    expect(editorMissing({}, empty, accounts)).toEqual(["title", "date", "caption", "category", "format", "accounts", "media"]);
  });

  it("is the same answer the server gives for the same post", () => {
    const f: PostForm = { ...loaded(), format: "", mediaUrls: [] };
    const server = missingForReview({
      scheduledFor: new Date("2026-03-07T01:00:00.000Z"),
      content: JSON.stringify({ ...stored, format: "", mediaUrls: [], title: f.title, text: f.text, category: f.category }),
      targetPlatforms: ["linkedin", "bluesky"],
    });
    expect(editorMissing(stored, f, accounts)).toEqual(server);
  });
});

describe("editBlock", () => {
  const marketing = { canEditContent: true, canReview: false };
  const admin = { canEditContent: true, canReview: true };

  it("a draft can be edited by Marketing and by an admin", () => {
    expect(editBlock({ status: "draft" }, marketing)).toBeNull();
    expect(editBlock({ status: "draft" }, admin)).toBeNull();
  });

  it("an approved (scheduled) post is locked for Marketing, open for an admin", () => {
    expect(editBlock({ status: "pending" }, marketing)).toBe("Approved posts are locked. Ask an admin to change them.");
    expect(editBlock({ status: "pending" }, admin)).toBeNull();
  });

  it("a published, failed or running post is closed to everyone, and the design team cannot edit at all", () => {
    for (const status of ["done", "failed", "running"]) expect(editBlock({ status }, admin)).not.toBeNull();
    expect(editBlock({ status: "draft" }, { canEditContent: false, canReview: true })).toBe("Your role can't edit content.");
  });
});

describe("deadlineProblem (the API's rule, said first: instants, before the moment the post goes out)", () => {
  const now = new Date("2026-03-01T03:00:00.000Z");
  const publish = new Date("2026-03-07T02:00:00.000Z"); // 09:00 WIB
  const at = (iso: string) => new Date(iso);

  it("past or this very moment is refused; a moment after now is fine without a publishing time", () => {
    expect(deadlineProblem(at("2026-03-01T02:59:00.000Z"), now, null)).toBe("DEADLINE_PAST");
    expect(deadlineProblem(now, now, null)).toBe("DEADLINE_PAST");
    expect(deadlineProblem(at("2031-01-01T00:00:00.000Z"), now, null)).toBeNull();
  });

  it("the publishing day is fine until the publishing time: a minute before passes, the same minute and after are refused", () => {
    expect(deadlineProblem(at("2026-03-07T01:59:00.000Z"), now, publish)).toBeNull();
    expect(deadlineProblem(publish, now, publish)).toBe("DEADLINE_AFTER_PUBLISH");
    expect(deadlineProblem(at("2026-03-07T02:01:00.000Z"), now, publish)).toBe("DEADLINE_AFTER_PUBLISH");
    expect(deadlineProblem(at("2026-03-08T00:00:00.000Z"), now, publish)).toBe("DEADLINE_AFTER_PUBLISH");
  });
});

describe("a deadline as the person reads it (WIB)", () => {
  it("wibWhen: day and 24-hour time with the zone", () => {
    expect(wibWhen(new Date("2026-03-04T10:00:00.000Z"))).toBe("Wed, 4 Mar 2026, 17:00 WIB");
  });

  it("the day follows WIB, not UTC: 20:00 UTC is already the next day in Jakarta", () => {
    expect(wibWhen(new Date("2026-03-04T20:00:00.000Z"))).toBe("Thu, 5 Mar 2026, 03:00 WIB");
  });

  it("deadlineParts gives the date and the time the two inputs hold, and empty strings for no deadline", () => {
    expect(deadlineParts("2026-03-04T10:00:00.000Z")).toEqual({ date: "2026-03-04", time: "17:00" });
    expect(deadlineParts("2026-03-04T20:30:00.000Z")).toEqual({ date: "2026-03-05", time: "03:30" });
    expect(deadlineParts(null)).toEqual({ date: "", time: "" });
    expect(deadlineParts(undefined)).toEqual({ date: "", time: "" });
  });
});

describe("the design request on the page", () => {
  const request = (patch: Partial<DesignRequestView> = {}): DesignRequestView => ({
    id: "dr1", status: "sent", assignee: { id: "u1", name: "Rina Sari", avatarUrl: null, active: true },
    deadline: "2026-03-04T10:00:00.000Z", brief: "5 slides", referenceUrl: null, sentAt: "2026-03-01T01:00:00.000Z", updatedAt: "2026-03-01T01:00:00.000Z", doneAt: null, figmaUrl: null, designerNote: null, ...patch,
  });

  it("says who has it and by when, with the time; a deleted account is said so", () => {
    expect(requestLine(request())).toBe("Rina S. · due Wed, 4 Mar 2026, 17:00 WIB");
    expect(requestLine(request({ assignee: null }))).toBe("Designer removed · due Wed, 4 Mar 2026, 17:00 WIB");
  });

  it("a request with no deadline says so instead of a date", () => {
    expect(requestLine(request({ deadline: null }))).toBe("Rina S. · no deadline");
    expect(requestLine({ assignee: "Rina Sari", deadline: null })).toBe("Rina S. · no deadline");
  });

  it("the path is worked out: a request is B, else a template for the category is A, else none", () => {
    expect(pathOf(request(), true)).toBe("B");
    expect(pathOf(null, true)).toBe("A");
    expect(pathOf(undefined, false)).toBeNull();
  });

  it("Submit is blocked while the request is with the designer, naming them; a saved brief does not block", () => {
    const sent = submitBlock({ approvalStatus: null, contentChanged: false, request: request() });
    expect(sent).toContain("Waiting for the design from Rina S.");
    expect(submitBlock({ approvalStatus: null, contentChanged: false, request: request({ status: "draft" }) })).toBeNull();
    expect(submitBlock({ approvalStatus: null, contentChanged: false, request: null })).toBeNull();
  });

  it("Submit is blocked in review, and after a revision until the content changes", () => {
    expect(submitBlock({ approvalStatus: "pending", contentChanged: false, request: null })).toBe("This post is in review.");
    expect(submitBlock({ approvalStatus: "rejected", contentChanged: false, request: null })).toContain("Sent back for changes");
    expect(submitBlock({ approvalStatus: "rejected", contentChanged: true, request: null })).toBeNull();
  });
});

describe("saveBlock: a field the server would refuse is said before the save", () => {
  it("a design link that is not https, or has spaces, blocks the save; an empty one and a good one do not", () => {
    expect(saveBlock({ ...loaded(), designFigmaUrl: "" })).toBeNull();
    expect(saveBlock({ ...loaded(), designFigmaUrl: "https://www.figma.com/design/abc/x" })).toBeNull();
    expect(saveBlock({ ...loaded(), designFigmaUrl: "figma.com/design/abc" })).toContain("https://");
    expect(saveBlock({ ...loaded(), designFigmaUrl: "http://figma.com/x" })).toContain("Fix the design link first.");
    expect(saveBlock({ ...loaded(), designFigmaUrl: "https://figma.com/a b" })).toContain("too long or has spaces");
  });
});

describe("a post an API client made with no date holds the epoch", () => {
  it("is an empty date in the form, not 1 Jan 1970, so it is not a change and not a date", () => {
    const f = formFromJob(job({ scheduledFor: "1970-01-01T00:00:00.000Z" }));
    expect(f).toMatchObject({ date: "", time: "09:00" });
    expect(changedFields(f, f)).toEqual({});
  });
});

describe("scheduleBlock", () => {
  const ready: PostForm = { ...loaded(), date: "2030-03-07", time: "08:00" };
  const now = new Date("2026-11-23T03:00:00Z");

  it("a complete post can be scheduled", () => {
    expect(scheduleBlock(ready, null, now)).toBeNull();
  });

  it("says what is missing: the day, a channel, the caption", () => {
    expect(scheduleBlock({ ...ready, date: "" }, null, now)).toBe("Pick a publishing date to schedule.");
    expect(scheduleBlock({ ...ready, accountIds: [] }, null, now)).toBe("Pick a channel to schedule.");
    expect(scheduleBlock({ ...ready, text: "  " }, null, now)).toBe("Write the caption to schedule.");
  });

  it("a time that has passed is refused", () => {
    expect(scheduleBlock({ ...ready, date: "2026-11-01" }, null, now)).toBe("The publishing time has already passed.");
  });

  it("a request with the designer blocks it, naming them", () => {
    const sent = { status: "sent", assignee: { id: "u", name: "Rina Sari", avatarUrl: null, active: true } } as DesignRequestView;
    expect(scheduleBlock(ready, sent, now)).toContain("Waiting for the design from Rina S.");
  });
});

describe("actionsFor: the buttons of the bar", () => {
  const base = { isNew: false, status: "draft", approvalStatus: null as string | null, canReview: false, canSubmitOwn: false };

  it("Marketing under the review flow: Save as Draft and Submit for Review, new or existing", () => {
    const m = { ...base, canSubmitOwn: true };
    expect(actionsFor({ ...m, isNew: true })).toEqual({ secondary: "Save as Draft", primary: { kind: "submit", label: "Submit for Review" } });
    expect(actionsFor(m)).toEqual({ secondary: "Save as Draft", primary: { kind: "submit", label: "Submit for Review" } });
    expect(actionsFor({ ...m, approvalStatus: "pending" }).primary?.kind).toBe("submit");
  });

  it("an admin schedules a draft and saves a scheduled post", () => {
    expect(actionsFor({ ...base, canReview: true })).toEqual({ secondary: "Save as Draft", primary: { kind: "schedule", label: "Schedule Post" } });
    expect(actionsFor({ ...base, canReview: true, status: "pending" })).toEqual({ secondary: null, primary: { kind: "save", label: "Save changes" } });
  });

  it("an admin editing a post in review only saves: approving stays in the review dialog", () => {
    expect(actionsFor({ ...base, canReview: true, approvalStatus: "pending" })).toEqual({ secondary: null, primary: { kind: "save", label: "Save changes" } });
  });

  it("Marketing without the review flow can schedule a new post, but on an existing draft only saves (the server allows no more)", () => {
    expect(actionsFor({ ...base, isNew: true }).primary?.kind).toBe("schedule");
    expect(actionsFor(base)).toEqual({ secondary: "Save as Draft", primary: null });
  });
});

describe("the cards' texts", () => {
  it("the format line counts the slides of a carousel", () => {
    expect(formatLine("", 0)).toBeNull();
    expect(formatLine("single", 3)).toBe("Single image");
    expect(formatLine("carousel", 5)).toBe("Carousel · 5 slides");
    expect(formatLine("carousel", 1)).toBe("Carousel · 1 slide");
    expect(formatLine("carousel", 0)).toBe("Carousel");
  });

  it("the crumb is Row N for a post from a plan file, else the title, else Untitled", () => {
    expect(crumbLabel({ sourceRow: 1, title: "T" })).toBe("Row 1");
    expect(crumbLabel({ title: " My post " })).toBe("My post");
    expect(crumbLabel({})).toBe("Untitled");
  });

  it("the workflow marks where the post is: done before it, current on it, todo after it", () => {
    const steps = workflowSteps({ status: "draft", approvalStatus: "pending" }, true);
    expect(steps.map((s) => `${s.label}:${s.state}`)).toEqual(["Draft:done", "In Review:current", "Revision Required:todo", "Ready to Publish:todo", "Published:todo"]);
  });

  it("without the review flow there is no review step, and a failed post gets a last step", () => {
    expect(workflowSteps({ status: "draft", approvalStatus: null }, false).map((s) => s.label)).toEqual(["Draft", "Ready to Publish", "Published"]);
    const failed = workflowSteps({ status: "failed", approvalStatus: "approved" }, true);
    expect(failed.at(-1)).toMatchObject({ label: "Failed", state: "current" });
  });
});

describe("what the page does not show but keeps", () => {
  const accounts = [
    { id: "acc-li", platform: "linkedin", displayName: "L" },
    { id: "acc-bs", platform: "bluesky", displayName: "B" },
  ];

  it("names the channels outside LinkedIn and Instagram, a custom caption of a ticked channel, and a first comment", () => {
    const form: PostForm = { ...loaded(), perAccount: { "acc-li": { text: "Custom for LinkedIn" } } };
    expect(legacyNotes(form, accounts, "First!")).toEqual({ otherChannels: ["Bluesky"], customText: true, firstComment: true });
  });

  it("a custom caption of a channel that is not ticked does not count", () => {
    const form: PostForm = { ...loaded(), accountIds: ["acc-li"], perAccount: { "acc-bs": { text: "x" } } };
    expect(legacyNotes(form, accounts, null)).toEqual({ otherChannels: [], customText: false, firstComment: false });
  });

  it("Use the main caption drops the custom texts and keeps the first comments", () => {
    expect(withMainCaption({ a: { text: "custom" }, b: { text: "custom", commentText: "keep me" }, c: { commentText: "  " } })).toEqual({ b: { commentText: "keep me" } });
  });

  it("an old video is recognised by its file type", () => {
    expect(isVideoUrl("/uploads/x.mp4")).toBe(true);
    expect(isVideoUrl("https://cdn.example.com/a.MOV?x=1")).toBe(true);
    expect(isVideoUrl("/uploads/x.png")).toBe(false);
  });
});

describe("imageProblem: a wrong file never leaves the browser", () => {
  it("accepts PNG and JPG up to 10 MB, and names why it refuses the rest", () => {
    expect(imageProblem({ name: "a.png", type: "image/png", size: 2_000_000 })).toBeNull();
    expect(imageProblem({ name: "a.jpg", type: "image/jpeg", size: 10_000_000 })).toBeNull();
    expect(imageProblem({ name: "a.gif", type: "image/gif", size: 100 })).toBe("a.gif is not a PNG or JPG file.");
    expect(imageProblem({ name: "big.png", type: "image/png", size: 10_000_001 })).toBe("big.png is over 10 MB.");
  });
});
