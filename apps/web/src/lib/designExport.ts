// The Studio's saved export on a compose draft (content.canvasExport). One entry per post: a re-save replaces it, so
// a draft never collects duplicates. The files are stored uploads; a PDF is kept here only (it is not a publishable
// picture yet), while the image formats are also shown in the card's own generated section.

import { apiFetch } from "./api";

export type DesignExportFormat = "png" | "jpeg" | "pdf";

export interface DesignExportFile {
  format: DesignExportFormat;
  /** A stored upload path, as POST /upload returned it. */
  mediaUrl: string;
}

export interface DesignExport {
  /** The Canvas instance the export came from. */
  instanceId: string;
  /** The instance version that was exported. */
  version: number;
  files: DesignExportFile[];
}

export const DESIGN_EXPORT_CHANNEL = "ph-design-export";

const FORMATS: readonly DesignExportFormat[] = ["png", "jpeg", "pdf"];

/** What a post's channels need: LinkedIn a PDF, Instagram a JPEG, anything else (or no channel yet) a PNG. */
export function exportFormatsFor(platforms: readonly string[]): DesignExportFormat[] {
  const channels = new Set(platforms);
  const formats: DesignExportFormat[] = [];
  if (channels.has("linkedin")) formats.push("pdf");
  if (channels.has("instagram")) formats.push("jpeg");
  return formats.length > 0 ? formats : ["png"];
}

/** The stored export, or null for anything that is not exactly the shape the server writes. */
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
    if (typeof f.format !== "string" || !FORMATS.includes(f.format as DesignExportFormat)) return null;
    if (typeof f.mediaUrl !== "string" || !f.mediaUrl) return null;
    files.push({ format: f.format as DesignExportFormat, mediaUrl: f.mediaUrl });
  }
  return { instanceId: v.instanceId, version: v.version, files };
}

/**
 * The format a stored upload really has. The upload route may keep the bytes as produced (Path A asks it to with
 * `keep=1`), so this is what the attach payload must claim; never assume the format that was exported.
 */
export function formatFromMime(mimeType: unknown): DesignExportFormat | null {
  if (typeof mimeType !== "string") return null;
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpeg";
  if (mime === "application/pdf") return "pdf";
  return null;
}

/**
 * Stores one exported file through the existing upload route and returns the address AND the type the server stored.
 * `keep=1` asks the route not to re-encode a generated design, so a PNG stays `.png`/`image/png` (the old behaviour
 * could turn it into a `.jpg`, and the attach then refused the format it had asked for).
 */
export async function uploadDesignFile(blob: Blob, name: string): Promise<{ url: string; mimeType: string }> {
  const body = new FormData();
  body.append("file", blob, name);
  return apiFetch<{ url: string; mimeType: string }>("/upload?keep=1", { method: "POST", body });
}

/** Attaches the export to the draft. The server checks the post, the instance and every file. */
export function attachDesignExport(
  jobId: string,
  body: { instanceId: string; version: number; files: Array<{ format: DesignExportFormat; mediaUrl: string }> },
) {
  return apiFetch<{ canvasExport: DesignExport }>(`/jobs/${encodeURIComponent(jobId)}/design-export`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Removes the generated design from the draft (the files are released when nothing else uses them). */
export function clearDesignExport(jobId: string) {
  return apiFetch<{ ok: true }>(`/jobs/${encodeURIComponent(jobId)}/design-export`, { method: "DELETE" });
}

/**
 * Tells the compose tab, if it is still open, that the Studio saved. It only refreshes the export, never the form,
 * so unsaved fields stay. A browser without BroadcastChannel still refreshes when the tab gets focus.
 */
export function notifyDesignExportSaved(jobId: string): void {
  try {
    const channel = new BroadcastChannel(DESIGN_EXPORT_CHANNEL);
    channel.postMessage({ jobId });
    channel.close();
  } catch {
    // no BroadcastChannel: the focus refresh is the fallback
  }
}
