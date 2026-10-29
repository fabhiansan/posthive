import { prisma } from "./prisma.js";

// Design templates (docs/content-types.md): the reference design for one content type
// (Pillar + Category). Posts never copy template files; they only carry pillar/category.

/** Max size of a template design file (.fig). */
export const TEMPLATE_FILE_MAX_BYTES = 50 * 1024 * 1024;

export const TEMPLATE_SELECT = {
  id: true,
  name: true,
  pillar: true,
  category: true,
  fileUrl: true,
  fileName: true,
  fileSize: true,
  linkUrl: true,
  previewUrl: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Drops URLs still used by a design template or by a legacy template kit. Posts made
 * from a legacy kit share its design files, so post cleanup (delete, edit, after
 * publish, failed-job cleanup) must never remove them.
 */
export async function withoutTemplateMedia(urls: string[]): Promise<string[]> {
  if (!urls.length) return urls;
  const [templates, legacy] = await Promise.all([
    prisma.template.findMany({
      where: { OR: [{ fileUrl: { in: urls } }, { previewUrl: { in: urls } }] },
      select: { fileUrl: true, previewUrl: true },
    }),
    prisma.legacyTemplateMedia.findMany({ where: { url: { in: urls } }, select: { url: true } }),
  ]);
  const inUse = new Set(legacy.map((l) => l.url));
  for (const t of templates) {
    if (t.fileUrl) inUse.add(t.fileUrl);
    if (t.previewUrl) inUse.add(t.previewUrl);
  }
  return urls.filter((url) => !inUse.has(url));
}

/** Storage URLs are relative for local disk; API clients need absolute ones. */
export function absoluteUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = (process.env.PUBLIC_API_URL ?? process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`).replace(/\/$/, "");
  return `${base}${url}`;
}

type TemplateFiles = {
  fileUrl: string | null;
  fileName: string | null;
  fileSize: number | null;
  linkUrl: string | null;
  previewUrl: string | null;
};

/** The design reference returned by the public API and MCP (absolute URLs). */
export function designReference(t: TemplateFiles) {
  return {
    fileUrl: t.fileUrl ? absoluteUrl(t.fileUrl) : null,
    fileName: t.fileName,
    fileSize: t.fileSize,
    linkUrl: t.linkUrl,
    previewUrl: t.previewUrl ? absoluteUrl(t.previewUrl) : null,
  };
}

const FIG_MAGIC = Buffer.from("fig-kiwi");
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;

/** Compression method and data offset of a ZIP entry, read from the central directory. */
function zipEntry(buf: Buffer, name: string): { method: number; dataOffset: number } | null {
  // The end-of-central-directory record sits in the last 22 bytes plus an optional comment
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let end = buf.length - 22; end >= stop; end--) {
    if (buf.readUInt32LE(end) !== ZIP_END) continue;
    const count = buf.readUInt16LE(end + 10);
    let p = buf.readUInt32LE(end + 16);
    for (let n = 0; n < count && p + 46 <= buf.length; n++) {
      if (buf.readUInt32LE(p) !== ZIP_CENTRAL) return null;
      const method = buf.readUInt16LE(p + 10);
      const nameLen = buf.readUInt16LE(p + 28);
      const skip = 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
      if (buf.toString("utf8", p + 46, p + 46 + nameLen) === name) {
        const local = buf.readUInt32LE(p + 42);
        if (local + 30 > buf.length || buf.readUInt32LE(local) !== ZIP_LOCAL) return null;
        return { method, dataOffset: local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28) };
      }
      p += skip;
    }
    return null;
  }
  return null;
}

/**
 * True for a Figma design file: a .fig name and either the raw "fig-kiwi" format or a
 * ZIP archive holding canvas.fig (the current "Save local copy" format). Browsers send
 * no useful MIME type for .fig, so the bytes decide. FigJam/Slides canvases carry a
 * different magic and are rejected when the entry is stored uncompressed.
 */
export function isFigFile(fileName: string, buf: Buffer): boolean {
  if (!/\.fig$/i.test(fileName)) return false;
  if (buf.subarray(0, 8).equals(FIG_MAGIC)) return true;
  if (buf.length < 22 || buf.readUInt32LE(0) !== ZIP_LOCAL) return false;
  const canvas = zipEntry(buf, "canvas.fig");
  if (!canvas) return false;
  return canvas.method !== 0 || buf.subarray(canvas.dataOffset, canvas.dataOffset + 8).equals(FIG_MAGIC);
}
