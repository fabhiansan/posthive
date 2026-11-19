// The path a QR code is drawn with. A wrong path is a code no phone can scan, so the squares are checked against the matrix.
import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { qrPath } from "./qr";

/** Reads a path of this shape back into the set of dark squares it covers. */
function squaresOf(path: string): Set<string> {
  const out = new Set<string>();
  for (const [, x, y, w] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(w); i++) out.add(`${Number(x) + i},${y}`);
  }
  return out;
}

describe("qrPath", () => {
  it("one run of dark squares is one rectangle", () => {
    expect(qrPath([1, 1, 1, 0, 0, 0, 0, 0, 0], 3)).toBe("M0 0h3v1h-3z");
  });

  it("splits a row at every gap, and moves down a row", () => {
    // 1 0 1
    // 0 0 0
    // 0 1 1
    expect(qrPath([1, 0, 1, 0, 0, 0, 0, 1, 1], 3)).toBe("M0 0h1v1h-1zM2 0h1v1h-1zM1 2h2v1h-2z");
  });

  it("an empty matrix draws nothing", () => {
    expect(qrPath([0, 0, 0, 0], 2)).toBe("");
  });

  it("covers exactly the dark squares of a real code, no more and no less", () => {
    const qr = QRCode.create("otpauth://totp/Postly:a%40b.co?secret=JBSWY3DPEHPK3PXP&issuer=Postly", { errorCorrectionLevel: "M" });
    const { data, size } = qr.modules;
    const expected = new Set<string>();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (data[y * size + x]) expected.add(`${x},${y}`);
    expect(expected.size).toBeGreaterThan(300); // a real code, not an empty one
    expect(squaresOf(qrPath(data, size))).toEqual(expected);
  });
});
