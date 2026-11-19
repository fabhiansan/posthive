/**
 * The path of a QR code's dark squares, from the matrix `qrcode` makes (row by row, 1 = dark). A run of dark squares in a
 * row is one rectangle, so the path is a few hundred short commands, not one per square.
 */
export function qrPath(data: ArrayLike<number>, size: number): string {
  const parts: string[] = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!data[y * size + x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < size && data[y * size + end]) end++;
      parts.push(`M${x} ${y}h${end - x}v1h-${end - x}z`);
      x = end;
    }
  }
  return parts.join("");
}
