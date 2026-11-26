/**
 * Posthive Canvas image assets: what may be imported, and how it is delivered.
 *
 * PNG and SVG only. The type is read from the bytes, never from the file name or mimetype.
 *   - PNG: checked, then re-encoded losslessly (drops metadata and polyglot tails).
 *   - SVG: parsed (never fetching anything), checked against an element and attribute ALLOWLIST with
 *     closed value grammars, rebuilt from only the allowed tree, then rasterized to one PNG. sharp
 *     never sees the uploaded bytes. Anything not on the list is rejected by name, not stripped.
 *
 * What this means for the editor: an SVG becomes ONE raster image layer, at most 3072px on its long
 * edge. Shapes, colours and text inside it are not editable. Scaling it past its raster size, or
 * exporting at 2x when it covers more than about 1536px, softens it. CSS (<style>, style="") is not
 * supported in v1: re-export with presentation attributes, or as PNG. Real files are the user's to try.
 *
 * Files live under the private folder below, which the /uploads/ static route must refuse
 * (allowUploadPath), and are only delivered by GET /canvas/assets/:id/content.
 */
import type { FastifyStaticOptions } from "@fastify/static";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { LocalDiskStorage, type StorageAdapter } from "./storage.js";
import { MAX_IMAGE_PIXELS as MAX_PIXELS, MAX_IMAGE_SIDE as MAX_SIDE } from "./canvasImageBounds.js";

export const CANVAS_PRIVATE_DIR = ".canvas-private";
export const MAX_ASSET_BYTES = 10_000_000; // PNG limit, also the upload request cap
const MAX_SVG_BYTES = 1_000_000;
const RASTER_EDGE = 3072;
const MAX_DEPTH = 64;
const MAX_ELEMENTS = 10_000;
const MAX_USE = 100;
const MAX_EXPANDED = 50_000; // elements once every <use> is expanded; nested <use> multiplies past MAX_USE
const MAX_EMBEDDED_IMAGES = 50;
const MAX_SVG_SIZE = 100_000;

export class AssetRejected extends Error {}
const reject = (message: string, cause?: unknown) => new AssetRejected(message, { cause });

// ── Storage and static-route guards ─────────────────────────────────────────

/**
 * The privacy guarantee only holds on local disk, so every other adapter is refused until it is
 * added here on purpose (an allowlist of one).
 */
export function isPrivateAssetStorage(storage: StorageAdapter): boolean {
  return storage instanceof LocalDiskStorage;
}

/**
 * `allowedPath` for the public /uploads/ static route. @fastify/static serves dotfiles by default, so
 * this is the only thing keeping the private folder off the web. The path arrives URL-decoded once.
 * shortcut: Windows 8.3 short names (CANVAS~1) are not matched; production storage is on Linux.
 */
export function allowUploadPath(pathname: string): boolean {
  return !pathname.split(/[\\/]+/).some((segment) => segment.replace(/[. ]+$/, "").toLowerCase() === CANVAS_PRIVATE_DIR);
}

/** The public /uploads/ static route, with the private Canvas folder refused. index.ts registers exactly this. */
export const publicUploadsStatic = (root: string): FastifyStaticOptions => ({ root, prefix: "/uploads/", allowedPath: allowUploadPath });

// ── Entry point ─────────────────────────────────────────────────────────────

export interface ProcessedAsset {
  png: Buffer;
  width: number;
  height: number;
  sourceFormat: "png" | "svg";
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function processAsset(buf: Buffer): Promise<ProcessedAsset> {
  if (buf.subarray(0, 8).equals(PNG_MAGIC)) return processPng(buf);
  if (/^﻿?\s*</.test(buf.subarray(0, 256).toString("utf8")) || (buf[0] === 0x1f && buf[1] === 0x8b)) return processSvg(buf);
  throw reject("Only PNG and SVG files can be imported.");
}

async function loadSharp() {
  return (await import("sharp")).default;
}

async function processPng(buf: Buffer): Promise<ProcessedAsset> {
  if (buf.length > MAX_ASSET_BYTES) throw reject("The PNG is larger than 10 MB.");
  const sharp = await loadSharp();
  try {
    const image = sharp(buf, { limitInputPixels: MAX_PIXELS });
    const meta = await image.metadata();
    if (meta.format !== "png" || !meta.width || !meta.height) throw reject("The file is not a valid PNG.");
    if (meta.width > MAX_SIDE || meta.height > MAX_SIDE) throw reject(`The PNG is larger than ${MAX_SIDE}px on a side.`);
    const { data, info } = await image.png().toBuffer({ resolveWithObject: true });
    return { png: data, width: info.width, height: info.height, sourceFormat: "png" };
  } catch (err) {
    if (err instanceof AssetRejected) throw err;
    throw reject("The PNG could not be read. It may be damaged or too large (limit 40 megapixels).", err);
  }
}

async function processSvg(buf: Buffer): Promise<ProcessedAsset> {
  if (buf.length > MAX_SVG_BYTES) throw reject("The SVG is larger than 1 MB.");
  if (buf[0] === 0x1f && buf[1] === 0x8b) throw reject("Compressed SVG (.svgz) is not supported. Export an uncompressed SVG, or a PNG.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf); // strips a UTF-8 BOM
  } catch {
    throw reject("The SVG must be UTF-8 text.");
  }

  const clean = sanitizeSvg(text);
  const sharp = await loadSharp();
  try {
    // An embedded image can be a small file that decodes to a huge bitmap; look before rendering.
    for (const { bytes } of clean.embedded) {
      const meta = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata();
      if (!meta.width || !meta.height || meta.width > MAX_SIDE || meta.height > MAX_SIDE || meta.width * meta.height > MAX_PIXELS) {
        throw reject("An image embedded in the SVG is too large.");
      }
    }
    const density = Math.min(4800, Math.max(1, (72 * RASTER_EDGE) / Math.max(clean.width, clean.height)));
    const { data, info } = await sharp(Buffer.from(clean.svg), { density, limitInputPixels: MAX_PIXELS })
      .resize({ width: RASTER_EDGE, height: RASTER_EDGE, fit: "inside", withoutEnlargement: true })
      .png()
      .timeout({ seconds: 10 })
      .toBuffer({ resolveWithObject: true });
    return { png: data, width: info.width, height: info.height, sourceFormat: "svg" };
  } catch (err) {
    if (err instanceof AssetRejected) throw err;
    throw reject("The SVG could not be drawn. It may be too complex.", err);
  }
}

// ── SVG allowlist ───────────────────────────────────────────────────────────

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
// Editor metadata: inert, never emitted. Dropped (with its subtree) instead of rejected.
const EDITOR_NS = new Set([
  "http://www.inkscape.org/namespaces/inkscape",
  "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  "http://purl.org/dc/elements/1.1/",
  "http://creativecommons.org/ns#",
]);
const DECLARABLE_NS = new Set([SVG_NS, XLINK_NS, ...EDITOR_NS]);

const ELEMENTS = new Set(
  ("svg g defs symbol use title desc path rect circle ellipse line polyline polygon text tspan linearGradient radialGradient stop pattern " +
    "clipPath mask image filter feGaussianBlur feOffset feFlood feComposite feMerge feMergeNode feBlend feColorMatrix feDropShadow").split(" "),
);
const TEXT_ELEMENTS = new Set(["text", "tspan", "title", "desc"]);

const NUM = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const NUM_RE = new RegExp(`^${NUM}$`);
const LENGTH_RE = new RegExp(`^${NUM}(?:px|%)?$`);
const PX_RE = new RegExp(`^${NUM}(?:px)?$`);
const ID = String.raw`[A-Za-z0-9_][\w.:-]{0,99}`;
const ID_RE = new RegExp(`^${ID}$`);
const REF_RE = new RegExp(`^#(${ID})$`);
const URL_RE = new RegExp(`^url\\(#${ID}\\)$`);
const PAINT_URL_RE = new RegExp(`^url\\(#${ID}\\)(?:\\s+(\\S.{0,60}))?$`);
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOUR_ARG_RE = new RegExp(`^${NUM}(?:%|deg)?$`);
const PATH_TOKENS = new RegExp(`[MmLlHhVvCcSsQqTtAaZz]|${NUM}|[\\s,]+`, "g");
const TRANSFORM_FN = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)[\s,]*/y;
const TRANSFORM_ARGS: Record<string, number[]> = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] };
const DATA_IMAGE_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/;
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

type Check = (value: string) => boolean;

/** Numbers separated by spaces or commas, each within bounds. Tokenized, so there is no regex backtracking. */
function numbers(value: string, maxCount = 1000, maxAbs = 1e6): number[] | null {
  if (value.length > 200_000) return null;
  const tokens = value.trim().split(/[\s,]+/);
  if (tokens.length > maxCount) return null;
  const out: number[] = [];
  for (const token of tokens) {
    if (!NUM_RE.test(token)) return null;
    const n = Number(token);
    if (!Number.isFinite(n) || Math.abs(n) > maxAbs) return null;
    out.push(n);
  }
  return out;
}

const number: Check = (v) => v.length <= 40 && NUM_RE.test(v) && Math.abs(Number(v)) <= 1e6;
const length: Check = (v) => v.length <= 40 && LENGTH_RE.test(v) && Math.abs(parseFloat(v)) <= 1e6;
const oneOf = (...values: string[]): Check => {
  const set = new Set(values);
  return (v) => set.has(v);
};

const colour: Check = (v) => {
  if (v.length > 100) return false;
  if (HEX_RE.test(v) || /^[A-Za-z]{3,30}$/.test(v)) return true; // a colour name, none, currentColor
  const m = /^(?:rgb|rgba|hsl|hsla)\(([^()]*)\)$/i.exec(v);
  if (!m) return false;
  const args = m[1].trim().split(/[\s,/]+/);
  return (args.length === 3 || args.length === 4) && args.every((a) => COLOUR_ARG_RE.test(a));
};
const paint: Check = (v) => {
  if (v.length > 200) return false;
  const m = PAINT_URL_RE.exec(v);
  return m ? m[1] === undefined || colour(m[1]) : colour(v);
};
const ref: Check = (v) => v.length <= 120 && URL_RE.test(v);
const pathData: Check = (v) => v.length <= 500_000 && v.replace(PATH_TOKENS, "") === "";
const transform: Check = (v) => {
  const s = v.trim();
  if (s.length > 500) return false;
  let i = 0;
  while (i < s.length) {
    TRANSFORM_FN.lastIndex = i;
    const m = TRANSFORM_FN.exec(s);
    if (!m) return false;
    const args = numbers(m[2]);
    if (!args || !TRANSFORM_ARGS[m[1]].includes(args.length)) return false;
    i = TRANSFORM_FN.lastIndex;
  }
  return true;
};

const BLEND_MODES = "normal multiply screen darken lighten overlay color-dodge color-burn hard-light soft-light difference exclusion hue saturation color luminosity".split(" ");

// Presentation attributes only; a value must match its closed grammar, an unknown one is rejected.
const ATTRS: Record<string, Check> = Object.create(null);
const add = (names: string, check: Check) => names.split(" ").forEach((n) => (ATTRS[n] = check));
add("id", (v) => ID_RE.test(v));
add("class", (v) => /^[\w .:-]{0,200}$/.test(v));
add("version", oneOf("1.0", "1.1"));
add("x y width height cx cy r rx ry x1 y1 x2 y2 fx fy fr offset font-size stroke-width stroke-dashoffset", length);
add("fill stroke", paint);
add("stop-color flood-color color", colour);
add("opacity fill-opacity stroke-opacity stop-opacity flood-opacity stroke-miterlimit k1 k2 k3 k4", number);
add("clip-path mask filter", ref);
add("transform gradientTransform patternTransform", transform);
add("d", pathData);
add("points", (v) => { const n = numbers(v, 20_000); return !!n && n.length % 2 === 0; });
add("viewBox", (v) => { const n = numbers(v, 4); return n?.length === 4 && n[2] > 0 && n[3] > 0; });
add("preserveAspectRatio", (v) => /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:\s+(?:meet|slice))?$/.test(v));
add("stdDeviation", (v) => { const n = numbers(v, 2, 200); return !!n && n.every((x) => x >= 0); });
add("values", (v) => numbers(v, 20) !== null);
add("dx dy", (v) => numbers(v, 1000) !== null);
add("stroke-dasharray", (v) => v === "none" || numbers(v, 64) !== null);
add("letter-spacing word-spacing", (v) => v === "normal" || length(v));
add("font-family", (v) => v.length <= 200 && /^[\p{L}\p{N}\s,'"_-]*$/u.test(v));
add("font-weight", (v) => /^(?:normal|bold|bolder|lighter|[1-9]00)$/.test(v));
add("font-style", oneOf("normal", "italic", "oblique"));
add("text-anchor", oneOf("start", "middle", "end"));
add("text-decoration", (v) => /^(?:none|(?:underline|overline|line-through)(?:\s+(?:underline|overline|line-through)){0,2})$/.test(v));
add("fill-rule clip-rule", oneOf("nonzero", "evenodd"));
add("stroke-linecap", oneOf("butt", "round", "square"));
add("stroke-linejoin", oneOf("miter", "round", "bevel", "miter-clip", "arcs"));
add("color-interpolation-filters", oneOf("auto", "sRGB", "linearRGB"));
add("mode", oneOf(...BLEND_MODES));
add("type", oneOf("matrix", "saturate", "hueRotate", "luminanceToAlpha"));
add("operator", oneOf("over", "in", "out", "atop", "xor", "arithmetic"));
add("spreadMethod", oneOf("pad", "reflect", "repeat"));
add("gradientUnits patternUnits patternContentUnits clipPathUnits maskUnits maskContentUnits filterUnits primitiveUnits", oneOf("userSpaceOnUse", "objectBoundingBox"));
add("in in2 result", (v) => ID_RE.test(v));
add("overflow", oneOf("visible", "hidden", "auto", "scroll"));
add("visibility", oneOf("visible", "hidden", "collapse"));
add("display", oneOf("inline", "none"));

interface SvgNode {
  name: string;
  attrs: Array<[string, string]>;
  children: Array<SvgNode | string>;
}

export interface CleanSvg {
  svg: string;
  /** Intrinsic size in px, from width/height or the viewBox. */
  width: number;
  height: number;
  /** Raster images embedded as data URIs; the signature is already checked, the size is checked by the caller. */
  embedded: Array<{ kind: "png" | "jpeg"; bytes: Buffer }>;
}

const trunc = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);
const unsupported = (what: string) =>
  reject(`The SVG uses ${what}, which is not supported. Re-export it without that (for example with presentation attributes instead of CSS), or as a PNG.`);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Parses and checks an SVG, and returns a NEW svg built only from what was allowed. Throws AssetRejected naming the first problem. */
export function sanitizeSvg(source: string): CleanSvg {
  const parser = new SaxesParser({ xmlns: true });
  const stack: SvgNode[] = [];
  const ids = new Map<string, SvgNode>();
  const embedded: CleanSvg["embedded"] = [];
  const tree: { root: SvgNode | null } = { root: null }; // an object: TS cannot see assignments made inside the callbacks
  let elements = 0;
  let depth = 0;
  let dropping = 0; // > 0 while inside dropped editor metadata
  let uses = 0;

  parser.on("doctype", () => {
    throw reject("The SVG has a DOCTYPE, which is not allowed.");
  });
  parser.on("processinginstruction", () => {
    throw reject("The SVG contains a processing instruction, which is not allowed.");
  });

  parser.on("opentag", (tag: SaxesTagNS) => {
    if (++elements > MAX_ELEMENTS) throw reject(`The SVG has more than ${MAX_ELEMENTS} elements.`);
    if (++depth > MAX_DEPTH) throw reject(`The SVG is nested more than ${MAX_DEPTH} levels deep.`);

    if (tree.root === null) {
      if (tag.uri !== SVG_NS || tag.local !== "svg") throw reject(`The file is not an SVG: its first element is <${trunc(tag.name)}>.`);
    } else if (dropping > 0 || EDITOR_NS.has(tag.uri) || (tag.uri === SVG_NS && tag.local === "metadata")) {
      dropping++;
      return;
    } else if (tag.uri !== SVG_NS || !ELEMENTS.has(tag.local)) {
      throw unsupported(`<${trunc(tag.name)}>`);
    }
    if (tag.local === "use" && ++uses > MAX_USE) throw reject(`The SVG has more than ${MAX_USE} <use> elements.`);

    const el = tag.local;
    const attrs: Array<[string, string]> = [];
    for (const a of Object.values(tag.attributes)) {
      if (a.uri === XMLNS_NS) {
        if (a.name === "xmlns" ? a.value !== SVG_NS : !DECLARABLE_NS.has(a.value)) throw reject(`The SVG declares the namespace ${trunc(a.value)}, which is not supported.`);
        continue; // the clean svg declares its own
      }
      if (EDITOR_NS.has(a.uri)) continue;

      const label = `the attribute ${trunc(a.name)} on <${el}>`;
      if ((a.uri === "" || a.uri === XLINK_NS) && a.local === "href") {
        const target = REF_RE.test(a.value) ? true : el === "image" ? embeddedImage(a.value, embedded) : false;
        if (!target) throw reject(`The SVG has ${label} pointing outside the file, which is not allowed. Only #id references${el === "image" ? " and embedded PNG or JPEG images" : ""} are accepted.`);
        // Valid SVG may carry both href and xlink:href. Both passed the check above and one is enough; two would be invalid XML.
        if (!attrs.some(([k]) => k === "xlink:href")) attrs.push(["xlink:href", a.value]);
      } else if (a.uri === XML_NS && a.local === "space") {
        if (a.value !== "default" && a.value !== "preserve") throw reject(`The SVG has an unsupported value for ${label}.`);
        attrs.push(["xml:space", a.value]);
      } else if (a.uri === "" && ATTRS[a.local]) {
        if (!ATTRS[a.local](a.value)) throw reject(`The SVG has an unsupported value for ${label}.`);
        attrs.push([a.local, a.value]);
      } else {
        throw unsupported(label);
      }
    }
    if (attrs.length > 100) throw reject(`<${el}> has too many attributes.`);

    const node: SvgNode = { name: el, attrs, children: [] };
    const id = attrs.find(([k]) => k === "id")?.[1];
    if (id !== undefined) {
      if (ids.has(id)) throw reject(`The SVG uses the id "${trunc(id)}" more than once.`);
      ids.set(id, node);
    }
    stack.at(-1)?.children.push(node);
    stack.push(node);
    tree.root ??= node;
  });

  parser.on("closetag", () => {
    depth--;
    if (dropping > 0) dropping--;
    else stack.pop();
  });

  const onText = (text: string) => {
    const parent = stack.at(-1);
    if (dropping > 0 || !parent) return;
    if (TEXT_ELEMENTS.has(parent.name)) parent.children.push(text);
    else if (text.trim()) throw reject(`The SVG has text directly inside <${parent.name}>, which is not supported.`);
  };
  parser.on("text", onText);
  parser.on("cdata", onText);

  try {
    parser.write(source).close();
  } catch (err) {
    if (err instanceof AssetRejected) throw err;
    throw reject(`The SVG is not valid XML (${trunc((err as Error).message.split("\n")[0])}).`);
  }
  const svgRoot = tree.root;
  if (!svgRoot) throw reject("The file is not an SVG.");

  const size = intrinsicSize(svgRoot);
  if (!size) throw reject("The SVG has no size. Give it a viewBox, or a width and height in px.");
  checkUseExpansion(svgRoot, ids);

  return { svg: toXml(svgRoot, true), ...size, embedded };
}

/** A data:image/png|jpeg URI whose bytes really start like that format. */
function embeddedImage(value: string, out: CleanSvg["embedded"]): boolean {
  const m = DATA_IMAGE_RE.exec(value);
  if (!m || out.length >= MAX_EMBEDDED_IMAGES) return false;
  const bytes = Buffer.from(m[2], "base64");
  const kind = m[1] as "png" | "jpeg";
  if (!bytes.subarray(0, kind === "png" ? 8 : 3).equals(kind === "png" ? PNG_MAGIC : JPEG_MAGIC)) return false;
  out.push({ kind, bytes });
  return true;
}

function intrinsicSize(root: SvgNode): { width: number; height: number } | null {
  const attr = (name: string) => root.attrs.find(([k]) => k === name)?.[1];
  const px = (v?: string) => (v !== undefined && PX_RE.test(v) ? parseFloat(v) : undefined); // % has no size of its own
  let width = px(attr("width"));
  let height = px(attr("height"));
  const vb = attr("viewBox") ? numbers(attr("viewBox")!) : null;
  if (vb) {
    const [, , vw, vh] = vb;
    if (width && !height) height = (width * vh) / vw;
    else if (height && !width) width = (height * vw) / vh;
    else if (!width && !height) [width, height] = [vw, vh];
  }
  if (!width || !height || width <= 0 || height <= 0 || width > MAX_SVG_SIZE || height > MAX_SVG_SIZE) return null;
  return { width, height };
}

/** The element count once every <use> is expanded. Rejects loops and a nested <use> that fans out. */
function checkUseExpansion(root: SvgNode, ids: Map<string, SvgNode>): void {
  const memo = new Map<SvgNode, number>();
  const active = new Set<SvgNode>();
  const weight = (node: SvgNode): number => {
    const known = memo.get(node);
    if (known !== undefined) return known;
    if (active.has(node)) throw reject("The SVG has <use> elements that reference each other in a loop.");
    active.add(node);
    let w = 1;
    for (const child of node.children) if (typeof child !== "string") w += weight(child);
    if (node.name === "use") {
      const target = ids.get(node.attrs.find(([k]) => k === "xlink:href")?.[1].slice(1) ?? "");
      if (target) w += weight(target);
    }
    active.delete(node);
    if (w > MAX_EXPANDED) throw reject("The SVG repeats its elements through <use> too many times.");
    memo.set(node, w);
    return w;
  };
  weight(root);
}

function toXml(node: SvgNode, isRoot = false): string {
  const attrs = node.attrs.map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
  const ns = isRoot ? ` xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}"` : "";
  const inner = node.children.map((c) => (typeof c === "string" ? esc(c) : toXml(c))).join("");
  return inner ? `<${node.name}${ns}${attrs}>${inner}</${node.name}>` : `<${node.name}${ns}${attrs}/>`;
}
