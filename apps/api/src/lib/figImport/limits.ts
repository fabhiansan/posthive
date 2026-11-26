import { MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from "../canvasImageBounds.js";

export const FIG_LIMITS = {
  uploadBytes: 50_000_000,
  zipEntries: 2_000,
  zipEntryBytes: 64_000_000,
  zipTotalBytes: 192_000_000,
  canvasBytes: 50_000_000,
  chunks: 32,
  schemaBytes: 4_000_000,
  messageBytes: 16_000_000,
  nodes: 20_000,
  images: 300,
  imageBytes: 10_000_000,
  imageSide: MAX_IMAGE_SIDE,
  imagePixels: MAX_IMAGE_PIXELS,
  imageTotalPixels: 120_000_000,
  imageHeaderBytes: 65_536,
  arrayItems: 50_000,
  totalItems: 400_000,
  decodeOps: 40_000_000,
  decodeInvocations: 2_000_000,
  decodeDepth: 32,
  schemaDefinitions: 2_000,
  schemaFieldsPerDefinition: 1_000,
  schemaFields: 20_000,
  schemaName: 200,
  generatedJs: 8_000_000,
  parseTimeoutMs: 20_000,
  uploadTimeoutMs: 30_000,
  workerHeapMb: 384,
  stagingTtlMs: 60 * 60_000,
  inputSliceBytes: 4_096,
} as const;

export type FigErrorCode =
  | "FIG_INVALID"
  | "FIG_LIMIT"
  | "FIG_TOO_LARGE"
  | "FIG_BUSY"
  | "FIG_TIMEOUT"
  | "FIG_UPLOAD_TIMEOUT"
  | "FIG_WORKER_FAILED"
  | "FIG_UNSUPPORTED";

export class FigError extends Error {
  constructor(readonly code: FigErrorCode, readonly status = 422) {
    super(code);
    this.name = "FigError";
  }
}

export function fail(code: FigErrorCode, status?: number): never {
  throw new FigError(code, status);
}
