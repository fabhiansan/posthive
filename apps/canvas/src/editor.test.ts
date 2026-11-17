// The editor's pure logic: undo/redo history and document operations. Nothing here needs Konva or a DOM.
import { describe, expect, it } from "vitest";
import {
  addNode,
  canAdd,
  cleanName,
  coverCrop,
  createDocument,
  createImage,
  createShape,
  createText,
  editableLayers,
  foldScale,
  limitPatch,
  moveNode,
  nodeById,
  removeNode,
  textRoom,
  textTotal,
  updateNode,
  type CanvasDocument,
  type CanvasNode,
  type NodePatch,
} from "./document";
import { canUndo, canRedo, commit, createHistory, MAX_HISTORY, redo, seal, undo } from "./history";
import { LIMITS } from "./limits";

const MAX_NODES = LIMITS.nodes;

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

// ── Limits: normal editing cannot produce a document the server would refuse ──────────────────────
// Whole documents are checked against the server's real schema in apps/api/src/lib/canvas.test.ts (random operations, the factories and the largest document), so this file cannot drift from it.

const rectDoc = () => addNode(createDocument(), { ...createShape(createDocument(), "rect"), id: "r" });
const textDoc1 = () => addNode(createDocument(), { ...createText(createDocument()), id: "t" });
const imageDoc = () => addNode(createDocument(), { ...createImage(createDocument(), { id: "asset-1", width: 100, height: 100 }), id: "i" });
const field = (doc: CanvasDocument, id: string, key: string) => (nodeById(doc, id) as unknown as Record<string, unknown>)[key];
const patch = (key: string, value: unknown) => ({ [key]: value }) as NodePatch;

/** A document of text layers with exactly these lengths, built directly so the caps cannot interfere. */
function textDocOf(lengths: number[]): CanvasDocument {
  const doc = createDocument();
  return { ...doc, nodes: lengths.map((length, i) => ({ ...createText(doc), id: `t${i}`, name: `Text ${i}`, text: "a".repeat(length) })) };
}

const NOT_NUMBERS: unknown[] = [Number.NaN, Infinity, -Infinity, "5", null, true, {}, []];

describe("every numeric field stays inside its limit", () => {
  describe.each([
    ["x", LIMITS.position],
    ["y", LIMITS.position],
    ["width", LIMITS.size],
    ["height", LIMITS.size],
    ["rotation", LIMITS.rotation],
    ["opacity", LIMITS.opacity],
    ["strokeWidth", LIMITS.strokeWidth],
    ["cornerRadius", LIMITS.cornerRadius],
  ] as const)("%s", (key, { min, max }) => {
    const set = (v: unknown) => field(updateNode(rectDoc(), "r", patch(key, v)), "r", key);
    it("keeps the limits themselves", () => {
      expect(set(min)).toBe(min);
      expect(set(max)).toBe(max);
    });
    it("clamps a value beyond them", () => {
      expect(set(max + 1)).toBe(max);
      expect(set(min - 1)).toBe(min);
      expect(set(1e12)).toBe(max);
      expect(set(-1e12)).toBe(min);
    });
    it("ignores what is not a finite number", () => {
      const doc = rectDoc();
      for (const bad of NOT_NUMBERS) expect(updateNode(doc, "r", patch(key, bad))).toBe(doc);
    });
  });

  describe.each([
    ["fontSize", LIMITS.text.fontSize],
    ["lineHeight", LIMITS.text.lineHeight],
    ["letterSpacing", LIMITS.text.letterSpacing],
  ] as const)("text %s", (key, { min, max }) => {
    const set = (v: unknown) => field(updateNode(textDoc1(), "t", patch(key, v)), "t", key);
    it("keeps the limits, clamps beyond them, ignores non-numbers", () => {
      expect(set(min)).toBe(min);
      expect(set(max)).toBe(max);
      expect(set(max + 1)).toBe(max);
      expect(set(min - 1)).toBe(min);
      const doc = textDoc1();
      for (const bad of NOT_NUMBERS) expect(updateNode(doc, "t", patch(key, bad))).toBe(doc);
    });
  });

  it("holds a shadow to its limits and drops a malformed one", () => {
    const ok = field(updateNode(rectDoc(), "r", { shadow: { color: "#000000", blur: 9999, offsetX: -9999, offsetY: 9999, opacity: 7 } }), "r", "shadow");
    expect(ok).toEqual({ color: "#000000", blur: LIMITS.shadow.blur.max, offsetX: LIMITS.shadow.offset.min, offsetY: LIMITS.shadow.offset.max, opacity: 1 });
    const doc = rectDoc();
    for (const bad of [{ color: "red", blur: 1, offsetX: 0, offsetY: 0, opacity: 1 }, { color: "#000000" }, "x", 5, null]) {
      expect(updateNode(doc, "r", patch("shadow", bad))).toBe(doc);
    }
  });
});

describe("enums, colours, ids and types", () => {
  it("accepts a known font, weight, alignment and fit, and ignores anything else", () => {
    const doc = textDoc1();
    expect(field(updateNode(doc, "t", { fontFamily: "KoHo" }), "t", "fontFamily")).toBe("KoHo");
    expect(field(updateNode(doc, "t", { fontStyle: "400" }), "t", "fontStyle")).toBe("400");
    expect(field(updateNode(doc, "t", { align: "center" }), "t", "align")).toBe("center");
    for (const [key, bad] of [["fontFamily", "Comic Sans"], ["fontStyle", "700"], ["fontStyle", 600], ["align", "justify"], ["align", null]] as const) {
      expect(updateNode(doc, "t", patch(key, bad))).toBe(doc);
    }
    const image = imageDoc();
    expect(field(updateNode(image, "i", { fit: "contain" }), "i", "fit")).toBe("contain");
    expect(updateNode(image, "i", patch("fit", "stretch"))).toBe(image);
  });

  it("accepts #rrggbb only", () => {
    const doc = rectDoc();
    expect(field(updateNode(doc, "r", { fill: "#abcdef" }), "r", "fill")).toBe("#abcdef");
    for (const bad of ["red", "#fff", "#GGGGGG", "#12345678", "javascript:alert(1)", "url(#a)", "", 5, null]) {
      expect(updateNode(doc, "r", patch("fill", bad))).toBe(doc);
      expect(updateNode(doc, "r", patch("stroke", bad))).toBe(doc);
    }
  });

  it("accepts an asset id that is plain, and nothing that could change a URL", () => {
    const doc = imageDoc();
    expect(field(updateNode(doc, "i", { assetId: "abc_12-3" }), "i", "assetId")).toBe("abc_12-3");
    for (const bad of ["../x", "https://evil.example/x.png", "//evil.example", "a/b", "a\\b", "a?b", "a#b", "a%2e", "a b", "", "x".repeat(65), 5, null]) {
      expect(updateNode(doc, "i", patch("assetId", bad))).toBe(doc);
    }
  });

  it("ignores a field the layer's type does not have, and unknown keys", () => {
    const rect = rectDoc();
    expect(updateNode(rect, "r", patch("text", "hi"))).toBe(rect);
    expect(updateNode(rect, "r", patch("fontSize", 20))).toBe(rect);
    expect(updateNode(rect, "r", patch("assetId", "abc"))).toBe(rect);
    expect(updateNode(textDoc1(), "t", patch("assetId", "abc"))).toSatisfy((d: CanvasDocument) => field(d, "t", "assetId") === undefined);
    expect(updateNode(rect, "r", patch("foo", 1))).toBe(rect);
    expect(updateNode(rect, "r", JSON.parse('{"__proto__": {"x": 1}, "url": "https://evil.example"}'))).toBe(rect);
    expect(limitPatch(nodeById(rect, "r")!, { x: Number.NaN, y: 5, ...patch("foo", 1) })).toEqual({ y: 5 });
  });

  it("allows a layer permission only on the type it is for", () => {
    const rect = rectDoc();
    expect(updateNode(rect, "r", { permission: "text" })).toBe(rect);
    expect(updateNode(rect, "r", { permission: "image" })).toBe(rect);
    expect(updateNode(textDoc1(), "t", { permission: "image" })).toSatisfy((d: CanvasDocument) => field(d, "t", "permission") === "protected");
    expect(field(updateNode(textDoc1(), "t", { permission: "text" }), "t", "permission")).toBe("text");
    expect(field(updateNode(imageDoc(), "i", { permission: "image" }), "i", "permission")).toBe("image");
  });

  it("ignores a visibility that is not a boolean, and clears an optional field with undefined", () => {
    const doc = rectDoc();
    expect(updateNode(doc, "r", patch("visible", "yes"))).toBe(doc);
    expect(field(updateNode(doc, "r", { visible: false }), "r", "visible")).toBe(false);
    const stroked = updateNode(doc, "r", { stroke: "#000000", strokeWidth: 4 });
    const cleared = updateNode(stroked, "r", { stroke: undefined, strokeWidth: undefined });
    expect("stroke" in (nodeById(cleared, "r") as object)).toBe(false);
    expect("strokeWidth" in (nodeById(cleared, "r") as object)).toBe(false);
  });

  it("only checks the shape of a parent id", () => {
    const doc = rectDoc();
    expect(field(updateNode(doc, "r", { parentId: "g1" }), "r", "parentId")).toBe("g1");
    expect(updateNode(doc, "r", patch("parentId", "a/b"))).toBe(doc);
    expect(updateNode(doc, "r", { parentId: null })).toBe(doc); // already null
  });
});

describe("names are trimmed; text content never is", () => {
  it("cleans a layer name", () => {
    expect(cleanName("  Layer  ")).toBe("Layer");
    expect(cleanName("a\nb\tc")).toBe("a b c");
    expect(cleanName("")).toBeNull();
    expect(cleanName("   ")).toBeNull();
    expect(cleanName("\u0000\u0001\u007f")).toBeNull();
    expect(cleanName("a\ud83db")).toBe("ab"); // an unpaired surrogate cannot be stored
    expect(cleanName("a😀b")).toBe("a😀b");
    expect(cleanName("x".repeat(81))).toHaveLength(LIMITS.nodeName.max);
    expect(cleanName("x".repeat(LIMITS.nodeName.max))).toHaveLength(LIMITS.nodeName.max);
    expect(cleanName("x".repeat(79) + "😀")).toBe("x".repeat(79)); // never half an emoji
    expect(cleanName("x".repeat(100), LIMITS.designName.max)).toHaveLength(LIMITS.designName.max);
  });

  it("applies it to a rename, and ignores a blank one", () => {
    const doc = rectDoc();
    expect(field(updateNode(doc, "r", { name: "  Hero  " }), "r", "name")).toBe("Hero");
    expect(updateNode(doc, "r", { name: "   " })).toBe(doc);
    expect(updateNode(doc, "r", patch("name", 5))).toBe(doc);
    expect(field(updateNode(doc, "r", { name: "y".repeat(500) }), "r", "name")).toHaveLength(LIMITS.nodeName.max);
  });

  it.each([
    ["leading spaces", "  leading"],
    ["trailing spaces", "trailing  "],
    ["blank lines around", "\n\nblank lines\n\n"],
    ["a line break", "line1\nline2"],
    ["Windows line endings", "a\r\nb"],
    ["a tab", "\ttab"],
    ["only spaces", "   "],
    ["only a line break", "\n"],
    ["nothing at all", ""],
    ["non-Latin text and an emoji", "日本語 😀 emoji"],
    ["a control character", "a\u0001b"],
  ])("keeps text exactly, byte for byte: %s", (_label, text) => {
    const next = updateNode(textDoc1(), "t", { text });
    expect(field(next, "t", "text")).toBe(text);
  });

  it("removes only what cannot be stored: NUL and unpaired surrogates", () => {
    expect(field(updateNode(textDoc1(), "t", { text: "a\u0000b" }), "t", "text")).toBe("ab");
    expect(field(updateNode(textDoc1(), "t", { text: "x\ud83d" }), "t", "text")).toBe("x");
    expect(field(updateNode(textDoc1(), "t", { text: "\ude00y" }), "t", "text")).toBe("y");
    expect(field(updateNode(textDoc1(), "t", { text: "😀" }), "t", "text")).toBe("😀");
  });

  it("cuts an over-long text at the layer limit without splitting an emoji", () => {
    const long = field(updateNode(textDoc1(), "t", { text: "z".repeat(LIMITS.text.length + 50) }), "t", "text") as string;
    expect(long).toHaveLength(LIMITS.text.length);
    const emoji = field(updateNode(textDoc1(), "t", { text: "z".repeat(LIMITS.text.length - 1) + "😀" }), "t", "text") as string;
    expect(emoji).toBe("z".repeat(LIMITS.text.length - 1));
  });
});

describe("the text budget", () => {
  const cap = LIMITS.totalText;
  const full = LIMITS.text.length;

  it("textRoom is the layer's text plus what is left of the budget, up to one layer's limit, never below what it holds", () => {
    expect(textRoom(textDocOf([10]), "t0")).toBe(full); // plenty left
    const near = textDocOf([10, ...Array(15).fill(full), cap - 10 - 15 * full - 10]); // 10 characters left in the budget
    expect(textTotal(near)).toBe(cap - 10);
    expect(textRoom(near, "t0")).toBe(20); // 10 it holds + 10 left
    const atCap = textDocOf(Array(cap / full).fill(full));
    expect(textTotal(atCap)).toBe(cap);
    expect(textRoom(atCap, "t0")).toBe(full); // nothing left, but it may keep what it has
    const over = textDocOf([...Array(cap / full).fill(full), 3000]); // already over the budget (an older document)
    expect(textRoom(over, "t16")).toBe(3000); // may be edited or shortened, not lengthened
    expect(textRoom(over, "t0")).toBe(full);
    const longer = textDocOf([full + 1000]); // longer than one layer may be: still never cut
    expect(textRoom(longer, "t0")).toBe(full + 1000);
    expect(textRoom(rectDoc(), "r")).toBe(0); // not a text layer
    expect(textRoom(rectDoc(), "missing")).toBe(0);
  });

  it("editing a long text at the cap does not truncate it", () => {
    const doc = textDocOf(Array(cap / full).fill(full));
    const middle = "A".repeat(2500) + "B" + "C".repeat(2499);
    const withText = updateNode(doc, "t3", { text: middle });
    const edited = updateNode(withText, "t3", { text: "A".repeat(2500) + "Z" + "C".repeat(2499) });
    expect(field(edited, "t3", "text")).toBe("A".repeat(2500) + "Z" + "C".repeat(2499));
    expect(textTotal(edited)).toBe(cap);
    // the other layers are untouched
    expect(field(edited, "t4", "text")).toBe("a".repeat(full));
  });

  it("cuts what does not fit, accepts what is shorter", () => {
    const doc = textDocOf([100, ...Array(15).fill(full), 4900]); // 100 + 75,000 + 4,900 = 80,000
    expect(textTotal(doc)).toBe(cap);
    expect(field(updateNode(doc, "t0", { text: "b".repeat(101) }), "t0", "text")).toBe("b".repeat(100)); // the 101st is refused
    expect(field(updateNode(doc, "t0", { text: "b".repeat(2000) }), "t0", "text")).toBe("b".repeat(100)); // a paste is cut to what fits
    expect(field(updateNode(doc, "t0", { text: "b".repeat(40) }), "t0", "text")).toBe("b".repeat(40)); // shorter is always fine
    expect(field(updateNode(doc, "t0", { text: "" }), "t0", "text")).toBe("");
  });

  it("refuses a new text layer that would pass the budget, and the 501st layer", () => {
    const doc = textDocOf([cap - 5]);
    expect(canAdd(doc, createText(doc))).toBe("This design has reached its text limit."); // "Your text here" is 14
    expect(addNode(doc, createText(doc))).toBe(doc);
    const room = textDocOf([cap - 14]);
    expect(canAdd(room, createText(room))).toBeNull();
    expect(canAdd(room, createShape(room, "rect"))).toBeNull();

    const nearly = docWith(MAX_NODES - 1);
    expect(canAdd(nearly, createShape(nearly, "rect"))).toBeNull(); // the 500th is accepted
    expect(addNode(nearly, createShape(nearly, "rect")).nodes).toHaveLength(MAX_NODES);
    const full500 = docWith(MAX_NODES);
    expect(canAdd(full500, createShape(full500, "rect"))).toBe(`A design can have up to ${MAX_NODES} layers.`);
    expect(addNode(full500, createShape(full500, "rect"))).toBe(full500);
  });
});

describe("derived and created values stay valid", () => {
  it("a text layer's height is bounded however many line breaks it has", () => {
    const doc = updateNode(textDoc1(), "t", { fontSize: LIMITS.text.fontSize.max, lineHeight: LIMITS.text.lineHeight.max, text: "\n".repeat(LIMITS.text.length - 1) });
    expect(field(doc, "t", "height")).toBe(LIMITS.size.max);
    const tiny = updateNode(textDoc1(), "t", { fontSize: 1, lineHeight: 0.5, text: "" });
    expect(field(tiny, "t", "height")).toBeGreaterThanOrEqual(LIMITS.size.min);
  });

  it("every factory makes a valid layer on the smallest and the largest artboard", () => {
    for (const side of [LIMITS.side.min, 2, LIMITS.side.max]) {
      let doc: CanvasDocument = { ...createDocument(), width: side, height: side };
      doc = addNode(doc, createShape(doc, "rect"));
      doc = addNode(doc, createShape(doc, "ellipse"));
      doc = addNode(doc, createText(doc));
      for (const [width, height] of [[1, 1], [8192, 8192], [1, 8192], [8192, 1], [4000, 1000]]) {
        doc = addNode(doc, createImage(doc, { id: "asset-1", width, height, name: "  \u0001  " }));
      }
      expect(doc.nodes).toHaveLength(8);
      for (const n of doc.nodes) {
        expect(n.width).toBeGreaterThanOrEqual(LIMITS.size.min);
        expect(n.height).toBeGreaterThanOrEqual(LIMITS.size.min);
        expect(n.width).toBeLessThanOrEqual(LIMITS.size.max);
        expect(n.height).toBeLessThanOrEqual(LIMITS.size.max);
        expect(n.name.trim()).not.toBe("");
      }
    }
  });

  it("foldScale keeps width, height and font size inside their limits", () => {
    const rect = nodeById(rectDoc(), "r")!;
    expect(foldScale(rect, 1e9, 1e9)).toEqual({ width: LIMITS.size.max, height: LIMITS.size.max });
    expect(foldScale(rect, -5, 1e-12)).toEqual({ width: LIMITS.size.min, height: LIMITS.size.min });
    expect(foldScale(rect, Number.NaN, Infinity)).toEqual({ width: rect.width, height: rect.height }); // not a scale: treated as 1
    const text = nodeById(textDoc1(), "t")!;
    expect(foldScale(text, 1e9, 1e9)).toEqual({ width: LIMITS.size.max, fontSize: LIMITS.text.fontSize.max });
    expect(foldScale(text, 0, 0)).toEqual({ width: LIMITS.size.min, fontSize: LIMITS.text.fontSize.min });
  });

  it("a drag or a resize that ends at the position limit comes out inside it", () => {
    const moved = updateNode(rectDoc(), "r", { x: 1e9, y: -1e9, ...foldScale(nodeById(rectDoc(), "r")!, 1e6, 1e6) });
    expect(field(moved, "r", "x")).toBe(LIMITS.position.max);
    expect(field(moved, "r", "y")).toBe(LIMITS.position.min);
    expect(field(moved, "r", "width")).toBe(LIMITS.size.max);
  });
});

// ── Who may change a layer once the design is published (phase 4) ──────────────────────────────────────────────

describe("setting a layer's Marketing access", () => {
  it("a text layer can be Text editable and back to Protected, as one undoable step each", () => {
    const doc = textDoc1();
    expect(field(doc, "t", "permission")).toBe("protected");
    let h = createHistory(doc);
    h = commit(h, updateNode(h.present, "t", { permission: "text" }), "permission");
    expect(field(h.present, "t", "permission")).toBe("text");
    h = seal(h);
    h = commit(h, updateNode(h.present, "t", { permission: "protected" }), "permission");
    expect(field(h.present, "t", "permission")).toBe("protected");
    h = undo(h);
    expect(field(h.present, "t", "permission")).toBe("text");
    h = undo(h);
    expect(field(h.present, "t", "permission")).toBe("protected");
    h = redo(h);
    expect(field(h.present, "t", "permission")).toBe("text");
  });

  it("an image layer can be Image replaceable", () => {
    expect(field(updateNode(imageDoc(), "i", { permission: "image" }), "i", "permission")).toBe("image");
  });

  it("a layer can never hold the permission of another kind of layer", () => {
    const text = textDoc1();
    const image = imageDoc();
    const rect = rectDoc();
    expect(updateNode(text, "t", { permission: "image" })).toBe(text);
    expect(updateNode(image, "i", { permission: "text" })).toBe(image);
    for (const p of ["text", "image"] as const) expect(updateNode(rect, "r", { permission: p })).toBe(rect);
  });

  it("anything that is not a permission is ignored, so no edit can invent one", () => {
    const text = textDoc1();
    for (const bad of ["admin", "TEXT", "", null, undefined, 1, {}, ["text"]]) {
      expect(updateNode(text, "t", { permission: bad as never }), String(bad)).toBe(text);
    }
    expect(field(text, "t", "permission")).toBe("protected");
  });

  it("setting the permission it already has changes nothing (so it is no undo step)", () => {
    const doc = updateNode(textDoc1(), "t", { permission: "text" });
    expect(updateNode(doc, "t", { permission: "text" })).toBe(doc);
  });

  it("changing the permission changes nothing else about the layer", () => {
    const before = textDoc1();
    const after = updateNode(before, "t", { permission: "text" });
    expect({ ...(nodeById(after, "t") as object), permission: "protected" }).toEqual(nodeById(before, "t"));
  });
});

describe("editableLayers", () => {
  const layer = (type: "text" | "image" | "rect" | "group", over: Partial<CanvasNode> & { id: string }): CanvasNode => {
    const blank = createDocument();
    const base = type === "text" ? createText(blank) : type === "image" ? createImage(blank, { id: "asset-1", width: 10, height: 10 }) : createShape(blank, type === "group" ? "rect" : type);
    return { ...base, ...(type === "group" ? { type: "group" } : {}), name: `Layer ${over.id}`, ...over } as CanvasNode;
  };
  const docOf = (...nodes: CanvasNode[]): CanvasDocument => ({ ...createDocument(), nodes });
  const idsOf = (list: Array<{ nodeId: string }>) => list.map((f) => f.nodeId);

  it("lists a text layer set to text and an image layer set to image, in paint order, with what each is", () => {
    const { fields, hidden } = editableLayers(docOf(layer("text", { id: "a", permission: "text" }), layer("rect", { id: "b" }), layer("image", { id: "c", permission: "image" }), layer("text", { id: "d" })));
    expect(fields).toEqual([{ nodeId: "a", kind: "text" }, { nodeId: "c", kind: "image" }]);
    expect(hidden).toEqual([]);
  });

  it("an empty design has nothing editable", () => {
    expect(editableLayers(createDocument())).toEqual({ fields: [], hidden: [] });
  });

  it("an editable layer that is hidden is reported, not listed", () => {
    const { fields, hidden } = editableLayers(docOf(layer("text", { id: "a", permission: "text", visible: false })));
    expect(fields).toEqual([]);
    expect(hidden).toEqual([{ nodeId: "a", name: "Layer a", group: null }]);
  });

  it("an editable layer inside a hidden group is hidden, and the group is named", () => {
    const { fields, hidden } = editableLayers(docOf(layer("group", { id: "g", visible: false }), layer("text", { id: "a", permission: "text", parentId: "g" })));
    expect(fields).toEqual([]);
    expect(hidden).toEqual([{ nodeId: "a", name: "Layer a", group: "Layer g" }]);
  });

  it("a hidden grandparent hides a grandchild", () => {
    const { fields, hidden } = editableLayers(docOf(layer("group", { id: "g1", visible: false }), layer("group", { id: "g2", parentId: "g1" }), layer("image", { id: "a", permission: "image", parentId: "g2" })));
    expect(fields).toEqual([]);
    expect(hidden).toMatchObject([{ nodeId: "a", group: "Layer g1" }]);
  });

  it("a visible child of visible groups is listed", () => {
    const { fields, hidden } = editableLayers(docOf(layer("group", { id: "g1" }), layer("group", { id: "g2", parentId: "g1" }), layer("text", { id: "a", permission: "text", parentId: "g2" })));
    expect(idsOf(fields)).toEqual(["a"]);
    expect(hidden).toEqual([]);
  });

  it("hidden layers that are protected never matter", () => {
    expect(editableLayers(docOf(layer("group", { id: "g", visible: false }), layer("rect", { id: "r", parentId: "g" }), layer("text", { id: "t", visible: false }))).hidden).toEqual([]);
  });

  it("a parent that is missing, or a loop, fails closed and never hangs", () => {
    expect(editableLayers(docOf(layer("text", { id: "a", permission: "text", parentId: "nope" }))).hidden).toHaveLength(1);
    expect(editableLayers(docOf(layer("group", { id: "g1", parentId: "g2" }), layer("group", { id: "g2", parentId: "g1" }), layer("text", { id: "a", permission: "text", parentId: "g1" }))).hidden).toHaveLength(1);
  });

  it("follows edits made through the editor: hiding the layer, or setting it back to protected, changes the answer", () => {
    let doc = updateNode(textDoc1(), "t", { permission: "text" });
    expect(idsOf(editableLayers(doc).fields)).toEqual(["t"]);
    doc = updateNode(doc, "t", { visible: false });
    expect(editableLayers(doc)).toMatchObject({ fields: [], hidden: [{ nodeId: "t" }] });
    doc = updateNode(doc, "t", { permission: "protected" });
    expect(editableLayers(doc)).toEqual({ fields: [], hidden: [] });
  });

  it("does not change its input", () => {
    const doc = updateNode(textDoc1(), "t", { permission: "text" });
    const copy = JSON.stringify(doc);
    editableLayers(doc);
    expect(JSON.stringify(doc)).toBe(copy);
  });
});
