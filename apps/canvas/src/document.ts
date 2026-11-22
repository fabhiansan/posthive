/**
 * CanvasDocument v1: the engine-independent design document. Konva's stage JSON is never stored.
 * Paint order is array order (first = bottom). A node's x/y/rotation are those of its top-left corner.
 *
 * The API holds a strict zod schema for this shape (apps/api/src/lib/canvas.ts). KEEP THE TWO IDENTICAL, the
 * way the web's contentTypes.ts mirrors the API's: every number they share lives in limits.ts, and a test
 * on the API side fails when they drift.
 *
 * All operations are pure: they return a new document and never change the one they are given. Every
 * change to a layer goes through updateNode, which holds each field to LIMITS, so the editor cannot
 * produce a document the server would refuse.
 */

import { LIMITS } from "./limits";

export const SCHEMA_VERSION = 1;
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

/** Who may change a layer when Marketing edits a published design. A new layer is "protected"; the designer sets the rest in the Inspector ("Marketing access"). */
export type Permission = "protected" | "text" | "image";

export interface Shadow {
  color: string;
  blur: number;
  offsetX: number;
  offsetY: number;
  opacity: number;
}

interface NodeBase {
  id: string;
  name: string;
  parentId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  permission: Permission;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  cornerRadius?: number;
  shadow?: Shadow;
}

export interface RectNode extends NodeBase {
  type: "rect";
}
export interface EllipseNode extends NodeBase {
  type: "ellipse";
}
export interface GroupNode extends NodeBase {
  type: "group";
}

export interface TextNode extends NodeBase {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  fontStyle: string; // a CSS font-weight
  align: "left" | "center" | "right";
  lineHeight: number;
  letterSpacing: number;
}

export interface ImageNode extends NodeBase {
  type: "image";
  assetId: string;
  // "contain" shows the whole image inside the layer's box (containCrop); "cover" fills the box and crops (coverCrop). The designer picks it
  // in the Inspector ("Fit"); Marketing cannot change it, so a replacement image keeps the fit the designer chose.
  fit: "cover" | "contain";
}

export type CanvasNode = RectNode | EllipseNode | TextNode | ImageNode | GroupNode;
export type NodeType = CanvasNode["type"];

export interface CanvasDocument {
  schemaVersion: 1;
  width: number;
  height: number;
  background: { color: string };
  nodes: CanvasNode[];
  /** Generic metadata for future import adapters. */
  source?: { kind: string; ref?: string; importedAt?: string };
}

type Editable<T> = Omit<T, "id" | "type">;
// Omit first, then intersect: TextNode & ImageNode alone have clashing `type` literals and collapse to never.
/** Any field a node may carry; used to change one or several of them at once. */
export type NodePatch = Partial<Editable<TextNode> & Editable<ImageNode>>;

export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

// Control characters (C0, DEL, C1) never belong in a name.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
// What cannot be stored at all: NUL (PostgreSQL jsonb refuses it) and unpaired surrogates (not valid UTF-8).
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Cuts to `max` UTF-16 units without leaving half an emoji at the end. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * A design or layer name: what cannot be stored is removed, control characters become spaces, the ends are
 * trimmed, and it is cut to `max`. Returns null when nothing is left. Names are the only strings the editor
 * trims; text content never is.
 */
export function cleanName(raw: string, max: number = LIMITS.nodeName.max): string | null {
  const name = cut(raw.replace(UNSTORABLE, "").replace(CONTROL, " ").trim(), max).trim();
  return name === "" ? null : name;
}

/**
 * Text content exactly as typed: spaces, tabs, blank lines and line endings all stay, and so does empty text.
 * Only what cannot be stored is removed, and the length cap is applied last.
 */
export function cleanText(raw: string, max: number = LIMITS.text.length): string {
  return cut(raw.replace(UNSTORABLE, ""), max);
}

/** Characters of text across the whole design. */
export const textTotal = (doc: CanvasDocument): number => doc.nodes.reduce((sum, n) => sum + (n.type === "text" ? n.text.length : 0), 0);

/**
 * How long this text layer's text may be: what it already holds plus what is left of the design's text
 * budget, never more than one layer may have, and never less than it holds now. So editing or shortening a
 * long text near the budget never cuts it, and the textarea's maxLength is this number.
 */
export function textRoom(doc: CanvasDocument, id: string): number {
  const node = nodeById(doc, id);
  if (node?.type !== "text") return 0;
  const current = node.text.length;
  const remaining = Math.max(0, LIMITS.totalText - textTotal(doc));
  return Math.max(current, Math.min(LIMITS.text.length, current + remaining));
}

/** A layer Marketing may change once the design is published, and what they may change in it. */
export interface EditableField {
  nodeId: string;
  kind: "text" | "image";
}

/** An editable layer that is not shown, so it cannot be published. `group` names the hidden group that hides it (null: the layer itself is hidden). */
export interface HiddenEditable {
  nodeId: string;
  name: string;
  group: string | null;
}

/**
 * The layers Marketing may change (a text layer set to "text", an image layer set to "image"), in paint order, and
 * the editable layers that are hidden. A layer is shown only if it and every group above it is visible, so an editable
 * child of a hidden group counts as hidden. Everything else, shapes and groups included, is protected by absence.
 *
 * MIRRORED by buildManifest in apps/api/src/lib/canvas.ts (the server derives the stored manifest from this same rule):
 * KEEP IDENTICAL; the API test compares the two.
 */
export function editableLayers(doc: CanvasDocument): { fields: EditableField[]; hidden: HiddenEditable[] } {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const fields: EditableField[] = [];
  const hidden: HiddenEditable[] = [];
  for (const n of doc.nodes) {
    const kind = n.type === "text" && n.permission === "text" ? "text" : n.type === "image" && n.permission === "image" ? "image" : null;
    if (!kind) continue;
    // null = shown. Otherwise the hiding group's name, or "" for the layer itself. A parent chain that is broken or never ends fails closed (hidden).
    let by: string | null = null;
    if (!n.visible) by = "";
    else {
      let at: CanvasNode = n;
      for (let steps = 0; at.parentId !== null; steps++) {
        const parent = byId.get(at.parentId);
        if (!parent || steps >= byId.size) {
          by = "";
          break;
        }
        if (!parent.visible) {
          by = parent.name;
          break;
        }
        at = parent;
      }
    }
    if (by === null) fields.push({ nodeId: n.id, kind });
    else hidden.push({ nodeId: n.id, name: n.name, group: by === "" ? null : by });
  }
  return { fields, hidden };
}

// ── Marketing's overrides (phase 5) ─────────────────────────────────────────
// A Marketing design is a published revision plus a list of overrides: the new text of a text layer, or the asset that
// replaces an image layer's image. The revision's manifest says which layers may be changed; everything else (position,
// size, rotation, style, typography, `fit`, structure) is out of reach, because an override can carry nothing but those two
// values. The effective document is composed here, in memory, each time it is drawn or exported, and never stored.

/** One changed field. */
export type OverrideEntry = { nodeId: string; text: string } | { nodeId: string; assetId: string };

/** The layers Marketing may change in one published revision (apps/api/src/lib/canvas.ts derives and stores it). */
export interface FieldManifest {
  schemaVersion: 1;
  fields: EditableField[];
}

const sameEntry = (a: OverrideEntry, b: OverrideEntry): boolean => a.nodeId === b.nodeId && ("text" in a ? "text" in b && a.text === b.text : "assetId" in b && a.assetId === b.assetId);

/** Two override lists hold the same entries in the same order. */
export const sameOverrides = (a: readonly OverrideEntry[], b: readonly OverrideEntry[]): boolean => a.length === b.length && a.every((x, i) => sameEntry(x, b[i]));

/**
 * The revision's document with the overrides applied: only `text` on a text layer and `assetId` on an image layer, and only
 * when the manifest lists that layer with that kind. An entry for anything else (a missing layer, a shape, a protected
 * layer, the wrong kind) is ignored, so even a damaged stored list cannot move or restyle a locked layer. Never changes
 * `base`; returns it itself when nothing applies. A layer's height is left alone: a text layer grows to its text when drawn.
 */
export function applyOverrides(base: CanvasDocument, manifest: FieldManifest, overrides: readonly OverrideEntry[]): CanvasDocument {
  if (overrides.length === 0) return base;
  const kinds = new Map(manifest.fields.map((f) => [f.nodeId, f.kind])); // Maps, not objects: "__proto__" must find nothing
  const entries = new Map(overrides.map((o) => [o.nodeId, o]));
  let changed = false;
  const nodes = base.nodes.map((n) => {
    const o = entries.get(n.id);
    const kind = kinds.get(n.id);
    if (!o) return n;
    if (n.type === "text" && kind === "text" && "text" in o && o.text !== n.text) {
      changed = true;
      return { ...n, text: o.text };
    }
    if (n.type === "image" && kind === "image" && "assetId" in o && o.assetId !== n.assetId) {
      changed = true;
      return { ...n, assetId: o.assetId };
    }
    return n;
  });
  return changed ? { ...base, nodes } : base;
}

/**
 * The normal form of an override list, the one the server stores: only valid entries (the layer is in the manifest, of that
 * kind and really of that type), one per layer (the last wins), none equal to the base value, in the manifest's order.
 * The editor only ever makes valid entries, so for those this agrees with the server's validateOverrides (a test checks).
 */
export function normalizeOverrides(base: CanvasDocument, manifest: FieldManifest, overrides: readonly OverrideEntry[]): OverrideEntry[] {
  const nodes = new Map(base.nodes.map((n) => [n.id, n]));
  const latest = new Map(overrides.map((o) => [o.nodeId, o]));
  const out: OverrideEntry[] = [];
  for (const field of manifest.fields) {
    const o = latest.get(field.nodeId);
    const n = nodes.get(field.nodeId);
    if (!o || !n) continue;
    if (field.kind === "text" && n.type === "text" && "text" in o && o.text !== n.text) out.push({ nodeId: n.id, text: o.text });
    else if (field.kind === "image" && n.type === "image" && "assetId" in o && o.assetId !== n.assetId) out.push({ nodeId: n.id, assetId: o.assetId });
  }
  return out;
}

/**
 * Sets one field and returns the new list, or the SAME list when nothing changes (so a no-op is never an undo step).
 * Text is kept exactly as typed, like a designer's, and cut to what the design's text budget leaves (textRoom), so the
 * server never refuses what the editor made. Setting a field back to its base value removes its override.
 */
export function setOverride(base: CanvasDocument, manifest: FieldManifest, overrides: readonly OverrideEntry[], entry: OverrideEntry): readonly OverrideEntry[] {
  const room = "text" in entry ? textRoom(applyOverrides(base, manifest, overrides), entry.nodeId) : 0;
  const next = "text" in entry ? { nodeId: entry.nodeId, text: cleanText(entry.text, room) } : entry;
  const list = normalizeOverrides(base, manifest, [...overrides.filter((o) => o.nodeId !== entry.nodeId), next]);
  return sameOverrides(list, overrides) ? overrides : list;
}

/** Puts one field back to the revision's value: the same list when it was not overridden. */
export const clearOverride = (overrides: readonly OverrideEntry[], nodeId: string): readonly OverrideEntry[] =>
  overrides.some((o) => o.nodeId === nodeId) ? overrides.filter((o) => o.nodeId !== nodeId) : overrides;

export function createDocument(): CanvasDocument {
  // A square social post.
  return { schemaVersion: SCHEMA_VERSION, width: 1080, height: 1080, background: { color: "#FFFFFF" }, nodes: [] };
}

export function newNodeId(): string {
  // randomUUID exists only in secure contexts (https, localhost); an http preview host falls back.
  return globalThis.crypto?.randomUUID?.() ?? `n${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function nodeById(doc: CanvasDocument, id: string | null): CanvasNode | undefined {
  return id === null ? undefined : doc.nodes.find((n) => n.id === id);
}

const LABEL: Record<NodeType, string> = { rect: "Rectangle", ellipse: "Ellipse", text: "Text", image: "Image", group: "Group" };

function nextName(doc: CanvasDocument, type: NodeType): string {
  const taken = new Set(doc.nodes.map((n) => n.name));
  for (let i = doc.nodes.filter((n) => n.type === type).length + 1; ; i++) {
    const name = `${LABEL[type]} ${i}`;
    if (!taken.has(name)) return name;
  }
}

const centered = (doc: CanvasDocument, width: number, height: number) => ({
  x: round2((doc.width - width) / 2),
  y: round2((doc.height - height) / 2),
});

const base = (doc: CanvasDocument, type: NodeType, width: number, height: number) => ({
  id: newNodeId(),
  name: nextName(doc, type),
  parentId: null,
  ...centered(doc, width, height),
  width,
  height,
  rotation: 0,
  opacity: 1,
  visible: true,
  permission: "protected" as const,
});

// At least 1px, so a tiny artboard still gets a layer the server accepts.
const side = (doc: CanvasDocument) => Math.max(LIMITS.size.min, Math.round(Math.min(doc.width, doc.height) * 0.3));

export function createShape(doc: CanvasDocument, type: "rect" | "ellipse"): RectNode | EllipseNode {
  const s = side(doc);
  return { ...base(doc, type, s, s), type, fill: "#FFD43B" };
}

export function estimateTextHeight(node: Pick<TextNode, "text" | "fontSize" | "lineHeight">): number {
  // shortcut: counts only the line breaks you type, not wrapping; Konva wraps by itself, and nothing reads this height yet.
  const height = round2(node.fontSize * node.lineHeight * Math.max(1, node.text.split("\n").length));
  return clamp(height, LIMITS.size.min, LIMITS.size.max); // 5,000 line breaks at 1000px would otherwise be 15 million
}

export function createText(doc: CanvasDocument): TextNode {
  const text = { text: "Your text here", fontSize: 72, lineHeight: 1.2 };
  const width = Math.max(LIMITS.size.min, Math.round(doc.width * 0.6));
  return {
    ...base(doc, "text", width, estimateTextHeight(text)),
    type: "text",
    ...text,
    fontFamily: "Inter",
    fontStyle: "600",
    align: "left",
    letterSpacing: 0,
    fill: "#282202",
  };
}

/** An image layer for an imported asset, shown as large as fits in 60% of the artboard, keeping its proportions. */
export function createImage(doc: CanvasDocument, asset: { id: string; width: number; height: number; name?: string }): ImageNode {
  const w = Math.max(1, asset.width);
  const h = Math.max(1, asset.height);
  const scale = Math.min((doc.width * 0.6) / w, (doc.height * 0.6) / h);
  const width = clamp(Math.round(w * scale), LIMITS.size.min, LIMITS.size.max);
  const height = clamp(Math.round(h * scale), LIMITS.size.min, LIMITS.size.max);
  const node: ImageNode = { ...base(doc, "image", width, height), type: "image", assetId: asset.id, fit: "cover" };
  const name = asset.name ? cleanName(asset.name) : null;
  if (name) node.name = name;
  return node;
}

/** Why this layer cannot be added, or null when it can. Ask before uploading or creating anything for it. */
export function canAdd(doc: CanvasDocument, node: CanvasNode): string | null {
  if (doc.nodes.length >= LIMITS.nodes) return `A design can have up to ${LIMITS.nodes} layers.`;
  if (node.type === "text" && textTotal(doc) + node.text.length > LIMITS.totalText) return "This design has reached its text limit.";
  return null;
}

export function addNode(doc: CanvasDocument, node: CanvasNode): CanvasDocument {
  return canAdd(doc, node) === null ? { ...doc, nodes: [...doc.nodes, node] } : doc;
}

// ── What a patch may change ─────────────────────────────────────────────────

const SKIP = Symbol("skip");
type Rule = (value: unknown) => unknown;

const range =
  ({ min, max }: { min: number; max: number }): Rule =>
  (v) =>
    typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : SKIP;
const oneOf =
  (list: readonly string[]): Rule =>
  (v) =>
    typeof v === "string" && list.includes(v) ? v : SKIP;
const optional =
  (rule: Rule): Rule =>
  (v) =>
    v === undefined ? undefined : rule(v); // undefined clears an optional field
const colour: Rule = (v) => (typeof v === "string" && LIMITS.color.test(v) ? v : SKIP);
const identifier: Rule = (v) => (typeof v === "string" && LIMITS.id.test(v) ? v : SKIP);
const shadow: Rule = (v) => {
  if (typeof v !== "object" || v === null) return SKIP;
  const s = v as Record<string, unknown>;
  const parts = [colour(s.color), range(LIMITS.shadow.blur)(s.blur), range(LIMITS.shadow.offset)(s.offsetX), range(LIMITS.shadow.offset)(s.offsetY), range(LIMITS.shadow.opacity)(s.opacity)];
  if (parts.includes(SKIP)) return SKIP;
  const [color, blur, offsetX, offsetY, opacity] = parts;
  return { color, blur, offsetX, offsetY, opacity };
};

// Maps, not objects: a key like "__proto__" must find no rule rather than a prototype.
const COMMON = new Map<string, Rule>(
  Object.entries({
    name: (v: unknown) => (typeof v === "string" ? (cleanName(v) ?? SKIP) : SKIP),
    // shortcut: only the shape is checked, not that the parent exists and is a group. Nothing in the editor sets it
    // (v1 has no grouping); check it when grouping is built.
    parentId: (v: unknown) => (v === null ? null : identifier(v)),
    x: range(LIMITS.position),
    y: range(LIMITS.position),
    width: range(LIMITS.size),
    height: range(LIMITS.size),
    rotation: range(LIMITS.rotation),
    opacity: range(LIMITS.opacity),
    visible: (v: unknown) => (typeof v === "boolean" ? v : SKIP),
    fill: optional(colour),
    stroke: optional(colour),
    strokeWidth: optional(range(LIMITS.strokeWidth)),
    cornerRadius: optional(range(LIMITS.cornerRadius)),
    shadow: optional(shadow),
  }),
);
const TEXT_ONLY = new Map<string, Rule>(
  Object.entries({
    fontFamily: oneOf(LIMITS.text.fonts),
    fontSize: range(LIMITS.text.fontSize),
    fontStyle: oneOf(LIMITS.text.weights),
    align: oneOf(LIMITS.text.aligns),
    lineHeight: range(LIMITS.text.lineHeight),
    letterSpacing: range(LIMITS.text.letterSpacing),
  }),
);
const IMAGE_ONLY = new Map<string, Rule>(Object.entries({ assetId: identifier, fit: oneOf(LIMITS.fits) }));

/**
 * Holds a patch to LIMITS and to what the layer's type has: a number must be finite and is clamped to its range;
 * a name is cleaned; text content is kept exactly (see cleanText) and cut to `textMax`; an unknown font, colour,
 * enum value, key or wrong type is dropped. Returns only what may be applied.
 */
export function limitPatch(node: CanvasNode, patch: NodePatch, textMax: number = LIMITS.text.length): NodePatch {
  const own = node.type === "text" ? TEXT_ONLY : node.type === "image" ? IMAGE_ONLY : null;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(patch)) {
    let value: unknown = SKIP;
    if (key === "text") {
      if (node.type === "text" && typeof raw === "string") value = cleanText(raw, textMax);
    } else if (key === "permission") {
      // "text" only on a text layer and "image" only on an image layer (the Inspector's "Marketing access" sets it, and offers only what fits).
      if (raw === "protected" || (raw === "text" && node.type === "text") || (raw === "image" && node.type === "image")) value = raw;
    } else {
      const rule = COMMON.get(key) ?? own?.get(key);
      if (rule) value = rule(raw);
    }
    if (value !== SKIP) out[key] = value;
  }
  return out as NodePatch;
}

/** Returns the same document when the patch changes nothing, so a no-op never becomes an undo step. */
export function updateNode(doc: CanvasDocument, id: string, patch: NodePatch): CanvasDocument {
  const current = nodeById(doc, id);
  if (!current) return doc;
  const clean = limitPatch(current, patch, textRoom(doc, id));
  const stored = current as unknown as Record<string, unknown>;
  const keys = Object.keys(clean) as Array<keyof NodePatch>;
  if (!keys.some((k) => stored[k] !== clean[k])) return doc;

  const next = { ...current, ...clean } as CanvasNode;
  for (const k of keys) if (clean[k] === undefined) delete (next as unknown as Record<string, unknown>)[k];
  if (next.type === "text" && ("text" in clean || "fontSize" in clean || "lineHeight" in clean)) next.height = estimateTextHeight(next);
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === id ? next : n)) };
}

/** Removes a layer and anything grouped under it. */
export function removeNode(doc: CanvasDocument, id: string): CanvasDocument {
  const gone = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of doc.nodes) {
      if (n.parentId !== null && gone.has(n.parentId) && !gone.has(n.id)) {
        gone.add(n.id);
        grew = true;
      }
    }
  }
  return doc.nodes.some((n) => gone.has(n.id)) ? { ...doc, nodes: doc.nodes.filter((n) => !gone.has(n.id)) } : doc;
}

export type MoveTo = "up" | "down" | "top" | "bottom";

/** Reorders a layer among its siblings. "up" moves it toward the front (the end of the array). */
export function moveNode(doc: CanvasDocument, id: string, to: MoveTo): CanvasDocument {
  const from = doc.nodes.findIndex((n) => n.id === id);
  if (from < 0) return doc;
  const parentId = doc.nodes[from].parentId;
  const siblings = doc.nodes.flatMap((n, i) => (n.parentId === parentId ? [i] : []));
  const at = siblings.indexOf(from);
  const target = to === "top" ? siblings.length - 1 : to === "bottom" ? 0 : clamp(at + (to === "up" ? 1 : -1), 0, siblings.length - 1);
  if (target === at) return doc;

  // Reorder the siblings, then put them back into the slots the siblings occupied: layers of other parents stay put.
  const order = siblings.map((i) => doc.nodes[i]);
  const [moved] = order.splice(at, 1);
  order.splice(target, 0, moved);
  const nodes = doc.nodes.slice();
  siblings.forEach((slot, i) => (nodes[slot] = order[i]));
  return { ...doc, nodes };
}

const finiteOr1 = (scale: number): number => (Number.isFinite(scale) ? scale : 1);

/**
 * Turns the scale Konva leaves on a node after a resize into real size, so a node is never stored scaled.
 * Text keeps its box width and grows or shrinks its font with the vertical scale; the editor only offers
 * text the side handles (scale x only) and proportional corners (equal scales). Sizes stay inside LIMITS.
 */
export function foldScale(node: CanvasNode, scaleX: number, scaleY: number): NodePatch {
  const sx = finiteOr1(scaleX);
  const sy = finiteOr1(scaleY);
  const width = clamp(round2(node.width * sx), LIMITS.size.min, LIMITS.size.max);
  if (node.type === "text") {
    return { width, fontSize: clamp(round2(node.fontSize * sy), LIMITS.text.fontSize.min, LIMITS.text.fontSize.max) };
  }
  return { width, height: clamp(round2(node.height * sy), LIMITS.size.min, LIMITS.size.max) };
}

/** The part of an image to draw so it fills a box of the given size without distortion, centered. */
export function coverCrop(imageWidth: number, imageHeight: number, boxWidth: number, boxHeight: number) {
  const scale = Math.max(boxWidth / imageWidth, boxHeight / imageHeight);
  const width = boxWidth / scale;
  const height = boxHeight / scale;
  return { x: (imageWidth - width) / 2, y: (imageHeight - height) / 2, width, height };
}

/**
 * The same, for `fit: "contain"`: the whole image, centered in the box, with empty bars on the sides it does not fill.
 * It is a crop rectangle that reaches BEYOND the image on those sides (a negative x or y, a width or height past the
 * image's): the canvas draws only the part that overlaps the image and shrinks the destination to match, so the layer's
 * own box (its hit area and selection) stays exactly the box.
 */
export function containCrop(imageWidth: number, imageHeight: number, boxWidth: number, boxHeight: number) {
  const scale = Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
  const width = boxWidth / scale;
  const height = boxHeight / scale;
  return { x: (imageWidth - width) / 2, y: (imageHeight - height) / 2, width, height };
}
