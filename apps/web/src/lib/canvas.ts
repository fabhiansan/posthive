// Canvas client helpers: editor fonts, image assets (upload and private download), and saved designs.

import type { CanvasDocument } from "posthive-canvas"; // types only: Konva must stay out of server rendering
import { API_BASE, apiFetch } from "./api";

const FONT_TIMEOUT_MS = 10_000;
// The faces the Inspector offers (Inter and KoHo, Regular 400 and Semibold 600). Konva does not redraw
// when a font arrives late, so every face it can pick is loaded before the editor opens.
const FONT_FACES: Array<[weight: number, variable: string]> = [
  [400, "--font-inter"],
  [600, "--font-inter"],
  [400, "--font-koho"],
  [600, "--font-koho"],
];

/**
 * Loads the faces the editor draws text with. Next's font loader gives each family a generated
 * name, exposed on <html> as --font-inter / --font-koho, so the real name is read from there.
 * Rejects if a face fails to load or takes longer than 10s, so the loader can offer a retry.
 */
export async function loadEditorFonts(): Promise<void> {
  const root = getComputedStyle(document.documentElement);
  const loading = Promise.all(
    FONT_FACES.map(([weight, variable]) => {
      const family = root.getPropertyValue(variable).trim() || "sans-serif";
      return document.fonts.load(`${weight} 16px ${family}`);
    }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Fonts took too long to load")), FONT_TIMEOUT_MS);
  });
  try {
    await Promise.race([loading, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The real font-family behind each name the editor offers, for the Konva stage. */
export function editorFonts(): Record<string, string> {
  const root = getComputedStyle(document.documentElement);
  const family = (variable: string) => root.getPropertyValue(variable).trim() || "sans-serif";
  return { Inter: family("--font-inter"), KoHo: family("--font-koho") };
}

// ── Image assets ────────────────────────────────────────────────────────────

/**
 * What the API returns for an asset. The storage path is never sent. `url` is kept for other API clients, but the
 * editor does not read it: it loads an image from its id alone (see assetContentUrl), because an id is the only
 * thing a saved design can name.
 */
export interface CanvasAsset {
  id: string;
  width: number;
  height: number;
  url: string;
}

/** Same pattern as LIMITS.id in apps/canvas/src/limits.ts (the web reads the engine only through a dynamic import). lib/canvas.test.ts checks they match. */
export const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type AssetErrorCode = "INVALID_ID" | "BAD_API_BASE" | "NOT_FOUND" | "FAILED";

/** Why an image could not be loaded. `code` lets the editor tell a missing image from a broken setup or a bad connection. */
export class AssetLoadError extends Error {
  code: AssetErrorCode;
  constructor(code: AssetErrorCode, message: string) {
    super(message);
    this.name = "AssetLoadError";
    this.code = code;
  }
}

/**
 * The one address an asset's bytes can come from: `<API base>/canvas/assets/<id>/content`. Nothing stored in a
 * design can change where it points: the only stored value that reaches it is the id, which must match ASSET_ID
 * (no `/`, `.`, `?`, `#`, `%`, `\` or space, so it cannot alter the path, query or host), and the base is the
 * build-time API_BASE. The base must be an absolute http(s) URL: an empty or relative one would send the request
 * to the web origin (Next.js, not the API), so it is refused here instead of being sent anywhere. Trailing
 * slashes on the base are dropped, so `…/api/` cannot give `//canvas`. `base` is a parameter only so tests can vary it.
 */
export function assetContentUrl(assetId: string, base: string = API_BASE): string {
  if (typeof assetId !== "string" || !ASSET_ID.test(assetId)) throw new AssetLoadError("INVALID_ID", "This image reference is not valid.");
  const badBase = () => new AssetLoadError("BAD_API_BASE", "Images can't be loaded because the API address is not configured.");
  // The host must start right after "//": URL() would otherwise quietly repair "http:/x", "http:x" or "https:\\x" into a destination nobody wrote.
  if (typeof base !== "string" || !/^https?:\/\/[^\s/?#\\]/i.test(base) || /[\s?#\\]/.test(base)) throw badBase();
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw badBase();
  }
  if (url.username || url.password) throw badBase();
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/canvas/assets/${assetId}/content`;
}

const MAX_ASSET_BYTES = 10_000_000;

/** Imports a PNG or SVG. The server checks the real content; this only spares an obviously too-large upload. */
export async function uploadCanvasAsset(file: File): Promise<CanvasAsset> {
  if (file.size > MAX_ASSET_BYTES) throw new Error("The file is larger than 10 MB.");
  const body = new FormData();
  body.append("file", file);
  return apiFetch<CanvasAsset>("/canvas/assets", { method: "POST", body });
}

async function fetchAssetBlob(assetId: string): Promise<Blob> {
  // The id and the API address are checked here, before anything is sent. The address is the API's (which in
  // production sits under /api): a bare relative fetch would reach Next.js and 404.
  const url = assetContentUrl(assetId);
  const get = () => fetch(url, { credentials: "include", cache: "no-store" });
  let res: Response;
  try {
    res = await get();
    if (res.status === 401) {
      // The access token may just have expired: let the shared refresh run (through a JSON call), then retry once.
      await apiFetch("/auth/session").catch(() => {});
      res = await get();
    }
  } catch {
    throw new AssetLoadError("FAILED", "The image could not be loaded.");
  }
  if (res.status === 404) throw new AssetLoadError("NOT_FOUND", "This image no longer exists.");
  if (!res.ok) throw new AssetLoadError("FAILED", "The image could not be loaded.");
  try {
    return await res.blob();
  } catch {
    throw new AssetLoadError("FAILED", "The image could not be loaded.");
  }
}

/**
 * Downloads a private asset by its id, with the person's cookies, and decodes it into an image the stage can
 * draw. It takes an id and nothing else, and never a URL (see assetContentUrl). The bytes live in memory for
 * this editor session only: nothing is cached by the browser (the API answers no-store) or written to storage,
 * so every open of the editor is authorized again. A blob URL is same-origin to the page, so exporting a
 * design never taints the canvas.
 */
export async function loadAsset(assetId: string): Promise<HTMLImageElement> {
  const blob = await fetchAssetBlob(assetId);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    return img;
  } catch {
    throw new AssetLoadError("FAILED", "The image could not be read.");
  } finally {
    // Once decoded the element keeps its own pixels, so the blob can be released at once instead of on unmount.
    URL.revokeObjectURL(objectUrl);
  }
}

// ── Saved designs ───────────────────────────────────────────────────────────
// Designer only (the API refuses anyone else). A failed call throws what apiFetch throws: an Error with `status` and `data`.

/** A published, immutable revision of a design. */
export interface RevisionInfo {
  number: number;
  designVersion: number;
  createdAt: string;
}

export interface DesignSummary {
  id: string;
  name: string;
  version: number;
  updatedAt: string;
  /** The template this design is made for (null: not attached to one). */
  template: { id: string; category: string; published: boolean } | null;
  /** Its latest published revision (null: none yet). */
  latestRevision: RevisionInfo | null;
}

export interface Design extends DesignSummary {
  document: CanvasDocument;
}

/** The list shows at most this many designs (the API's cap). */
export const DESIGN_LIST_MAX = 200;

const designPath = (id: string) => `/canvas/designs/${encodeURIComponent(id)}`;

export const listDesigns = () => apiFetch<{ designs: DesignSummary[] }>("/canvas/designs");
export const createDesign = (name?: string) => apiFetch<{ design: DesignSummary }>("/canvas/designs", { method: "POST", body: JSON.stringify(name === undefined ? {} : { name }) });
export const getDesign = (id: string) => apiFetch<{ design: Design }>(designPath(id));
/** Saves the document (and the name, when it changed) on top of `version`. Answers with the new version, or 409 when `version` is no longer the stored one. */
export const saveDesign = (id: string, body: { version: number; document: CanvasDocument; name?: string }) =>
  apiFetch<{ version: number }>(designPath(id), { method: "PUT", body: JSON.stringify(body) });
export const deleteDesign = (id: string) => apiFetch<{ ok: true }>(designPath(id), { method: "DELETE" });

// ── Revisions and templates (phase 4) ───────────────────────────────────────
// Publishing a revision freezes the saved design and the layers Marketing may change. It does not make anything visible to
// Marketing: that is the template's own Publish. `version` is the one the editor last saved (a 409 VERSION_CONFLICT otherwise).
// Error codes the pages read from `error.data.code`: NO_CHANGES, INVALID_PUBLISH, UNKNOWN_ASSET, TEMPLATE_HAS_DESIGN,
// DESIGN_LINKED, DESIGN_NEEDS_REVISION, SOURCE_REQUIRED.
export const publishDesign = (id: string, version: number) =>
  apiFetch<{ revision: RevisionInfo }>(`${designPath(id)}/publish`, { method: "POST", body: JSON.stringify({ version }) });

const templateDesignPath = (templateId: string) => `/canvas/templates/${encodeURIComponent(templateId)}/design`;
/** Creates a blank design named after the template's category and attaches it, in one step on the server: if it fails, nothing is left behind. */
export const createDesignForTemplate = (templateId: string) =>
  apiFetch<{ design: { id: string; name: string; version: number } }>(templateDesignPath(templateId), { method: "POST", body: JSON.stringify({}) });
export const attachDesign = (templateId: string, designId: string) =>
  apiFetch<{ designId: string }>(templateDesignPath(templateId), { method: "PUT", body: JSON.stringify({ designId }) });
export const detachDesign = (templateId: string) => apiFetch<{ ok: true }>(templateDesignPath(templateId), { method: "DELETE" });
