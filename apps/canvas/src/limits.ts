/**
 * Every limit of a CanvasDocument, in one place. The editor clamps to these on every edit (document.ts),
 * the Inspector reads them for its fields, and the API enforces the same numbers with a strict schema
 * (apps/api/src/lib/canvas.ts). KEEP THE TWO IDENTICAL: apps/api/src/lib/canvas.test.ts fails when they drift.
 *
 * Plain data and no imports, so the web can read it through the engine and the API test can import it directly.
 */

const range = (min: number, max: number) => ({ min, max }) as const;

export const LIMITS = {
  /** Layers in one design. */
  nodes: 500,
  /**
   * Characters of text across all text layers. 500 layers of 5,000 characters would be 2.5 MB, more than the
   * API's 1 MB request limit allows, so a document inside every per-layer limit could still not be saved. At
   * 80,000 the worst valid document (control characters, which JSON writes as 6 bytes each) stays under it:
   * editor.test.ts builds that document and measures it.
   */
  totalText: 80_000,
  /** Width and height of the artboard, in whole pixels. */
  side: range(1, 8192),
  /** After trimming. Control characters are never allowed in a name. */
  designName: range(1, 100),
  nodeName: range(1, 80),
  /** A layer id, a parent id or an asset id. Nothing that could change a URL path, query or host. */
  id: /^[A-Za-z0-9_-]{1,64}$/,
  position: range(-100_000, 100_000),
  /** Width and height of a layer. A text layer's height follows its text but obeys the same bounds. */
  size: range(1, 20_000),
  rotation: range(-3600, 3600),
  opacity: range(0, 1),
  color: /^#[0-9A-Fa-f]{6}$/,
  strokeWidth: range(0, 500),
  cornerRadius: range(0, 20_000),
  shadow: { blur: range(0, 500), offset: range(-1000, 1000), opacity: range(0, 1) },
  text: {
    /** Characters in one text layer (UTF-16 units, the same count as a textarea's maxLength). */
    length: 5000,
    fontSize: range(1, 1000),
    lineHeight: range(0.5, 3),
    letterSpacing: range(-50, 200),
    // Only the faces the editor loads (web/src/lib/canvas.ts), because Konva does not redraw when a font arrives late.
    fonts: ["Inter", "KoHo"],
    weights: ["400", "600"],
    aligns: ["left", "center", "right"],
  },
  fits: ["cover", "contain"],
  /** Metadata for future import adapters. Never fetched or followed. */
  source: { kind: 40, ref: 200, importedAt: 40 },
} as const;

export type Limits = typeof LIMITS;
