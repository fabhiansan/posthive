import { z } from "zod";

/**
 * The strict schema of a saved Canvas design (CanvasDocument v1), and the rules for a design's name.
 *
 * MIRRORS apps/canvas/src/limits.ts and document.ts. KEEP IDENTICAL, the way contentTypes.ts mirrors the web's:
 * API code cannot import from apps/canvas (the Docker build copies only apps/api), so the numbers are repeated
 * here, and canvas.test.ts (which can import it) fails when the two drift.
 *
 * What is stored is exactly what the client sent: this file validates and never rewrites. In particular text
 * content is never trimmed or normalized. Every object is strict, so a stray key (a `url`, an `href`) is refused:
 * a document can name an image only by its asset id.
 */

const range = (min: number, max: number) => ({ min, max }) as const;

export const LIMITS = {
  nodes: 500,
  totalText: 80_000,
  side: range(1, 8192),
  designName: range(1, 100),
  nodeName: range(1, 80),
  id: /^[A-Za-z0-9_-]{1,64}$/,
  position: range(-100_000, 100_000),
  size: range(1, 20_000),
  rotation: range(-3600, 3600),
  opacity: range(0, 1),
  color: /^#[0-9A-Fa-f]{6}$/,
  strokeWidth: range(0, 500),
  cornerRadius: range(0, 20_000),
  shadow: { blur: range(0, 500), offset: range(-1000, 1000), opacity: range(0, 1) },
  text: {
    length: 5000,
    fontSize: range(1, 1000),
    lineHeight: range(0.5, 3),
    letterSpacing: range(-50, 200),
    fonts: ["Inter", "KoHo"],
    weights: ["400", "600"],
    aligns: ["left", "center", "right"],
  },
  fits: ["cover", "contain"],
  source: { kind: 40, ref: 200, importedAt: 40 },
} as const;

// What cannot be stored: NUL (PostgreSQL jsonb refuses it) and unpaired surrogates (not valid UTF-8). Without this
// check the database would fail the save with a 500.
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const storable = (s: string) => !UNSTORABLE.test(s);

const number = ({ min, max }: { min: number; max: number }) => z.number().finite().min(min).max(max);
const identifier = z.string().regex(LIMITS.id, "Must be letters, digits, - or _ (1 to 64).");
const colour = z.string().regex(LIMITS.color, "Must be a #RRGGBB colour.");
const metadata = (max: number) => z.string().max(max).refine(storable, "Contains a character that cannot be stored.");

// A layer name: after trimming it is not empty, and it holds no control character. Checked, never changed.
const nodeName = z
  .string()
  .max(LIMITS.nodeName.max)
  .refine((s) => s.trim() !== "", "A layer needs a name.")
  .refine((s) => !CONTROL.test(s) && storable(s), "A layer name cannot contain control characters.");

const shadow = z
  .object({
    color: colour,
    blur: number(LIMITS.shadow.blur),
    offsetX: number(LIMITS.shadow.offset),
    offsetY: number(LIMITS.shadow.offset),
    opacity: number(LIMITS.shadow.opacity),
  })
  .strict();

const shape = {
  id: identifier,
  name: nodeName,
  parentId: identifier.nullable(),
  x: number(LIMITS.position),
  y: number(LIMITS.position),
  width: number(LIMITS.size),
  height: number(LIMITS.size),
  rotation: number(LIMITS.rotation),
  opacity: number(LIMITS.opacity),
  visible: z.boolean(),
  fill: colour.optional(),
  stroke: colour.optional(),
  strokeWidth: number(LIMITS.strokeWidth).optional(),
  cornerRadius: number(LIMITS.cornerRadius).optional(),
  shadow: shadow.optional(),
};

// "text" is a permission only a text layer may have, "image" only an image layer.
const protectedOnly = z.literal("protected");
const rect = z.object({ ...shape, type: z.literal("rect"), permission: protectedOnly }).strict();
const ellipse = z.object({ ...shape, type: z.literal("ellipse"), permission: protectedOnly }).strict();
const group = z.object({ ...shape, type: z.literal("group"), permission: protectedOnly }).strict();
const textNode = z
  .object({
    ...shape,
    type: z.literal("text"),
    permission: z.enum(["protected", "text"]),
    // Validated, never rewritten: spaces, tabs, line breaks and empty text are all accepted as they are.
    text: z.string().max(LIMITS.text.length).refine(storable, "Text contains a character that cannot be stored."),
    fontFamily: z.enum(LIMITS.text.fonts),
    fontSize: number(LIMITS.text.fontSize),
    fontStyle: z.enum(LIMITS.text.weights),
    align: z.enum(LIMITS.text.aligns),
    lineHeight: number(LIMITS.text.lineHeight),
    letterSpacing: number(LIMITS.text.letterSpacing),
  })
  .strict();
const imageNode = z
  .object({ ...shape, type: z.literal("image"), permission: z.enum(["protected", "image"]), assetId: identifier, fit: z.enum(LIMITS.fits) })
  .strict();

const node = z.discriminatedUnion("type", [rect, ellipse, group, textNode, imageNode]);

export const canvasDocument = z
  .object({
    schemaVersion: z.literal(1),
    width: z.number().int().min(LIMITS.side.min).max(LIMITS.side.max),
    height: z.number().int().min(LIMITS.side.min).max(LIMITS.side.max),
    background: z.object({ color: colour }).strict(),
    nodes: z.array(node).max(LIMITS.nodes),
    source: z
      .object({ kind: metadata(LIMITS.source.kind), ref: metadata(LIMITS.source.ref).optional(), importedAt: metadata(LIMITS.source.importedAt).optional() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const byId = new Map<string, (typeof doc.nodes)[number]>();
    let text = 0;
    doc.nodes.forEach((n, i) => {
      if (byId.has(n.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", i, "id"], message: "Layer ids must be unique." });
      byId.set(n.id, n);
      if (n.type === "text") text += n.text.length;
    });
    if (text > LIMITS.totalText) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes"], message: `A design can hold up to ${LIMITS.totalText} characters of text in all.` });

    doc.nodes.forEach((n, i) => {
      if (n.parentId === null) return;
      const parent = byId.get(n.parentId);
      if (!parent || parent.type !== "group") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", i, "parentId"], message: "A layer's parent must be a group in this design." });
        return;
      }
      // Walk up: a chain that returns to this layer (or never ends) is a cycle.
      let at: typeof n | undefined = parent;
      for (let steps = 0; at && at.parentId !== null; steps++) {
        at = byId.get(at.parentId);
        if (at === n || steps > doc.nodes.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", i, "parentId"], message: "Groups cannot contain themselves." });
          return;
        }
      }
    });
  });

export type CanvasDocumentJson = z.infer<typeof canvasDocument>;

/** What a new design starts as. Same as the editor's createDocument() (canvas.test.ts checks). */
export const BLANK_DOCUMENT: CanvasDocumentJson = { schemaVersion: 1, width: 1080, height: 1080, background: { color: "#FFFFFF" }, nodes: [] };

// ── Field manifest (phase 4) ────────────────────────────────────────────────

export interface ManifestField {
  nodeId: string;
  kind: "text" | "image";
}

/** The layers Marketing may change in one published revision. Default deny: a layer that is not listed is protected. */
export interface FieldManifest {
  schemaVersion: 1;
  fields: ManifestField[];
}

/** An editable layer that is not shown. `group` names the hidden group that hides it (null: the layer itself is hidden). */
export interface HiddenEditable {
  nodeId: string;
  name: string;
  group: string | null;
}

/**
 * Derives the manifest from the STORED document, and lists the editable layers that are hidden (the publish is refused
 * while there are any, so every listed field is shown). A layer is shown only if it and every group above it is visible.
 * A broken or endless parent chain fails closed (hidden). Deterministic: paint order. The client never supplies one.
 *
 * MIRRORS editableLayers in apps/canvas/src/document.ts. KEEP IDENTICAL; canvas.test.ts compares the two.
 */
export function buildManifest(doc: Pick<CanvasDocumentJson, "nodes">): { manifest: FieldManifest; hidden: HiddenEditable[] } {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const fields: ManifestField[] = [];
  const hidden: HiddenEditable[] = [];
  for (const n of doc.nodes) {
    const kind = n.type === "text" && n.permission === "text" ? "text" : n.type === "image" && n.permission === "image" ? "image" : null;
    if (!kind) continue;
    let by: string | null = null; // null = shown; the hiding group's name; "" = the layer itself (or a chain that cannot be followed)
    if (!n.visible) by = "";
    else {
      let at: (typeof doc.nodes)[number] = n;
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
  return { manifest: { schemaVersion: 1, fields }, hidden };
}

/** The message for a publish that is refused because editable layers are hidden: the first five by name, then a count. */
export function hiddenMessage(hidden: HiddenEditable[]): string {
  const shown = hidden.slice(0, 5).map((h) => (h.group === null ? `"${h.name}" is editable but hidden` : `"${h.name}" is editable but hidden because its group "${h.group}" is hidden`));
  const more = hidden.length > 5 ? `; and ${hidden.length - 5} more` : "";
  return `${shown.join("; ")}${more}. Show ${hidden.length === 1 ? "it" : "them"}, or set ${hidden.length === 1 ? "it" : "them"} to Protected, before publishing.`;
}

/** POST /canvas/designs/:id/publish. Only the version the editor last saved: the document, manifest, number and author are never sent. */
export const publishBody = z.object({ version: z.number().int().min(1).max(2_000_000_000) }).strict();

/** PUT /canvas/templates/:templateId/design. */
export const attachBody = z.object({ designId: identifier }).strict();

/** POST /canvas/templates/:templateId/design: no fields. The design is blank and named after the template's category, both decided by the server. */
export const createForTemplateBody = z.object({}).strict();

/** The assets a document draws, once each. */
export const documentAssetIds = (doc: CanvasDocumentJson): string[] => [...new Set(doc.nodes.flatMap((n) => (n.type === "image" ? [n.assetId] : [])))];

// ── Design name ─────────────────────────────────────────────────────────────

export const DEFAULT_DESIGN_NAME = "Untitled design";

/**
 * The one rule for a design's name, on create and on save: trimmed, then 1 to 100 characters, with no control
 * character (so no line break or tab inside it). Any other Unicode is fine and the length counts UTF-16 units,
 * the same as a browser's maxLength. Names are the only strings the server trims.
 */
export const designName = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(LIMITS.designName.min, "Give the design a name.")
      .max(LIMITS.designName.max, `A design name can have up to ${LIMITS.designName.max} characters.`)
      .refine((s) => !CONTROL.test(s) && storable(s), "A design name cannot contain control characters."),
  );

/** POST /canvas/designs. No name = "Untitled design". */
export const createBody = z.object({ name: designName.optional() }).strict();

/** PUT /canvas/designs/:id. No name = keep the stored one. */
export const saveBody = z
  .object({ version: z.number().int().min(1).max(2_000_000_000), document: canvasDocument, name: designName.optional() })
  .strict();

/** The first thing wrong with a body, as a short message (at most 200 characters) and the field it is about. Nothing of the client's data is echoed except the name of an unknown key. */
export function firstIssue(error: z.ZodError): { field: string; path: string; message: string } {
  const issue = error.issues[0];
  const path = issue.path.join(".");
  return { field: String(issue.path[0] ?? ""), path, message: `${path ? `${path}: ` : ""}${issue.message}`.slice(0, 200) };
}
