import { describe, expect, it } from "vitest";
import { designImageProblems, designsOf, pruneDesigns } from "./designImage";
import { EMPTY_FORM, changedFields, createBody, formFromJob, type PostForm } from "./post-editor";

const A = { submissionId: "s1", mediaUrl: "/uploads/canvas-designs/s1/a.png", bytes: 2_000_000 };
const B = { submissionId: "s2", mediaUrl: "/uploads/canvas-designs/s2/b.png", bytes: 900_000 };
const stored = (content: Record<string, unknown>) => formFromJob({ scheduledFor: null, content: JSON.stringify(content), targets: [] } as never);

describe("designImageProblems: which channel cannot take an approved design (a PNG, never converted)", () => {
  it("Instagram is refused whatever the size, with the reason", () => {
    const p = designImageProblems([{ ...A, bytes: 10 }], ["instagram"]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/Instagram.*JPEG.*does not convert/);
  });

  it("Bluesky, Threads and LinkedIn only over their size, exactly at the boundary", () => {
    const at = (bytes: number) => [{ ...A, bytes }];
    expect(designImageProblems(at(976_562), ["bluesky"])).toEqual([]);
    expect(designImageProblems(at(976_563), ["bluesky"])).toHaveLength(1);
    expect(designImageProblems(at(8_000_001), ["threads"])).toHaveLength(1);
    expect(designImageProblems(at(5_000_000), ["linkedin"])).toEqual([]);
    expect(designImageProblems(at(5_000_001), ["linkedin"])[0]).toMatch(/LinkedIn accepts pictures up to 5\.00 MB/);
  });

  it("a channel with no rule is not judged; no designs or no channel means no problem; each channel once", () => {
    expect(designImageProblems([A], ["mastodon"])).toEqual([]);
    expect(designImageProblems([], ["instagram"])).toEqual([]);
    expect(designImageProblems([A], [])).toEqual([]);
    expect(designImageProblems([A], ["instagram", "instagram"])).toHaveLength(1);
  });

  it("appears and disappears with the channel selection (the same designs, other channels)", () => {
    expect(designImageProblems([A], ["linkedin", "instagram"])).toHaveLength(1);
    expect(designImageProblems([A], ["linkedin"])).toEqual([]);
  });
});

describe("designsOf / pruneDesigns", () => {
  it("keeps only well-formed entries; nothing else is trusted", () => {
    expect(designsOf([A, null, 5, { submissionId: 1, mediaUrl: "x" }, { submissionId: "s", mediaUrl: "u", bytes: "9" }])).toEqual([A, { submissionId: "s", mediaUrl: "u" }]);
    expect(designsOf("x")).toEqual([]);
    expect(designsOf(undefined)).toEqual([]);
  });

  it("a design never outlives its picture, and a picture is listed once", () => {
    expect(pruneDesigns([A, B], [B.mediaUrl])).toEqual([B]);
    expect(pruneDesigns([A, { ...A, submissionId: "s9" }], [A.mediaUrl])).toEqual([A]);
    expect(pruneDesigns([A], [])).toEqual([]);
  });
});

describe("the form carries the designs and sends them with the pictures", () => {
  it("is read from the stored post, pruned to the pictures it still has (a stale entry is dropped)", () => {
    const f = stored({ mediaUrls: [A.mediaUrl], canvasDesigns: [A, B] });
    expect(f.canvasDesigns).toEqual([A]);
    expect(stored({ mediaUrls: [] }).canvasDesigns).toEqual([]); // a post from before T7
    expect(stored({ canvasDesigns: [A] }).canvasDesigns).toEqual([]); // no pictures at all
  });

  it("createBody sends only the id and the picture of each design, never a size, and nothing when there are none", () => {
    const form: PostForm = { ...EMPTY_FORM, mediaUrls: [A.mediaUrl, "/uploads/x.png"], canvasDesigns: [A] };
    const content = (createBody(form, true) as { content: Record<string, unknown> }).content;
    expect(content.canvasDesigns).toEqual([{ submissionId: A.submissionId, mediaUrl: A.mediaUrl }]);
    expect("canvasDesigns" in (createBody({ ...EMPTY_FORM, mediaUrls: ["/uploads/x.png"] }, true) as { content: object }).content).toBe(false);
  });

  it("createBody does not send a design whose picture is not in the form", () => {
    const form: PostForm = { ...EMPTY_FORM, mediaUrls: [], canvasDesigns: [A] };
    expect("canvasDesigns" in (createBody(form, true) as { content: object }).content).toBe(false);
  });

  it("an unchanged post sends nothing, a size the server measured is not an edit", () => {
    const initial = stored({ mediaUrls: [A.mediaUrl], canvasDesigns: [A] });
    expect(changedFields(initial, { ...initial })).toEqual({});
    expect(changedFields(initial, { ...initial, canvasDesigns: [{ ...A, bytes: 1 }] })).toEqual({});
  });

  it("attaching sends the pictures AND the designs together", () => {
    const initial = stored({ mediaUrls: ["/uploads/x.png"] });
    const form = { ...initial, mediaUrls: ["/uploads/x.png", B.mediaUrl], canvasDesigns: [B] };
    expect(changedFields(initial, form)).toEqual({ mediaUrls: form.mediaUrls, canvasDesigns: [{ submissionId: B.submissionId, mediaUrl: B.mediaUrl }] });
  });

  it("removing the picture sends the pictures and an EMPTY design list (the server replaces its list with it)", () => {
    const initial = stored({ mediaUrls: [A.mediaUrl], canvasDesigns: [A] });
    expect(changedFields(initial, { ...initial, mediaUrls: [], canvasDesigns: [] })).toEqual({ mediaUrls: [], canvasDesigns: [] });
    // removing the picture while the design is still in the form cannot send a stale design: it is pruned to the pictures
    expect(changedFields(initial, { ...initial, mediaUrls: [] })).toEqual({ mediaUrls: [], canvasDesigns: [] });
  });

  it("removing one of two keeps the other", () => {
    const initial = stored({ mediaUrls: [A.mediaUrl, B.mediaUrl], canvasDesigns: [A, B] });
    const out = changedFields(initial, { ...initial, mediaUrls: [B.mediaUrl], canvasDesigns: [B] });
    expect(out).toEqual({ mediaUrls: [B.mediaUrl], canvasDesigns: [{ submissionId: B.submissionId, mediaUrl: B.mediaUrl }] });
  });
});
