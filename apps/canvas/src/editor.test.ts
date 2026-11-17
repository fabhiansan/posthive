// The editor's pure logic: undo/redo history and document operations. Nothing here needs Konva or a DOM.
import { describe, expect, it } from "vitest";
import {
  addNode,
  coverCrop,
  createDocument,
  createImage,
  createShape,
  createText,
  foldScale,
  MAX_NODES,
  moveNode,
  nodeById,
  removeNode,
  updateNode,
  type CanvasDocument,
} from "./document";
import { canUndo, canRedo, commit, createHistory, MAX_HISTORY, redo, seal, undo } from "./history";

const ids = (doc: CanvasDocument) => doc.nodes.map((n) => n.id);

function docWith(n: number): CanvasDocument {
  let doc = createDocument();
  for (let i = 0; i < n; i++) doc = addNode(doc, { ...createShape(doc, "rect"), id: `n${i}` });
  return doc;
}

describe("history", () => {
  it("undoes and redoes one entry per commit", () => {
    let h = createHistory(0);
    h = commit(h, 1);
    h = commit(h, 2);
    expect(h.present).toBe(2);
    h = undo(h);
    expect(h.present).toBe(1);
    h = undo(h);
    expect(h.present).toBe(0);
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h); // nothing more to undo
    h = redo(h);
    h = redo(h);
    expect(h.present).toBe(2);
    expect(canRedo(h)).toBe(false);
    expect(redo(h)).toBe(h);
  });

  it("a new edit clears redo", () => {
    let h = commit(commit(createHistory(0), 1), 2);
    h = undo(h);
    expect(canRedo(h)).toBe(true);
    h = commit(h, 9);
    expect(canRedo(h)).toBe(false);
    expect(h.future).toEqual([]);
  });

  it("ignores a commit that changes nothing", () => {
    const h = createHistory({ a: 1 });
    expect(commit(h, h.present)).toBe(h);
  });

  it("merges edits that share a key into one undo step", () => {
    let h = createHistory("");
    h = commit(h, "h", "text:1");
    h = commit(h, "he", "text:1");
    h = commit(h, "hel", "text:1");
    expect(h.past).toEqual([""]);
    expect(undo(h).present).toBe("");
  });

  it("starts a new step when the key changes, is missing, or was sealed", () => {
    let h = commit(createHistory(0), 1, "a");
    h = commit(h, 2, "b");
    expect(h.past).toEqual([0, 1]);
    h = commit(h, 3); // no key
    h = commit(h, 4); // no key: never merges
    expect(h.past).toEqual([0, 1, 2, 3]);

    let s = commit(createHistory(0), 1, "a");
    s = seal(s);
    s = commit(s, 2, "a");
    expect(s.past).toEqual([0, 1]);
  });

  it("a merged edit still clears redo, and undo ends the merge", () => {
    let h = commit(commit(createHistory(0), 1, "k"), 2, "k");
    h = undo(h);
    expect(h.lastKey).toBeNull();
    h = commit(h, 5, "k");
    expect(h.past).toEqual([0]);
    expect(h.future).toEqual([]);
  });

  it(`keeps at most ${MAX_HISTORY} steps, dropping the oldest`, () => {
    let h = createHistory(0);
    for (let i = 1; i <= MAX_HISTORY + 20; i++) h = commit(h, i);
    expect(h.past).toHaveLength(MAX_HISTORY);
    expect(h.past[0]).toBe(20);
    expect(h.present).toBe(MAX_HISTORY + 20);
  });
});

describe("document operations", () => {
  it("never mutate the document they are given", () => {
    const doc = docWith(3);
    const frozen = JSON.stringify(doc);
    updateNode(doc, "n0", { x: 5 });
    moveNode(doc, "n0", "top");
    removeNode(doc, "n1");
    addNode(doc, createText(doc));
    expect(JSON.stringify(doc)).toBe(frozen);
  });

  it("adds new layers on top, centered, with numbered names", () => {
    let doc = createDocument();
    const a = createShape(doc, "rect");
    doc = addNode(doc, a);
    const b = createShape(doc, "rect");
    doc = addNode(doc, b);
    expect(ids(doc)).toEqual([a.id, b.id]);
    expect([a.name, b.name]).toEqual(["Rectangle 1", "Rectangle 2"]);
    expect(a.x + a.width / 2).toBeCloseTo(doc.width / 2, 1);
    expect(a.y + a.height / 2).toBeCloseTo(doc.height / 2, 1);
    expect(a.permission).toBe("protected");
  });

  it(`stops at ${MAX_NODES} layers`, () => {
    const full = docWith(MAX_NODES);
    expect(addNode(full, createShape(full, "ellipse"))).toBe(full);
  });

  it("sizes an imported image to fit inside the artboard, keeping its proportions", () => {
    const doc = createDocument();
    const wide = createImage(doc, { id: "a", width: 4000, height: 1000, name: "logo.svg" });
    expect(wide.width / wide.height).toBeCloseTo(4, 1);
    expect(wide.width).toBeLessThanOrEqual(doc.width * 0.6 + 1);
    expect(wide.name).toBe("logo.svg");
    const tall = createImage(doc, { id: "b", width: 10, height: 1000 });
    expect(tall.height).toBeLessThanOrEqual(doc.height * 0.6 + 1);
    expect(tall.width).toBeGreaterThanOrEqual(1);
  });

  it("updateNode changes one layer, and returns the same document when nothing changes", () => {
    const doc = docWith(2);
    const moved = updateNode(doc, "n0", { x: 10, y: 20 });
    expect(nodeById(moved, "n0")).toMatchObject({ x: 10, y: 20 });
    expect(nodeById(moved, "n1")).toBe(nodeById(doc, "n1"));
    expect(updateNode(moved, "n0", { x: 10 })).toBe(moved);
    expect(updateNode(doc, "missing", { x: 1 })).toBe(doc);
  });

  it("keeps a text layer's height estimate in step with its text and size", () => {
    let doc = addNode(createDocument(), { ...createText(createDocument()), id: "t" });
    const one = nodeById(doc, "t")!.height;
    doc = updateNode(doc, "t", { text: "a\nb\nc" });
    expect(nodeById(doc, "t")!.height).toBeCloseTo(one * 3, 1);
    doc = updateNode(doc, "t", { fontSize: 36 });
    expect(nodeById(doc, "t")!.height).toBeCloseTo(36 * 1.2 * 3, 1);
  });

  it("removes a layer together with anything grouped under it", () => {
    let doc = docWith(3);
    doc = updateNode(doc, "n1", { parentId: "n0" });
    expect(ids(removeNode(doc, "n0"))).toEqual(["n2"]);
    expect(ids(removeNode(doc, "n2"))).toEqual(["n0", "n1"]);
    expect(removeNode(doc, "missing")).toBe(doc);
  });

  describe("moveNode", () => {
    const doc = docWith(4); // n0 (bottom) .. n3 (top)
    it.each([
      ["up", "n1", ["n0", "n2", "n1", "n3"]],
      ["down", "n2", ["n0", "n2", "n1", "n3"]],
      ["top", "n0", ["n1", "n2", "n3", "n0"]],
      ["bottom", "n3", ["n3", "n0", "n1", "n2"]],
    ] as const)("%s", (to, id, expected) => {
      expect(ids(moveNode(doc, id, to))).toEqual(expected);
    });
    it("does nothing at the ends", () => {
      expect(moveNode(doc, "n3", "up")).toBe(doc);
      expect(moveNode(doc, "n3", "top")).toBe(doc);
      expect(moveNode(doc, "n0", "down")).toBe(doc);
      expect(moveNode(doc, "missing", "up")).toBe(doc);
    });
    it("reorders only among siblings", () => {
      let d = updateNode(doc, "n1", { parentId: "g" });
      d = updateNode(d, "n3", { parentId: "g" });
      // top level: n0, n2. group g: n1, n3 (interleaved in the array)
      expect(ids(moveNode(d, "n0", "up"))).toEqual(["n2", "n1", "n0", "n3"]);
      expect(ids(moveNode(d, "n1", "up"))).toEqual(["n0", "n3", "n2", "n1"]);
    });
  });

  describe("foldScale", () => {
    const doc = docWith(1);
    it("turns the scale left by a resize into width and height", () => {
      const n = nodeById(doc, "n0")!;
      expect(foldScale(n, 2, 0.5)).toEqual({ width: n.width * 2, height: n.height * 0.5 });
    });
    it("never goes below 1px", () => {
      expect(foldScale(nodeById(doc, "n0")!, 0, 0)).toEqual({ width: 1, height: 1 });
    });
    it("grows text by its width, and its font by the vertical scale", () => {
      const t = createText(createDocument());
      expect(foldScale(t, 1.5, 1)).toEqual({ width: t.width * 1.5, fontSize: t.fontSize });
      expect(foldScale(t, 2, 2)).toEqual({ width: t.width * 2, fontSize: t.fontSize * 2 });
    });
  });

  it("coverCrop fills the box without distortion, centered", () => {
    const wide = coverCrop(200, 100, 100, 100); // a wide image in a square box loses its sides
    expect(wide).toEqual({ x: 50, y: 0, width: 100, height: 100 });
    const tall = coverCrop(100, 200, 100, 100);
    expect(tall).toEqual({ x: 0, y: 50, width: 100, height: 100 });
    const same = coverCrop(300, 150, 600, 300);
    expect(same).toEqual({ x: 0, y: 0, width: 300, height: 150 });
  });
});
