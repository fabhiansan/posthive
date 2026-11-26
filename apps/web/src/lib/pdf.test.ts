// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { jpegToPdf } from "./pdf";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

describe("jpegToPdf", () => {
  it("writes a one-page PDF that embeds the JPEG unchanged and whose xref points at every object", async () => {
    const pdf = await jpegToPdf(new Blob([JPEG], { type: "image/jpeg" }), 1080, 1350);
    expect(pdf.type).toBe("application/pdf");

    // latin1 keeps one character per byte, so every offset below is a real file offset
    const text = new TextDecoder("latin1").decode(new Uint8Array(await pdf.arrayBuffer()));
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);
    expect(text).toContain("/DCTDecode");
    expect(text).toContain("/MediaBox [0 0 810 1012.5]"); // 96 dpi -> 72 pt
    expect(text).toContain("/Width 1080");
    expect(text).toContain("/Height 1350");
    expect(text.includes("\xff\xd8\xff\xe0")).toBe(true); // the JPEG's own bytes, not a re-encode

    const startxref = Number(text.slice(text.lastIndexOf("startxref") + 9).trim().split("\n")[0]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((at, i) => expect(text.slice(at, at + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });

  it("refuses a design with no size or an empty image instead of writing a broken page", async () => {
    await expect(jpegToPdf(new Blob([JPEG]), 0, 100)).rejects.toThrow("no size");
    await expect(jpegToPdf(new Blob([]), 100, 100)).rejects.toThrow("could not be drawn");
  });
});
