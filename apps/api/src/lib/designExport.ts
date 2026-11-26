// The Studio export on a compose draft (content.canvasExport). One entry per post: a re-save replaces it, so the draft
// never collects duplicates. Only the addresses the client sent are read; the files themselves are checked against the
// Upload rows (lib/mediaDelete.ts), exactly like any other media.

import { isStoredUploadPath } from "./mediaUrl.js";

export type DesignExportFormat = "png" | "jpeg" | "pdf";

export interface DesignExportFile {
  format: DesignExportFormat;
  mediaUrl: string;
}

export interface DesignExport {
  instanceId: string;
  version: number;
  files: DesignExportFile[];
}

const EXT: Record<DesignExportFormat, readonly string[]> = {
  png: [".png"],
  jpeg: [".jpg", ".jpeg"],
  pdf: [".pdf"],
};

/** The extension is the only format evidence a stored upload carries; the upload route picks it from the content type. */
const hasFormatExtension = (format: DesignExportFormat, url: string): boolean => {
  const path = url.split(/[?#]/, 1)[0].toLowerCase();
  return EXT[format].some((ext) => path.endsWith(ext));
};

/** Why these files cannot be the export (null: fine). One file per format, each a stored upload with the format's extension. */
export function designExportProblem(files: readonly DesignExportFile[]): string | null {
  const seen = new Set<DesignExportFormat>();
  for (const file of files) {
    if (seen.has(file.format)) return `Only one ${file.format.toUpperCase()} file can be attached.`;
    seen.add(file.format);
    if (!isStoredUploadPath(file.mediaUrl)) return "A generated design must be a file this app stored.";
    if (!hasFormatExtension(file.format, file.mediaUrl)) return `The ${file.format.toUpperCase()} file does not have the right extension.`;
  }
  return null;
}

/** The stored export, or null for anything that is not exactly the shape the route writes (a stale or hand-written value). */
export function designExportOf(value: unknown): DesignExport | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.instanceId !== "string" || !v.instanceId) return null;
  if (typeof v.version !== "number" || !Number.isSafeInteger(v.version) || v.version < 1) return null;
  if (!Array.isArray(v.files) || v.files.length === 0) return null;
  const files: DesignExportFile[] = [];
  for (const entry of v.files) {
    if (typeof entry !== "object" || entry === null) return null;
    const f = entry as Record<string, unknown>;
    if (f.format !== "png" && f.format !== "jpeg" && f.format !== "pdf") return null;
    if (typeof f.mediaUrl !== "string" || !f.mediaUrl) return null;
    files.push({ format: f.format, mediaUrl: f.mediaUrl });
  }
  return { instanceId: v.instanceId, version: v.version, files };
}
