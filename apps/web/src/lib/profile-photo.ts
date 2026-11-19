// The checks the browser makes on a chosen photo before it is sent, with the same numbers and the same words as the API
// (apps/api/src/routes/profilePhoto.ts), which checks again: the browser's check saves a wait, the API's is the real one.

export const PHOTO_MAX_BYTES = 5_000_000;
export const PHOTO_MIN_SIDE = 400;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Why a chosen file cannot be the photo, in words for a person; null when it can (its pixels are checked next). */
export function photoFileProblem(file: { type: string; size: number }): string | null {
  if (!PHOTO_TYPES.includes(file.type)) return "That file isn't a JPG, PNG or WebP picture.";
  if (file.size > PHOTO_MAX_BYTES) return "The picture is larger than 5 MB.";
  return null;
}

/** Why a picture of this size cannot be the photo; null when it can. */
export function photoSizeProblem(width: number, height: number): string | null {
  return width < PHOTO_MIN_SIDE || height < PHOTO_MIN_SIDE ? `The picture is smaller than ${PHOTO_MIN_SIDE} × ${PHOTO_MIN_SIDE} px. Use a bigger one.` : null;
}

/** The picture's size in pixels, read in the browser; null when the browser cannot read it as a picture. */
export async function readPhotoSize(file: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}
