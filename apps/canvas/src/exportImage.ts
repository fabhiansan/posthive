import type Konva from "konva";
import type { CanvasDocument } from "./document";

export interface ExportOptions {
  format: "png" | "jpeg";
  /** 1 = the design's own size; 2 = double resolution. */
  multiplier: 1 | 2;
}

export class ExportError extends Error {}

// Browsers refuse canvases past about 16384px a side or 268 million pixels, and some phones allow far less.
const MAX_EXPORT_SIDE = 16_384;
const MAX_EXPORT_PIXELS = 100e6;

/**
 * Renders the design's rectangle to an image. The shadow around the artboard, the selection and the
 * Transformer are in `hide`, and never reach the file. The stage is put at scale 1 and position 0 for
 * the draw, so the output is exactly width x multiplier pixels whatever the zoom was, and it is put
 * back before anything is painted. Images are drawn from already-decoded elements, so the picture
 * is never tainted by another origin.
 */
export async function exportStage(
  stage: Konva.Stage,
  hide: Konva.Layer[],
  doc: CanvasDocument,
  images: ReadonlyMap<string, HTMLImageElement>,
  { format, multiplier }: ExportOptions,
): Promise<Blob> {
  const width = doc.width * multiplier;
  const height = doc.height * multiplier;
  if (width > MAX_EXPORT_SIDE || height > MAX_EXPORT_SIDE || width * height > MAX_EXPORT_PIXELS) {
    throw new ExportError(multiplier === 2 ? "This design is too large to export at 2x. Use 1x." : "This design is too large to export.");
  }
  if (doc.nodes.some((n) => n.type === "image" && n.visible && !images.has(n.assetId))) {
    throw new ExportError("Some images are still loading. Try again in a moment.");
  }
  // Text must be drawn with the real fonts, not a fallback that is replaced a moment later.
  await document.fonts.ready;

  const view = { scale: stage.scale(), position: stage.position() };
  const shown = hide.map((layer) => layer.visible());
  let drawn: HTMLCanvasElement;
  try {
    hide.forEach((layer) => layer.visible(false));
    stage.scale({ x: 1, y: 1 });
    stage.position({ x: 0, y: 0 });
    drawn = stage.toCanvas({ x: 0, y: 0, width: doc.width, height: doc.height, pixelRatio: multiplier });
  } finally {
    stage.scale(view.scale);
    stage.position(view.position);
    hide.forEach((layer, i) => layer.visible(shown[i]));
  }

  let out = drawn;
  if (format === "jpeg") {
    // JPEG has no transparency: anything see-through would turn black.
    out = document.createElement("canvas");
    out.width = drawn.width;
    out.height = drawn.height;
    const ctx = out.getContext("2d");
    if (!ctx) throw new ExportError("Your browser could not prepare the image.");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(drawn, 0, 0);
  }

  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, format === "png" ? "image/png" : "image/jpeg", 0.92));
  if (!blob) throw new ExportError("The image could not be created. Try 1x.");
  return blob;
}
