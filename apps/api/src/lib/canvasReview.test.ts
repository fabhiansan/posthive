// Design review (phase 6), the pure part: the request bodies, composing a snapshot on the server and checking the result,
// what counts as a change, the review summary and the field diff. A test is the one place the API may reach into apps/canvas
// (the Docker build copies only apps/api): the composition is compared with the ENGINE's applyOverrides, so the snapshot a
// designer reviews is exactly what Marketing's editor drew.
import { describe, expect, it } from "vitest";
import { applyOverrides, createDocument, createImage, createShape, createText, type CanvasDocument, type CanvasNode, type OverrideEntry as EngineEntry } from "../../../canvas/src/document";
import { RevisionUnreadable, buildManifest, canvasDocument, validateOverrides, type OverrideEntry } from "./canvas.js";
import { ComposeFailed, REVIEW_LIMITS, changedFields, changedSince, composeDocument, decisionBody, reviewSummary, submitBody, type SubmissionFacts } from "./canvasReview.js";

// ── A real revision: the same fixture the override tests use (every layer made by the engine's own factories) ──
function campaign(): CanvasDocument {
  const empty = createDocument();
  const text = (id: string, t: string, permission: "protected" | "text"): CanvasNode => ({ ...createText(empty), id, text: t, permission }) as CanvasNode;
  const image = (id: string, assetId: string, permission: "protected" | "image"): CanvasNode => ({ ...createImage(empty, { id: assetId, width: 10, height: 10 }), id, assetId, permission }) as CanvasNode;
  return {
    ...empty,
    nodes: [text("head", "Original headline", "text"), image("photo", "asset-1", "image"), text("legal", "Fixed legal text", "protected"), { ...createShape(empty, "rect"), id: "box" }, image("logo", "asset-logo", "protected"), text("sub", "Original subline", "text")],
  };
}
const revisionOf = (doc: CanvasDocument) => ({ document: JSON.parse(JSON.stringify(doc)) as unknown, manifest: buildManifest(canvasDocument.parse(doc)).manifest as unknown });
const txt = (nodeId: string, text: string): OverrideEntry => ({ nodeId, text });
const img = (nodeId: string, assetId: string): OverrideEntry => ({ nodeId, assetId });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const norm = (entries: OverrideEntry[], rev = revisionOf(campaign())) => {
  const r = validateOverrides(rev, entries);
  if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
  return r.fields;
};
type Layer = Record<string, unknown>;
const layer = (doc: unknown, id: string) => ((doc as { nodes: Layer[] }).nodes.find((n) => n.id === id)) as Layer;

describe("the request bodies", () => {
  it("a submit names the version and an optional note, and nothing else", () => {
    expect(submitBody.safeParse({ version: 3 }).success).toBe(true);
    expect(submitBody.safeParse({ version: 3, note: "For the launch" }).success).toBe(true);
    for (const bad of [{}, { version: 0 }, { version: 1.5 }, { version: "1" }, { version: 3, document: {} }, { version: 3, overrides: [] }, { version: 3, workspaceId: "w" }, { version: 3, note: 5 }, { version: 2_000_000_001 }]) {
      expect(submitBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("a note is trimmed, an empty one means no note, and the limit is 500 characters after trimming", () => {
    const note = (n: string) => {
      const r = submitBody.safeParse({ version: 1, note: n });
      return r.success ? r.data.note : "REFUSED";
    };
    expect(note("  hello  ")).toBe("hello");
    expect(note("   ")).toBe(""); // the route stores null for it
    expect(note("a".repeat(REVIEW_LIMITS.note))).toBe("a".repeat(500));
    expect(note(`  ${"a".repeat(500)}  `)).toBe("a".repeat(500));
    expect(note("a".repeat(501))).toBe("REFUSED");
    expect(REVIEW_LIMITS).toEqual({ note: 500, comment: 2000 });
  });

  it("a note keeps line breaks and tabs, and refuses other control characters, NUL and an unpaired surrogate", () => {
    const ok = (n: string) => submitBody.safeParse({ version: 1, note: n }).success;
    expect(ok("line one\nline two\ttab")).toBe(true);
    for (const bad of ["a\u0000b", "a\u0007b", "a\u001bb", "a\u009fb", "a\uD800b", "a\uDC00b"]) expect(ok(bad), JSON.stringify(bad)).toBe(false);
    expect(ok("emoji 😀 and 日本語")).toBe(true);
  });

  it("a decision is approve, or request_changes WITH a comment; the comment is at most 2000 characters", () => {
    expect(decisionBody.safeParse({ decision: "approve" }).success).toBe(true);
    expect(decisionBody.safeParse({ decision: "approve", comment: "Looks good" }).success).toBe(true);
    expect(decisionBody.safeParse({ decision: "request_changes", comment: "Fix the headline" }).success).toBe(true);
    for (const bad of [{ decision: "request_changes" }, { decision: "request_changes", comment: "   " }, { decision: "maybe" }, { decision: "approve", comment: "a".repeat(2001) }, { decision: "approve", extra: 1 }, {}, { decision: "approve", status: "approved" }]) {
      expect(decisionBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(decisionBody.safeParse({ decision: "request_changes", comment: "a".repeat(2000) }).success).toBe(true);
  });
});

describe("composeDocument: the snapshot is the pinned revision plus the permitted overrides, made on the server", () => {
  const doc = campaign();
  const rev = revisionOf(doc);
  const manifest = buildManifest(canvasDocument.parse(doc)).manifest;

  it("with no overrides it is the revision's document, equal and not the same object", () => {
    const out = composeDocument(rev, []);
    expect(out).toEqual(rev.document);
    expect(out).not.toBe(rev.document);
  });

  it("sets the text of a text layer and the asset of an image layer, and nothing else changes", () => {
    const out = composeDocument(rev, norm([txt("head", "New headline"), img("photo", "asset-2")]));
    expect(layer(out, "head").text).toBe("New headline");
    expect(layer(out, "photo").assetId).toBe("asset-2");
    for (const id of ["legal", "box", "logo", "sub"]) expect(layer(out, id), id).toEqual(layer(rev.document, id));
    // the layers it changed differ only in that one property
    expect({ ...layer(out, "head"), text: "x" }).toEqual({ ...layer(rev.document, "head"), text: "x" });
    expect({ ...layer(out, "photo"), assetId: "x" }).toEqual({ ...layer(rev.document, "photo"), assetId: "x" });
    expect((out.nodes as Layer[]).map((n) => n.id)).toEqual((rev.document as { nodes: Layer[] }).nodes.map((n) => n.id)); // order kept
  });

  it("never changes the revision it was made from", () => {
    const before = JSON.stringify(rev);
    composeDocument(rev, norm([txt("head", "Changed")]));
    expect(JSON.stringify(rev)).toBe(before);
  });

  it("is the SAME document the engine draws: parity with applyOverrides over many sets", () => {
    const sets: OverrideEntry[][] = [
      [],
      [txt("head", "A")],
      [img("photo", "asset-2")],
      [txt("head", "A"), img("photo", "asset-2"), txt("sub", "B")],
      [txt("head", "Original headline")], // equal to the base: normalized away
      [txt("head", "")],
      [txt("head", "  spaces\n\nand breaks  "), txt("sub", "日本語 😀")],
    ];
    for (const set of sets) {
      const stored = norm(set);
      expect(composeDocument(rev, stored), JSON.stringify(set)).toEqual(applyOverrides(doc, manifest, stored as EngineEntry[]));
    }
  });

  it("is deterministic and idempotent for the same stored set", () => {
    const stored = norm([txt("head", "A"), img("photo", "asset-2")]);
    expect(composeDocument(rev, stored)).toEqual(composeDocument(rev, stored));
  });

  it("an entry for a layer that is not editable is not applied, and the post-condition refuses it (fails closed, not silently)", () => {
    // validateOverrides never lets these through; if damage did, the snapshot must not be written.
    for (const bad of [txt("legal", "x"), img("logo", "asset-9"), txt("box", "x"), txt("nope", "x"), img("head", "asset-9"), txt("photo", "x")]) {
      expect(() => composeDocument(rev, [bad]), JSON.stringify(bad)).toThrow(ComposeFailed);
    }
  });

  it("two entries for one layer, or an entry applied twice, are refused", () => {
    expect(() => composeDocument(rev, [txt("head", "A"), txt("head", "B")])).toThrow(ComposeFailed);
  });

  it("an entry equal to the base value is a harmless no-op (the stored set is normalized and drops it, but if one were there the result is still the base)", () => {
    // Not damage: nothing is written that differs from the revision, so there is nothing to refuse.
    expect(composeDocument(rev, [txt("head", "Original headline")])).toEqual(rev.document);
  });

  it("__proto__ and other inherited names find nothing", () => {
    expect(() => composeDocument(rev, [txt("__proto__", "x")])).toThrow(ComposeFailed);
    expect(() => composeDocument(rev, [txt("constructor", "x")])).toThrow(ComposeFailed);
  });

  it("a revision that is not what publishing wrote throws RevisionUnreadable, whatever the overrides", () => {
    expect(() => composeDocument({ document: rev.document, manifest: { schemaVersion: 7, fields: [] } }, [])).toThrow(RevisionUnreadable);
    expect(() => composeDocument({ document: rev.document, manifest: "x" }, [])).toThrow(RevisionUnreadable);
    expect(() => composeDocument({ document: null, manifest: rev.manifest }, [])).toThrow(RevisionUnreadable);
    expect(() => composeDocument({ document: { nodes: "x" }, manifest: rev.manifest }, [])).toThrow(RevisionUnreadable);
    expect(() => composeDocument({ document: { nodes: [1] }, manifest: rev.manifest }, [])).toThrow(RevisionUnreadable);
  });

  it("does not re-parse with the document schema: a revision that a later, stricter schema would refuse still composes", () => {
    const odd = clone(rev);
    (odd.document as { nodes: Layer[] }).nodes[0].somethingNew = { from: "a later schema" }; // canvasDocument is strict and would refuse this key
    expect(canvasDocument.safeParse(odd.document).success).toBe(false);
    const out = composeDocument(odd, norm([txt("head", "A")]));
    expect(layer(out, "head").somethingNew).toEqual({ from: "a later schema" }); // carried through untouched
    expect(layer(out, "head").text).toBe("A");
  });

  it("keeps the document's own fields (size, background) exactly", () => {
    const out = composeDocument(rev, norm([txt("head", "A")]));
    for (const k of Object.keys(rev.document as object).filter((k) => k !== "nodes")) expect(out[k], k).toEqual((rev.document as Record<string, unknown>)[k]);
  });
});

describe("the post-condition: it is a CHECK of the result, not a repeat of the composing", () => {
  // composeDocument is run for real; to prove the check catches a wrong result, the check's own rules are exercised with the
  // same shapes by composing against a revision whose manifest lists a layer of the wrong kind (a manifest/document mismatch).
  const doc = campaign();

  it("a manifest that lists a text layer as an image makes the override unapplied, which is refused", () => {
    const rev = revisionOf(doc);
    (rev.manifest as { fields: Array<{ nodeId: string; kind: string }> }).fields = [{ nodeId: "head", kind: "image" }];
    expect(() => composeDocument(rev, [txt("head", "A")])).toThrow(ComposeFailed);
  });

  it("a manifest that no longer lists the layer makes the override unapplied, which is refused", () => {
    const rev = revisionOf(doc);
    (rev.manifest as { fields: unknown[] }).fields = [];
    expect(() => composeDocument(rev, [txt("head", "A")])).toThrow(ComposeFailed);
  });

  it("a layer whose type differs from the manifest's kind is not overridden, and the override is refused", () => {
    const rev = revisionOf(doc);
    (rev.manifest as { fields: Array<{ nodeId: string; kind: string }> }).fields.push({ nodeId: "box", kind: "text" }); // box is a rect
    expect(() => composeDocument(rev, [txt("box", "x")])).toThrow(ComposeFailed);
  });
});

describe("what counts as a change (changedSince)", () => {
  const stored = (entries: OverrideEntry[]) => ({ schemaVersion: 1, fields: entries });
  const latest = (over: Partial<{ instanceVersion: number; name: string; overrides: unknown }> = {}) => ({ instanceVersion: 2, name: "Case Study", overrides: stored([txt("head", "A")]), ...over });
  const now = (over: Partial<{ version: number; name: string; overrides: OverrideEntry[] }> = {}) => ({ version: 2, name: "Case Study", overrides: [txt("head", "A")] as readonly OverrideEntry[], ...over });

  it("nothing submitted yet is always a change, even for empty overrides (the first submission is allowed)", () => {
    expect(changedSince(null, now({ overrides: [] }))).toBe(true);
    expect(changedSince(null, now({ version: 1, overrides: [] }))).toBe(true);
  });

  it("the same version is no change, without looking at the content", () => {
    expect(changedSince(latest(), now())).toBe(false);
    expect(changedSince(latest({ overrides: "damaged" }), now())).toBe(false); // an exact answer from the version alone
  });

  it("a different version with different overrides is a change", () => {
    expect(changedSince(latest(), now({ version: 3, overrides: [txt("head", "B")] }))).toBe(true);
    expect(changedSince(latest(), now({ version: 3, overrides: [txt("head", "A"), txt("sub", "S")] }))).toBe(true);
    expect(changedSince(latest(), now({ version: 3, overrides: [] }))).toBe(true);
  });

  it("a different version with a different NAME is a change (the name is part of what a reviewer sees)", () => {
    expect(changedSince(latest(), now({ version: 3, name: "Renamed" }))).toBe(true);
  });

  it("A, then B, then A again: a different version with the SAME content as the latest submission is NOT a change", () => {
    // submission 1 was A (v2); the person edits to B (v3) and back to A (v4): nothing new to review.
    expect(changedSince(latest(), now({ version: 4 }))).toBe(false);
  });

  it("A, B, A resubmission: after B was submitted (v3), going back to A (v4) IS a change from the latest submission", () => {
    const afterB = latest({ instanceVersion: 3, overrides: stored([txt("head", "B")]) });
    expect(changedSince(afterB, now({ version: 4, overrides: [txt("head", "A")] }))).toBe(true);
  });

  it("the key order of the stored set does not matter (it is normalized), and the instance's own order is the manifest's", () => {
    const two = [txt("head", "A"), txt("sub", "B")];
    expect(changedSince(latest({ overrides: stored(two) }), now({ version: 9, overrides: two }))).toBe(false);
  });

  it("a stored snapshot that cannot be read proves nothing: it counts as a change, so the person can submit again", () => {
    for (const bad of [null, "x", { schemaVersion: 9, fields: [] }, { schemaVersion: 1 }, { schemaVersion: 1, fields: [{ nodeId: "a" }] }]) {
      expect(changedSince(latest({ overrides: bad }), now({ version: 9 })), JSON.stringify(bad)).toBe(true);
    }
  });

  it("the note is not an input: it cannot make a change, so an explanation alone does not unlock a resubmission", () => {
    expect(changedSince.length).toBe(2); // (latest, now): there is no third parameter for a note
  });
});

describe("reviewSummary: two independent facts", () => {
  const facts = (over: Partial<SubmissionFacts> & { status?: string | null } = {}): SubmissionFacts => {
    const { status = "pending", ...rest } = over;
    return {
      id: "s1",
      number: 1,
      instanceVersion: 2,
      name: "Case Study",
      overrides: { schemaVersion: 1, fields: [txt("head", "A")] },
      createdAt: new Date("2026-01-05T00:00:00.000Z"),
      review: status === null ? null : { id: "r1", status, comment: status === "changes_requested" ? "Shorter, please" : null, decidedAt: status === "pending" || status === "superseded" ? null : new Date("2026-01-06T00:00:00.000Z") },
      ...rest,
    };
  };
  const same = { version: 2, name: "Case Study", overrides: [txt("head", "A")] as OverrideEntry[] };
  const edited = { version: 3, name: "Case Study", overrides: [txt("head", "B")] as OverrideEntry[] };

  it("nothing submitted: null and false", () => {
    expect(reviewSummary(null, same)).toMatchObject({ latestReviewStatus: null, hasChangesSinceSubmitted: false, submissionNumber: null, submittedVersion: null, workingVersion: 2, latestReviewId: null });
  });

  it.each([["pending"], ["approved"], ["changes_requested"]])("%s + unchanged: the status, and no changes", (status) => {
    const s = reviewSummary(facts({ status }), same);
    expect(s).toMatchObject({ latestReviewStatus: status, hasChangesSinceSubmitted: false, submittedVersion: 2, workingVersion: 2, submissionNumber: 1, latestReviewId: "r1" });
  });

  it.each([["pending"], ["approved"], ["changes_requested"]])("%s + edited: the status is UNCHANGED and the changes flag is set", (status) => {
    const s = reviewSummary(facts({ status }), edited);
    expect(s.latestReviewStatus).toBe(status); // a newer working version never hides or alters it
    expect(s.hasChangesSinceSubmitted).toBe(true);
    expect(s.workingVersion).toBe(3);
  });

  it("edit then revert returns to no changes (by content, with a newer version)", () => {
    const s = reviewSummary(facts({ status: "approved" }), { version: 4, name: "Case Study", overrides: [txt("head", "A")] });
    expect(s).toMatchObject({ latestReviewStatus: "approved", hasChangesSinceSubmitted: false });
  });

  it("carries the reviewer's comment and the dates as ISO strings, and never a user id or a name", () => {
    const s = reviewSummary(facts({ status: "changes_requested" }), same);
    expect(s.comment).toBe("Shorter, please");
    expect(s.submittedAt).toBe("2026-01-05T00:00:00.000Z");
    expect(s.decidedAt).toBe("2026-01-06T00:00:00.000Z");
    expect(Object.keys(s).sort()).toEqual(["comment", "decidedAt", "hasChangesSinceSubmitted", "latestReviewId", "latestReviewStatus", "submissionNumber", "submittedAt", "submittedVersion", "workingVersion"]);
  });

  it("a submission with no review row, or an unknown status, reads as no status (never invented)", () => {
    expect(reviewSummary(facts({ status: null }), same).latestReviewStatus).toBeNull();
    expect(reviewSummary(facts({ status: "weird" }), same).latestReviewStatus).toBeNull();
  });

  it("superseded stays in the type for history lists", () => {
    expect(reviewSummary(facts({ status: "superseded" }), same).latestReviewStatus).toBe("superseded");
  });
});

describe("changedFields: what a designer sees changed", () => {
  const doc = campaign();
  const before = revisionOf(doc).document;
  const after = (set: OverrideEntry[]) => composeDocument(revisionOf(doc), norm(set));

  it("is empty when nothing changed", () => {
    expect(changedFields(before, after([]))).toEqual([]);
  });

  it("lists each changed text and image with its layer name, before and after, in the document's order", () => {
    const out = changedFields(before, after([txt("sub", "New sub"), img("photo", "asset-2"), txt("head", "New head")]));
    expect(out.map((c) => [c.nodeId, c.kind, c.before, c.after])).toEqual([
      ["head", "text", "Original headline", "New head"],
      ["photo", "image", "asset-1", "asset-2"],
      ["sub", "text", "Original subline", "New sub"],
    ]);
    expect(out[0].name).toBe((layer(before, "head").name as string));
  });

  it("compares two submissions: only the difference between them", () => {
    const first = after([txt("head", "One"), txt("sub", "Same")]);
    const second = after([txt("head", "Two"), txt("sub", "Same")]);
    expect(changedFields(first, second).map((c) => [c.nodeId, c.before, c.after])).toEqual([["head", "One", "Two"]]);
  });

  it("ignores layers that exist on one side only, and documents that are not documents", () => {
    const fewer = { ...(before as object), nodes: (before as { nodes: unknown[] }).nodes.slice(0, 1) };
    expect(changedFields(fewer, after([txt("sub", "x")]))).toEqual([]);
    for (const junk of [null, undefined, "x", 5, {}, { nodes: "x" }, { nodes: [null, 1] }]) expect(changedFields(junk, junk)).toEqual([]);
  });
});
