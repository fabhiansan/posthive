// Canvas client helpers: editor fonts, and image assets (upload and private download). API calls and
// types for designs are added here as the persistence phases land.

import { apiFetch, assetUrl } from "./api";

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

/** What the API returns for an asset. `url` is a path on the API (never the web origin); the storage path is never sent. */
export interface CanvasAsset {
  id: string;
  width: number;
  height: number;
  url: string;
}

const MAX_ASSET_BYTES = 10_000_000;

/** Imports a PNG or SVG. The server checks the real content; this only spares an obviously too-large upload. */
export async function uploadCanvasAsset(file: File): Promise<CanvasAsset> {
  if (file.size > MAX_ASSET_BYTES) throw new Error("The file is larger than 10 MB.");
  const body = new FormData();
  body.append("file", file);
  return apiFetch<CanvasAsset>("/canvas/assets", { method: "POST", body });
}

async function fetchAssetBlob(url: string): Promise<Blob> {
  // A path like /canvas/assets/.. belongs to the API, which in production sits under /api. A bare relative
  // fetch would reach Next.js and 404, so it always goes through API_BASE (assetUrl).
  const get = () => fetch(assetUrl(url), { credentials: "include", cache: "no-store" });
  let res = await get();
  if (res.status === 401) {
    // The access token may just have expired: let the shared refresh run (through a JSON call), then retry once.
    await apiFetch("/auth/session").catch(() => {});
    res = await get();
  }
  if (!res.ok) throw new Error(res.status === 404 ? "This image no longer exists." : "The image could not be loaded.");
  return res.blob();
}

/**
 * Downloads a private asset with the person's cookies and decodes it into an image the stage can draw.
 * The bytes live in memory for this editor session only: nothing is cached by the browser (the API
 * answers no-store) or written to storage, so every open of the editor is authorized again. A blob URL
 * is same-origin to the page, so exporting a design never taints the canvas.
 */
export async function loadAsset(url: string): Promise<HTMLImageElement> {
  const blob = await fetchAssetBlob(url);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    return img;
  } catch {
    throw new Error("The image could not be read.");
  } finally {
    // Once decoded the element keeps its own pixels, so the blob can be released at once instead of on unmount.
    URL.revokeObjectURL(objectUrl);
  }
}
