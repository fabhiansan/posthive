// The server's schema for a saved design. The canvas engine's limits.ts is imported on purpose (a test is the one
// place the API may reach into apps/canvas): every boundary below is driven by the ENGINE's numbers, so if the two
// sides drift apart, a document the editor can make is refused here, or one the editor forbids gets through.
import { describe, expect, it } from "vitest";
import { addNode, createDocument, createImage, createShape, createText, editableLayers, foldScale, moveNode, removeNode, updateNode, type CanvasDocument, type CanvasNode, type NodePatch } from "../../../canvas/src/document";
import { LIMITS as ENGINE } from "../../../canvas/src/limits";
import { BLANK_DOCUMENT, LIMITS, attachBody, buildManifest, canvasDocument, createBody, designName, documentAssetIds, firstIssue, hiddenMessage, publishBody, saveBody } from "./canvas.js";

const accepts = (doc: unknown) => canvasDocument.safeParse(doc).success;
const issuePath = (doc: unknown) => {
  const r = canvasDocument.safeParse(doc);
  return r.success ? null : firstIssue(r.error).path;
};

const blank = createDocument();
/** One of every layer the editor creates. Fields are changed per test, on a copy. */
function sample() {
  return {
    ...blank,
    nodes: [
      { ...createShape(blank, "rect"), id: "r" },
      { ...createShape(blank, "ellipse"), id: "e" },
      { ...createText(blank), id: "t" },
      { ...createImage(blank, { id: "asset-1", width: 10, height: 10 }), id: "i" },
    ],
  } as ReturnType<typeof createDocument> & { nodes: Array<Record<string, unknown>> };
}
function withNode(id: string, change: Record<string, unknown>) {
  const doc = sample();
  doc.nodes = doc.nodes.map((n) => (n.id === id ? { ...n, ...change } : n));
  return doc;
}
const textLayers = (lengths: number[]) => ({
  ...blank,
  nodes: lengths.map((length, i) => ({ ...createText(blank), id: `t${i}`, name: `Text ${i}`, text: "a".repeat(length) })),
});

describe("the schema and the editor share one set of limits", () => {
  it("has exactly the numbers, lists and patterns the engine holds", () => {
    expect(LIMITS).toEqual(ENGINE);
  });

  it("starts a new design from the blank document the editor starts from", () => {
    expect(BLANK_DOCUMENT).toEqual(createDocument());
    expect(accepts(BLANK_DOCUMENT)).toBe(true);
  });

  it("accepts every kind of layer the editor creates, with a shadow, a group child and a source", () => {
    const doc = sample();
    doc.nodes.push({ ...createShape(blank, "rect"), id: "g", type: "group" });
    doc.nodes.push({ ...createShape(blank, "rect"), id: "child", parentId: "g", shadow: { color: "#000000", blur: 4, offsetX: 1, offsetY: -1, opacity: 0.5 }, stroke: "#112233", strokeWidth: 2, cornerRadius: 8 });
    expect(canvasDocument.safeParse({ ...doc, source: { kind: "figma", ref: "abc", importedAt: "2026-11-17T00:00:00Z" } }).success).toBe(true);
  });

  describe.each([
    ["x", "r", ENGINE.position],
    ["y", "r", ENGINE.position],
    ["width", "r", ENGINE.size],
    ["height", "r", ENGINE.size],
    ["rotation", "r", ENGINE.rotation],
    ["opacity", "r", ENGINE.opacity],
    ["strokeWidth", "r", ENGINE.strokeWidth],
    ["cornerRadius", "r", ENGINE.cornerRadius],
    ["fontSize", "t", ENGINE.text.fontSize],
    ["lineHeight", "t", ENGINE.text.lineHeight],
    ["letterSpacing", "t", ENGINE.text.letterSpacing],
  ] as const)("%s", (key, id, { min, max }) => {
    it("accepts the limits and refuses a hair beyond them", () => {
      expect(accepts(withNode(id, { [key]: min }))).toBe(true);
      expect(accepts(withNode(id, { [key]: max }))).toBe(true);
      expect(accepts(withNode(id, { [key]: max + 0.01 }))).toBe(false);
      expect(accepts(withNode(id, { [key]: min - 0.01 }))).toBe(false);
    });
    it("refuses what is not a finite number", () => {
      for (const bad of [Number.NaN, Infinity, -Infinity, "5", null, true, {}]) expect(accepts(withNode(id, { [key]: bad }))).toBe(false);
      // JSON.parse turns 1e400 into Infinity: it must not slip through
      expect(accepts(withNode(id, { [key]: JSON.parse("1e400") }))).toBe(false);
    });
  });

  it("holds a shadow to the engine's limits", () => {
    const shadow = (change: Record<string, unknown>) => withNode("r", { shadow: { color: "#000000", blur: 0, offsetX: 0, offsetY: 0, opacity: 1, ...change } });
    expect(accepts(shadow({}))).toBe(true);
    for (const [key, { min, max }] of [["blur", ENGINE.shadow.blur], ["offsetX", ENGINE.shadow.offset], ["offsetY", ENGINE.shadow.offset], ["opacity", ENGINE.shadow.opacity]] as const) {
      expect(accepts(shadow({ [key]: min }))).toBe(true);
      expect(accepts(shadow({ [key]: max }))).toBe(true);
      expect(accepts(shadow({ [key]: max + 0.01 }))).toBe(false);
      expect(accepts(shadow({ [key]: min - 0.01 }))).toBe(false);
    }
    expect(accepts(shadow({ extra: 1 }))).toBe(false);
  });

  it("holds the artboard to whole pixels inside the engine's range", () => {
    for (const key of ["width", "height"]) {
      expect(accepts({ ...sample(), [key]: ENGINE.side.min })).toBe(true);
      expect(accepts({ ...sample(), [key]: ENGINE.side.max })).toBe(true);
      expect(accepts({ ...sample(), [key]: ENGINE.side.max + 1 })).toBe(false);
      expect(accepts({ ...sample(), [key]: ENGINE.side.min - 1 })).toBe(false);
      expect(accepts({ ...sample(), [key]: 1080.5 })).toBe(false);
    }
  });

  it("accepts the engine's fonts, weights, alignments and fits and nothing else", () => {
    for (const fontFamily of ENGINE.text.fonts) expect(accepts(withNode("t", { fontFamily }))).toBe(true);
    for (const fontStyle of ENGINE.text.weights) expect(accepts(withNode("t", { fontStyle }))).toBe(true);
    for (const align of ENGINE.text.aligns) expect(accepts(withNode("t", { align }))).toBe(true);
    for (const fit of ENGINE.fits) expect(accepts(withNode("i", { fit }))).toBe(true);
    for (const [id, change] of [["t", { fontFamily: "Comic Sans" }], ["t", { fontStyle: "700" }], ["t", { fontStyle: 600 }], ["t", { align: "justify" }], ["i", { fit: "stretch" }]] as const) {
      expect(accepts(withNode(id, change))).toBe(false);
    }
  });

  it("allows a layer permission only on the type it is for (every permission on every type)", () => {
    const own: Record<string, string> = { text: "text", image: "image" };
    for (const node of sample().nodes) {
      for (const permission of ["protected", "text", "image"]) {
        const allowed = permission === "protected" || own[node.type as string] === permission;
        expect(accepts(withNode(node.id as string, { permission })), `${String(node.type)} ${permission}`).toBe(allowed);
      }
    }
  });

  it("accepts #rrggbb only, as a fill, a stroke and the background", () => {
    for (const ok of ["#000000", "#abcdef", "#ABCDEF"]) expect(accepts(withNode("r", { fill: ok, stroke: ok }))).toBe(true);
    for (const bad of ["red", "#fff", "#GGGGGG", "#12345678", "url(#a)", "javascript:alert(1)", "", 5, null]) {
      expect(accepts(withNode("r", { fill: bad }))).toBe(false);
      expect(accepts(withNode("r", { stroke: bad }))).toBe(false);
      expect(accepts({ ...sample(), background: { color: bad } })).toBe(false);
    }
  });

  it("accepts only plain ids and asset ids, nothing that could change a URL", () => {
    for (const ok of ["abc", "a-b_c", "x".repeat(64), "550e8400-e29b-41d4-a716-446655440000", "ckx1y2z3a0000abcd"]) {
      expect(accepts(withNode("i", { assetId: ok }))).toBe(true);
    }
    for (const bad of ["../x", "https://evil.example/x.png", "//evil.example", "/user/me", "a/b", "a\\b", "a?b", "a#b", "a%2e%2e", "a b", "a\n", "", "x".repeat(65), 5, null]) {
      expect(accepts(withNode("i", { assetId: bad })), `assetId ${String(bad)}`).toBe(false);
      expect(accepts(withNode("r", { id: bad })), `id ${String(bad)}`).toBe(false);
    }
  });
});

describe("counts", () => {
  const rects = (n: number) => ({ ...blank, nodes: Array.from({ length: n }, (_, i) => ({ ...createShape(blank, "rect"), id: `n${i}`, name: `R${i}` })) });

  it("accepts the 500th layer and refuses the 501st", () => {
    expect(accepts(rects(ENGINE.nodes))).toBe(true);
    expect(accepts(rects(ENGINE.nodes + 1))).toBe(false);
  });

  it("accepts text up to one layer's limit and the design's budget, and refuses a character more", () => {
    const full = ENGINE.text.length;
    expect(accepts(textLayers([full]))).toBe(true);
    expect(accepts(textLayers([full + 1]))).toBe(false);
    expect(accepts(textLayers(Array(ENGINE.totalText / full).fill(full)))).toBe(true); // exactly the budget
    expect(accepts(textLayers([...Array(ENGINE.totalText / full - 1).fill(full), full - 1]))).toBe(true);
    expect(accepts(textLayers([...Array(ENGINE.totalText / full).fill(full), 1]))).toBe(false); // one character over
  });
});

describe("rejections", () => {
  it("duplicate layer ids", () => {
    const doc = sample();
    doc.nodes[1] = { ...doc.nodes[1], id: "r" };
    expect(accepts(doc)).toBe(false);
    expect(issuePath(doc)).toBe("nodes.1.id");
  });

  it("a parent that is missing or is not a group, and a layer that is its own parent", () => {
    expect(accepts(withNode("r", { parentId: "nope" }))).toBe(false);
    expect(accepts(withNode("r", { parentId: "e" }))).toBe(false); // a rectangle is not a group
    const own = { ...sample(), nodes: [{ ...createShape(blank, "rect"), id: "g", type: "group", parentId: "g" }] };
    expect(accepts(own)).toBe(false);
  });

  it("a group cycle, and accepts a valid group tree", () => {
    const group = (id: string, parentId: string | null) => ({ ...createShape(blank, "rect"), id, type: "group", name: id, parentId });
    expect(accepts({ ...blank, nodes: [group("a", "b"), group("b", "a")] })).toBe(false);
    expect(accepts({ ...blank, nodes: [group("a", "b"), group("b", "c"), group("c", "a")] })).toBe(false);
    expect(accepts({ ...blank, nodes: [group("a", null), group("b", "a"), group("c", "b")] })).toBe(true);
  });

  it("an unknown key on the document, a layer, the background, a shadow or the source", () => {
    for (const key of ["url", "src", "href", "__proto__"]) {
      const extra = JSON.parse(`{"${key}": "https://evil.example/x"}`) as Record<string, unknown>;
      expect(accepts({ ...sample(), ...extra }), `document ${key}`).toBe(false);
      expect(accepts({ ...sample(), background: { color: "#FFFFFF", ...extra } }), `background ${key}`).toBe(false);
      expect(accepts(withNode("r", extra)), `layer ${key}`).toBe(false);
      expect(accepts(withNode("i", extra)), `image ${key}`).toBe(false);
      expect(accepts(withNode("r", { shadow: { color: "#000000", blur: 0, offsetX: 0, offsetY: 0, opacity: 1, ...extra } })), `shadow ${key}`).toBe(false);
      expect(accepts({ ...sample(), source: { kind: "x", ...extra } }), `source ${key}`).toBe(false);
    }
  });

  it("another schema version, a missing field and a wrong type", () => {
    expect(accepts({ ...sample(), schemaVersion: 2 })).toBe(false);
    expect(accepts({ ...sample(), schemaVersion: "1" })).toBe(false);
    expect(accepts({ ...sample(), nodes: "none" })).toBe(false);
    expect(accepts(null)).toBe(false);
    expect(accepts(withNode("r", { visible: "yes" }))).toBe(false);
    expect(accepts(withNode("r", { type: "polygon" }))).toBe(false);
    const { name: _name, ...noName } = sample().nodes[0];
    expect(accepts({ ...sample(), nodes: [noName] })).toBe(false);
  });

  it("a source that is too long or cannot be stored", () => {
    for (const [key, max] of [["kind", ENGINE.source.kind], ["ref", ENGINE.source.ref], ["importedAt", ENGINE.source.importedAt]] as const) {
      expect(accepts({ ...sample(), source: { kind: "k", [key]: "x".repeat(max) } })).toBe(true);
      expect(accepts({ ...sample(), source: { kind: "k", [key]: "x".repeat(max + 1) } })).toBe(false);
      expect(accepts({ ...sample(), source: { kind: "k", [key]: "a\u0000b" } })).toBe(false);
    }
  });
});

describe("layer names", () => {
  it("are 1 to 80 characters after trimming, with no control character, and are never rewritten", () => {
    const parsed = canvasDocument.safeParse(withNode("r", { name: "  x " }));
    expect(parsed.success && parsed.data.nodes[0].name).toBe("  x ");
    expect(accepts(withNode("r", { name: "x".repeat(ENGINE.nodeName.max) }))).toBe(true);
    expect(accepts(withNode("r", { name: "x".repeat(ENGINE.nodeName.max + 1) }))).toBe(false);
    for (const bad of ["", "   ", "a\nb", "a\tb", "a\u0000b", "a\u007fb", "a\u0085b", "a\ud83db", 5, null]) {
      expect(accepts(withNode("r", { name: bad })), JSON.stringify(bad)).toBe(false);
    }
    expect(accepts(withNode("r", { name: "日本語 😀" }))).toBe(true);
  });
});

describe("text content is validated, never rewritten", () => {
  it.each([
    ["leading spaces", "  leading"],
    ["trailing spaces", "trailing  "],
    ["blank lines around", "\n\nblank lines\n\n"],
    ["a line break", "line1\nline2"],
    ["Windows line endings", "a\r\nb"],
    ["a tab", "\ttab"],
    ["only spaces", "   "],
    ["only a line break", "\n"],
    ["nothing", ""],
    ["non-Latin and an emoji", "日本語 😀 emoji"],
    ["a control character", "a\u0001b"],
  ])("accepts and returns it unchanged: %s", (_label, text) => {
    const parsed = canvasDocument.safeParse(withNode("t", { text }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && (parsed.data.nodes.find((n) => n.id === "t") as { text: string }).text).toBe(text);
  });

  it("refuses only what cannot be stored: NUL and an unpaired surrogate, naming the path", () => {
    for (const text of ["a\u0000b", "x\ud83d", "\ude00y"]) {
      const doc = withNode("t", { text });
      expect(accepts(doc)).toBe(false);
      expect(issuePath(doc)).toBe("nodes.2.text");
    }
  });
});

describe("the largest valid document", () => {
  it("passes the schema and fits the API's 1 MB request limit with control characters as text", () => {
    const text = "\u0001".repeat(ENGINE.totalText / ENGINE.nodes);
    const nodes = Array.from({ length: ENGINE.nodes }, (_, i) => ({
      ...createText(blank),
      id: `aaaaaaaa-aaaa-aaaa-aaaa-${String(i).padStart(12, "0")}`,
      name: "界".repeat(ENGINE.nodeName.max),
      x: -99_999.99,
      y: -99_999.99,
      width: 19_999.99,
      height: 19_999.99,
      rotation: -3599.99,
      opacity: 0.99,
      fill: "#FFFFFF",
      stroke: "#FFFFFF",
      strokeWidth: 499.99,
      cornerRadius: 19_999.99,
      shadow: { color: "#FFFFFF", blur: 499.99, offsetX: -999.99, offsetY: -999.99, opacity: 0.99 },
      permission: "text",
      text,
      fontStyle: "600",
      align: "center",
      fontSize: 999.99,
      lineHeight: 2.99,
      letterSpacing: -49.99,
    }));
    const source = { kind: "k".repeat(ENGINE.source.kind), ref: "r".repeat(ENGINE.source.ref), importedAt: "i".repeat(ENGINE.source.importedAt) };
    const full = { ...blank, nodes, source };
    const body = JSON.stringify({ version: 2_147_483_647 - 1, document: full, name: "界".repeat(ENGINE.designName.max) });
    expect(new TextEncoder().encode(body).length).toBeLessThan(1_048_576);
    expect(saveBody.safeParse({ version: 2_000_000_000, document: full, name: "界".repeat(ENGINE.designName.max) }).success).toBe(true);
  });
});

// ── What the editor can make, judged by the real schema ─────────────────────────────────────────────
// The engine's own tests hold each field to the limits. These ask the question that matters: is what the editor
// produces accepted by the server? Judged by canvasDocument itself, not a copy of its rules, so a rule added on the
// server fails here at once.

const whyRefused = (doc: unknown): string | null => {
  const r = canvasDocument.safeParse(doc);
  return r.success ? null : r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
};
const rectOnly = () => addNode(createDocument(), { ...createShape(createDocument(), "rect"), id: "r" });
const textOnly = () => addNode(createDocument(), { ...createText(createDocument()), id: "t" });

describe("what the editor makes, the server accepts", () => {
  it("a text layer with 5,000 line breaks at the largest font and line height", () => {
    const doc = updateNode(textOnly(), "t", { fontSize: ENGINE.text.fontSize.max, lineHeight: ENGINE.text.lineHeight.max, text: "\n".repeat(ENGINE.text.length - 1) });
    expect(whyRefused(doc)).toBeNull();
    expect(whyRefused(updateNode(textOnly(), "t", { fontSize: 1, lineHeight: 0.5, text: "" }))).toBeNull();
  });

  it("every factory, on the smallest and the largest artboard, with odd image sizes and names", () => {
    for (const side of [ENGINE.side.min, 2, ENGINE.side.max]) {
      let doc: CanvasDocument = { ...createDocument(), width: side, height: side };
      doc = addNode(doc, createShape(doc, "rect"));
      doc = addNode(doc, createShape(doc, "ellipse"));
      doc = addNode(doc, createText(doc));
      for (const [width, height] of [[1, 1], [8192, 8192], [1, 8192], [8192, 1], [4000, 1000]]) {
        doc = addNode(doc, createImage(doc, { id: "asset-1", width, height, name: "  \u0001  " }));
      }
      expect(doc.nodes).toHaveLength(8);
      expect(whyRefused(doc), `artboard ${side}`).toBeNull();
    }
  });

  it("a drag or a resize that ends far beyond the limits", () => {
    const moved = updateNode(rectOnly(), "r", { x: 1e9, y: -1e9, ...foldScale(rectOnly().nodes[0], 1e6, 1e6) });
    expect(whyRefused(moved)).toBeNull();
    const text = updateNode(textOnly(), "t", { x: -1e9, ...foldScale(textOnly().nodes[0], 1e9, 1e9) });
    expect(whyRefused(text)).toBeNull();
  });

  it("every edit that is held back leaves a document the server still accepts", () => {
    // A value the editor refuses must not change anything, and what it keeps must be valid.
    for (const bad of [Number.NaN, Infinity, 1e12, "x", null, {}, []]) {
      for (const key of ["x", "y", "width", "height", "rotation", "opacity", "strokeWidth", "cornerRadius", "fontSize", "lineHeight", "letterSpacing"]) {
        expect(whyRefused(updateNode(textOnly(), "t", { [key]: bad } as NodePatch)), `${key} = ${String(bad)}`).toBeNull();
      }
    }
  });

  // A small seeded generator, so a failure can be repeated.
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const EXTREME: unknown[] = [Number.NaN, Infinity, -Infinity, 1e12, -1e12, 0, -1, 0.5, 1, 1e-9, 99_999, 100_001, 20_001, 3601, 5000, "x", "", null, undefined, true, {}, [], "#fff", "#ABCDEF", "Inter", "KoHo", "Comic", "600", "left", "asset-1", "protected", "text", "image"];
  // parentId is left out on purpose: the editor only checks its shape (nothing sets it yet), so a random one would dangle.
  const FIELDS = ["x", "y", "width", "height", "rotation", "opacity", "visible", "permission", "fill", "stroke", "strokeWidth", "cornerRadius", "shadow", "name", "text", "fontFamily", "fontSize", "fontStyle", "align", "lineHeight", "letterSpacing", "assetId", "fit", "foo", "__proto__"];
  const SCALES = [0, -2, Number.NaN, 1e9, 1e-9, 0.5, 2, Infinity, 1];

  // Parsing a whole document of hundreds of layers takes about 10 ms, so each step checks the layer it just changed
  // (alone, through the real schema) and every 25th step, and the last, checks the whole document for the rules that
  // span layers: how many there are, unique ids, the total text.
  it.each([1, 2, 3, 4, 5])("after every one of 1,500 random operations (seed %i)", { timeout: 120_000 }, (seed) => {
    const rnd = random(seed);
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
    const randomText = () => {
      const pieces = ["a", " ", "\n", "\r\n", "\t", "😀", "\u0000", "\ud83d", "日", "\u0001"];
      return Array.from({ length: Math.floor(rnd() * rnd() * 6500) }, () => pick(pieces)).join("");
    };
    const field = (key: string, value: unknown) => ({ [key]: value }) as NodePatch;
    const STEPS = 1500;
    let doc = createDocument();
    for (let step = 0; step < STEPS; step++) {
      const roll = rnd();
      const node = doc.nodes.length ? pick(doc.nodes) : undefined;
      let changed: CanvasNode | undefined; // the one layer this step touched
      if (roll < 0.35 || !node) {
        const kind = pick(["rect", "ellipse", "text", "image"] as const);
        const before = doc.nodes.length;
        doc = addNode(doc, kind === "text" ? createText(doc) : kind === "image" ? createImage(doc, { id: "asset-1", width: 1 + Math.floor(rnd() * 8192), height: 1 + Math.floor(rnd() * 8192), name: randomText().slice(0, 100) }) : createShape(doc, kind));
        if (doc.nodes.length > before) changed = doc.nodes[doc.nodes.length - 1];
      } else if (roll < 0.65) {
        const key = pick(FIELDS);
        doc = updateNode(doc, node.id, field(key, key === "text" || key === "name" ? randomText() : pick(EXTREME)));
        changed = doc.nodes.find((n) => n.id === node.id);
      } else if (roll < 0.8) {
        const many: Record<string, unknown> = {};
        for (let i = 0; i < 4; i++) many[pick(FIELDS)] = pick(EXTREME);
        doc = updateNode(doc, node.id, many as NodePatch);
        changed = doc.nodes.find((n) => n.id === node.id);
      } else if (roll < 0.9) {
        doc = updateNode(doc, node.id, { x: pick(EXTREME) as number, y: pick(EXTREME) as number, ...foldScale(node, pick(SCALES), pick(SCALES)) });
        changed = doc.nodes.find((n) => n.id === node.id);
      } else if (roll < 0.95) {
        doc = moveNode(doc, node.id, pick(["up", "down", "top", "bottom"] as const));
      } else {
        doc = removeNode(doc, node.id);
      }
      const why = (changed ? whyRefused({ ...doc, nodes: [changed] }) : null) ?? (step % 25 === 24 || step === STEPS - 1 ? whyRefused(doc) : null);
      if (why) throw new Error(`step ${step} (seed ${seed}): the server would refuse this document: ${why}`);
    }
    expect(doc.nodes.length).toBeGreaterThan(0);
  });
});

describe("documentAssetIds", () => {
  it("lists each image's asset once", () => {
    const doc = sample();
    doc.nodes.push({ ...createImage(blank, { id: "asset-1", width: 5, height: 5 }), id: "i2" }, { ...createImage(blank, { id: "asset-2", width: 5, height: 5 }), id: "i3" });
    const parsed = canvasDocument.parse(doc);
    expect(documentAssetIds(parsed).sort()).toEqual(["asset-1", "asset-2"]);
    expect(documentAssetIds(canvasDocument.parse(blank))).toEqual([]);
  });
});

describe("design names", () => {
  const long = (n: number) => "x".repeat(n);
  const ok = (value: unknown) => designName.safeParse(value);

  it.each([
    ["x", "x"],
    ["  Spring sale  ", "Spring sale"],
    [long(ENGINE.designName.max), long(ENGINE.designName.max)],
    [`  ${long(ENGINE.designName.max)}  `, long(ENGINE.designName.max)], // the limit applies after trimming
    ["Rencana 日本語 😀", "Rencana 日本語 😀"],
    ["a  b", "a  b"], // inside a name nothing is collapsed
    ["trailing\n", "trailing"], // a line break at the end is trimmed like a space
  ])("accepts %j and stores %j", (input, stored) => {
    const parsed = ok(input);
    expect(parsed.success && parsed.data).toBe(stored);
  });

  it.each([
    ["empty", ""],
    ["only spaces", "   "],
    ["only a line break", "\n"],
    ["101 characters", "x".repeat(ENGINE.designName.max + 1)],
    ["a line break inside", "a\nb"],
    ["NUL", "\u0000"],
    ["a tab inside", "a\tb"],
    ["a C1 control", "a\u0085b"],
    ["an unpaired surrogate", "x\ud83d"],
    ["a number", 5],
    ["null", null],
    ["an array", ["x"]],
    ["an object", { name: "x" }],
  ])("refuses %s", (_label, value) => {
    expect(ok(value).success).toBe(false);
  });

  it("is the same rule on create and on save, with or without a name", () => {
    const document = BLANK_DOCUMENT;
    expect(createBody.safeParse({}).success).toBe(true);
    expect(createBody.safeParse({ name: "  A " })).toMatchObject({ success: true, data: { name: "A" } });
    expect(saveBody.safeParse({ version: 1, document }).success).toBe(true);
    expect(saveBody.safeParse({ version: 1, document, name: "  A " })).toMatchObject({ success: true, data: { name: "A" } });
    for (const name of ["", "   ", "x".repeat(101), "a\nb", null, 5]) {
      expect(createBody.safeParse({ name }).success, `create ${JSON.stringify(name)}`).toBe(false);
      expect(saveBody.safeParse({ version: 1, document, name }).success, `save ${JSON.stringify(name)}`).toBe(false);
    }
  });

  it("names the failing field so the API can answer INVALID_NAME or INVALID_DOCUMENT", () => {
    const badName = saveBody.safeParse({ version: 1, document: BLANK_DOCUMENT, name: "" });
    expect(!badName.success && firstIssue(badName.error)).toMatchObject({ field: "name", message: expect.stringContaining("name") });
    const badDoc = saveBody.safeParse({ version: 1, document: { ...BLANK_DOCUMENT, schemaVersion: 2 } });
    expect(!badDoc.success && firstIssue(badDoc.error)).toMatchObject({ field: "document", path: "document.schemaVersion" });
  });
});

describe("the request bodies", () => {
  const document = BLANK_DOCUMENT;
  it("take a whole, positive version and nothing extra", () => {
    expect(saveBody.safeParse({ version: 1, document }).success).toBe(true);
    for (const version of [0, -1, 1.5, "1", null, undefined, 2_000_000_001]) expect(saveBody.safeParse({ version, document }).success, String(version)).toBe(false);
    expect(saveBody.safeParse({ document }).success).toBe(false);
    expect(saveBody.safeParse({ version: 1 }).success).toBe(false);
    expect(saveBody.safeParse({ version: 1, document, kind: "instance" }).success).toBe(false); // the client never picks the kind
    expect(saveBody.safeParse({ version: 1, document, workspaceId: "other" }).success).toBe(false);
    expect(createBody.safeParse({ name: "A", kind: "instance" }).success).toBe(false);
    expect(saveBody.safeParse(undefined).success).toBe(false);
  });

  it("a publish names a version and nothing else: no document, manifest, number or author comes from the client", () => {
    expect(publishBody.safeParse({ version: 3 }).success).toBe(true);
    for (const version of [0, -1, 1.5, "3", null, undefined, 2_000_000_001]) expect(publishBody.safeParse({ version }).success, String(version)).toBe(false);
    for (const extra of [{ document: BLANK_DOCUMENT }, { manifest: { schemaVersion: 1, fields: [] } }, { number: 9 }, { designId: "x" }, { createdByUserId: "u" }, { workspaceId: "w" }, { kind: "template" }]) {
      expect(publishBody.safeParse({ version: 3, ...extra }).success, JSON.stringify(Object.keys(extra))).toBe(false);
    }
    expect(publishBody.safeParse({}).success).toBe(false);
    expect(publishBody.safeParse(undefined).success).toBe(false);
    expect(publishBody.safeParse(null).success).toBe(false);
  });

  it("an attach names a well-formed design id and nothing else", () => {
    expect(attachBody.safeParse({ designId: "clx1y2z3a0000abcd" }).success).toBe(true);
    for (const designId of ["", "a b", "a/b", "../x", "a\u0000b", "x".repeat(65), 5, null, undefined]) expect(attachBody.safeParse({ designId }).success, String(designId)).toBe(false);
    expect(attachBody.safeParse({ designId: "d1", templateId: "t1" }).success).toBe(false);
    expect(attachBody.safeParse({ designId: "d1", published: true }).success).toBe(false);
  });
});

// ── The field manifest (phase 4) ────────────────────────────────────────────

type Edit = Record<string, unknown>;
/** A design of the given layers; each is [id, type, change]. Layers are made by the editor's own factories. */
function design(...layers: Array<[string, "text" | "image" | "rect" | "group", Edit?]>) {
  const nodes = layers.map(([id, type, change]) => {
    const base = type === "text" ? createText(blank) : type === "image" ? createImage(blank, { id: "asset-1", width: 10, height: 10 }) : createShape(blank, type === "group" ? "rect" : type);
    return { ...base, id, name: `Layer ${id}`, ...(type === "group" ? { type: "group" } : {}), ...change } as unknown as CanvasNode;
  });
  return { ...blank, nodes } as CanvasDocument;
}
const ids = (m: { fields: Array<{ nodeId: string }> }) => m.fields.map((f) => f.nodeId);

describe("buildManifest: default deny", () => {
  it("lists only a text layer set to text and an image layer set to image, in paint order", () => {
    const doc = design(["a", "text", { permission: "text" }], ["b", "rect"], ["c", "image", { permission: "image" }], ["d", "text"], ["e", "image"], ["f", "text", { permission: "text" }]);
    const { manifest, hidden } = buildManifest(doc);
    expect(manifest).toEqual({
      schemaVersion: 1,
      fields: [
        { nodeId: "a", kind: "text" },
        { nodeId: "c", kind: "image" },
        { nodeId: "f", kind: "text" },
      ],
    });
    expect(hidden).toEqual([]);
  });

  it("an empty design, and a design with nothing editable, has an empty manifest (that is allowed)", () => {
    expect(buildManifest(blank).manifest).toEqual({ schemaVersion: 1, fields: [] });
    expect(buildManifest(design(["a", "text"], ["b", "rect"], ["c", "image"])).manifest.fields).toEqual([]);
  });

  it("shapes and groups are protected by absence, whatever they carry", () => {
    const doc = design(["r", "rect", { permission: "text" }], ["g", "group", { permission: "image" }]); // the schema refuses these; the manifest must not list them anyway
    expect(buildManifest(doc).manifest.fields).toEqual([]);
  });

  it("is deterministic and does not change its input", () => {
    const doc = design(["a", "text", { permission: "text" }], ["b", "image", { permission: "image" }]);
    const before = JSON.stringify(doc);
    expect(JSON.stringify(buildManifest(doc))).toBe(JSON.stringify(buildManifest(doc)));
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("follows the document, not a client: the same document always gives the same manifest", () => {
    const a = design(["a", "text", { permission: "text" }]);
    const b = design(["a", "text", { permission: "protected" }]);
    expect(ids(buildManifest(a).manifest)).toEqual(["a"]);
    expect(ids(buildManifest(b).manifest)).toEqual([]);
  });
});

describe("buildManifest: effective visibility", () => {
  it("an editable layer that is hidden itself is reported, not listed", () => {
    const { manifest, hidden } = buildManifest(design(["a", "text", { permission: "text", visible: false }], ["b", "text", { permission: "text" }]));
    expect(ids(manifest)).toEqual(["b"]);
    expect(hidden).toEqual([{ nodeId: "a", name: "Layer a", group: null }]);
  });

  it("an editable child of a hidden group is hidden, and the group is named", () => {
    const doc = design(["g", "group", { visible: false }], ["a", "text", { permission: "text", parentId: "g" }]);
    const { manifest, hidden } = buildManifest(doc);
    expect(manifest.fields).toEqual([]);
    expect(hidden).toEqual([{ nodeId: "a", name: "Layer a", group: "Layer g" }]);
  });

  it("a hidden grandparent hides a grandchild: the whole chain is checked", () => {
    const doc = design(["g1", "group", { visible: false }], ["g2", "group", { parentId: "g1" }], ["a", "image", { permission: "image", parentId: "g2" }]);
    const { manifest, hidden } = buildManifest(doc);
    expect(manifest.fields).toEqual([]);
    expect(hidden).toMatchObject([{ nodeId: "a", group: "Layer g1" }]);
  });

  it("a visible child of visible groups is listed", () => {
    const doc = design(["g1", "group"], ["g2", "group", { parentId: "g1" }], ["a", "text", { permission: "text", parentId: "g2" }]);
    expect(ids(buildManifest(doc).manifest)).toEqual(["a"]);
    expect(buildManifest(doc).hidden).toEqual([]);
  });

  it("a visible child of a hidden group next to a visible one: only the first is hidden", () => {
    const doc = design(["g", "group", { visible: false }], ["h", "group"], ["a", "text", { permission: "text", parentId: "g" }], ["b", "text", { permission: "text", parentId: "h" }]);
    const { manifest, hidden } = buildManifest(doc);
    expect(ids(manifest)).toEqual(["b"]);
    expect(hidden.map((x) => x.nodeId)).toEqual(["a"]);
  });

  it("hidden protected layers do not matter: only editable ones can block a publish", () => {
    const doc = design(["g", "group", { visible: false }], ["r", "rect", { parentId: "g" }], ["t", "text", { visible: false }]);
    expect(buildManifest(doc).hidden).toEqual([]);
  });

  it("a parent chain that cannot be followed fails closed (hidden), and the walk always ends", () => {
    const missing = design(["a", "text", { permission: "text", parentId: "nope" }]);
    expect(buildManifest(missing).hidden).toHaveLength(1);
    const loop = design(["g1", "group", { parentId: "g2" }], ["g2", "group", { parentId: "g1" }], ["a", "text", { permission: "text", parentId: "g1" }]); // the schema refuses a cycle; this must not hang
    expect(buildManifest(loop).hidden).toHaveLength(1);
  });

  it("the message names the layers (the first five, then a count)", () => {
    const one = hiddenMessage([{ nodeId: "a", name: "Title", group: null }]);
    expect(one).toContain('"Title" is editable but hidden');
    expect(hiddenMessage([{ nodeId: "a", name: "Title", group: "Hero" }])).toContain('"Title" is editable but hidden because its group "Hero" is hidden');
    const seven = hiddenMessage(Array.from({ length: 7 }, (_, i) => ({ nodeId: `n${i}`, name: `L${i}`, group: null })));
    expect(seven).toContain('"L4"');
    expect(seven).not.toContain('"L5"');
    expect(seven).toContain("and 2 more");
  });
});

describe("the engine and the server derive the same manifest (parity)", () => {
  const docs: Array<[string, CanvasDocument]> = [
    ["empty", blank],
    ["nothing editable", design(["a", "text"], ["b", "image"], ["c", "rect"])],
    ["editable and shown", design(["a", "text", { permission: "text" }], ["b", "image", { permission: "image" }], ["c", "rect"])],
    ["editable but hidden", design(["a", "text", { permission: "text", visible: false }], ["b", "image", { permission: "image" }])],
    ["hidden group", design(["g", "group", { visible: false }], ["a", "text", { permission: "text", parentId: "g" }], ["b", "image", { permission: "image" }])],
    ["hidden grandparent", design(["g1", "group", { visible: false }], ["g2", "group", { parentId: "g1" }], ["a", "image", { permission: "image", parentId: "g2" }])],
    ["visible nest", design(["g1", "group"], ["g2", "group", { parentId: "g1" }], ["a", "text", { permission: "text", parentId: "g2" }])],
    ["missing parent", design(["a", "text", { permission: "text", parentId: "nope" }])],
    ["a loop", design(["g1", "group", { parentId: "g2" }], ["g2", "group", { parentId: "g1" }], ["a", "text", { permission: "text", parentId: "g1" }])],
  ];
  it.each(docs)("%s", (_label, doc) => {
    const engine = editableLayers(doc);
    const server = buildManifest(doc);
    expect(server.manifest.fields).toEqual(engine.fields);
    expect(server.hidden).toEqual(engine.hidden);
  });

  it("a permission the editor sets is one the schema accepts, and the manifest lists it", () => {
    const withText = updateNode(addNode(createDocument(), { ...createText(createDocument()), id: "t" }), "t", { permission: "text" });
    expect(accepts(withText)).toBe(true);
    expect(buildManifest(canvasDocument.parse(withText)).manifest.fields).toEqual([{ nodeId: "t", kind: "text" }]);
    const withImage = updateNode(addNode(createDocument(), { ...createImage(createDocument(), { id: "asset-1", width: 4, height: 4 }), id: "i" }), "i", { permission: "image" });
    expect(accepts(withImage)).toBe(true);
    expect(buildManifest(canvasDocument.parse(withImage)).manifest.fields).toEqual([{ nodeId: "i", kind: "image" }]);
  });

  it("the editor and the schema both refuse a permission the layer's type cannot have", () => {
    const rectDoc = addNode(createDocument(), { ...createShape(createDocument(), "rect"), id: "r" });
    expect(updateNode(rectDoc, "r", { permission: "text" })).toBe(rectDoc);
    expect(accepts(withNode("r", { permission: "text" }))).toBe(false);
    expect(accepts(withNode("t", { permission: "image" }))).toBe(false);
    expect(accepts(withNode("i", { permission: "text" }))).toBe(false);
  });
});
