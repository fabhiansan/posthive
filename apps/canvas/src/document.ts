/**
 * CanvasDocument v1: the engine-independent design document. Konva's stage JSON is never stored.
 * Paint order is array order (first = bottom). A node's x/y/rotation are those of its top-left corner.
 *
 * Phase 3 gives the API a strict zod schema for this shape. KEEP THE TWO IDENTICAL, the way the web's
 * contentTypes.ts mirrors the API's.
 *
 * All operations are pure: they return a new document and never change the one they are given.
 */

export const SCHEMA_VERSION = 1;
export const MAX_NODES = 500; // the server's limit; the editor stops here so a document stays saveable
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

/** Who may change a layer when Marketing edits a published design. Phase 2 always creates "protected". */
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
  // shortcut: "contain" is drawn like "cover" until Phase 5 (image replacement); nothing in Phase 2 creates it.
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

const side = (doc: CanvasDocument) => Math.round(Math.min(doc.width, doc.height) * 0.3);

export function createShape(doc: CanvasDocument, type: "rect" | "ellipse"): RectNode | EllipseNode {
  const s = side(doc);
  return { ...base(doc, type, s, s), type, fill: "#FFD43B" };
}

export function estimateTextHeight(node: Pick<TextNode, "text" | "fontSize" | "lineHeight">): number {
  // shortcut: counts only the line breaks you type, not wrapping; Konva wraps by itself, and nothing reads this height yet.
  return round2(node.fontSize * node.lineHeight * Math.max(1, node.text.split("\n").length));
}

export function createText(doc: CanvasDocument): TextNode {
  const text = { text: "Your text here", fontSize: 72, lineHeight: 1.2 };
  const width = Math.round(doc.width * 0.6);
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
  const scale = Math.min((doc.width * 0.6) / asset.width, (doc.height * 0.6) / asset.height);
  const width = Math.max(1, Math.round(asset.width * scale));
  const height = Math.max(1, Math.round(asset.height * scale));
  const node: ImageNode = { ...base(doc, "image", width, height), type: "image", assetId: asset.id, fit: "cover" };
  if (asset.name) node.name = asset.name.slice(0, 80);
  return node;
}

export function addNode(doc: CanvasDocument, node: CanvasNode): CanvasDocument {
  if (doc.nodes.length >= MAX_NODES) return doc;
  return { ...doc, nodes: [...doc.nodes, node] };
}

/** Returns the same document when the patch changes nothing, so a no-op never becomes an undo step. */
export function updateNode(doc: CanvasDocument, id: string, patch: NodePatch): CanvasDocument {
  const current = nodeById(doc, id);
  if (!current) return doc;
  const stored = current as unknown as Record<string, unknown>;
  if (!(Object.keys(patch) as Array<keyof NodePatch>).some((k) => stored[k] !== patch[k])) return doc;

  const next = { ...current, ...patch } as CanvasNode;
  if (next.type === "text" && ("text" in patch || "fontSize" in patch || "lineHeight" in patch)) next.height = estimateTextHeight(next);
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

const MIN_SIZE = 1;

/**
 * Turns the scale Konva leaves on a node after a resize into real size, so a node is never stored scaled.
 * Text keeps its box width and grows or shrinks its font with the vertical scale; the editor only offers
 * text the side handles (scale x only) and proportional corners (equal scales).
 */
export function foldScale(node: CanvasNode, scaleX: number, scaleY: number): NodePatch {
  if (node.type === "text") {
    return {
      width: Math.max(MIN_SIZE, round2(node.width * scaleX)),
      fontSize: clamp(round2(node.fontSize * scaleY), 1, 1000),
    };
  }
  return { width: Math.max(MIN_SIZE, round2(node.width * scaleX)), height: Math.max(MIN_SIZE, round2(node.height * scaleY)) };
}

/** The part of an image to draw so it fills a box of the given size without distortion, centered. */
export function coverCrop(imageWidth: number, imageHeight: number, boxWidth: number, boxHeight: number) {
  const scale = Math.max(boxWidth / imageWidth, boxHeight / imageHeight);
  const width = boxWidth / scale;
  const height = boxHeight / scale;
  return { x: (imageWidth - width) / 2, y: (imageHeight - height) / 2, width, height };
}
