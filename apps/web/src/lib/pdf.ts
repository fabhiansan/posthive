// A single-page PDF that holds one JPEG. No dependency: the PDF a design export needs is a fixed, small structure
// (catalog, pages, one page, one DCTDecode image XObject, one content stream), and writing it here keeps the browser
// bundle free of a PDF library. The page is the design at 96 dpi, so a 1080x1350 design is 810x1012.5 pt.
//
// Only JPEG is wrapped: a PDF image needs a codec the PDF reader has. JPEG is built in (DCTDecode); PNG would need a
// Flate stream with predictors. The canvas export fills a JPEG's transparency with white, which is what a print page wants.

const PT_PER_PX = 72 / 96;

/** The page size in points, rounded to 0.01 so the MediaBox stays readable. */
const points = (px: number): number => Math.round(px * PT_PER_PX * 100) / 100;

/**
 * Wraps one JPEG in a one-page PDF of the same aspect ratio. `pxWidth`/`pxHeight` are the design's own pixels.
 * Throws when the JPEG is empty or the size is not a positive number: a malformed page is worse than no file.
 */
export async function jpegToPdf(jpeg: Blob, pxWidth: number, pxHeight: number): Promise<Blob> {
  if (!(pxWidth > 0) || !(pxHeight > 0)) throw new Error("The design has no size to export.");
  const image = new Uint8Array(await jpeg.arrayBuffer());
  if (image.length === 0) throw new Error("The design could not be drawn.");

  const w = points(pxWidth);
  const h = points(pxHeight);
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (part: Uint8Array | string) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (n: number, body: string) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };

  push("%PDF-1.4\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);

  // The image: its bytes are the stream, copied unchanged (never re-encoded here).
  offsets[4] = length;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${Math.round(pxWidth)} /Height ${Math.round(pxHeight)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`);
  push(image);
  push("\nendstream\nendobj\n");

  // The page content: scale the unit square to the page and draw the image.
  const content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;
  object(5, `<< /Length ${content.length} >>\nstream\n${content}endstream`);

  const xref = length;
  push("xref\n0 6\n0000000000 65535 f \n");
  for (let i = 1; i <= 5; i++) push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const part of chunks) {
    out.set(part, at);
    at += part.length;
  }
  return new Blob([out], { type: "application/pdf" });
}
