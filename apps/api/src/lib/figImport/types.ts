import type { DecodeMetrics } from "./decoder.js";
import type { ImageFormat } from "./assets.js";

export interface FigPageSummary {
  id: string;
  name: string;
  frameCount: number;
}

export interface FigFrameSummary {
  id: string;
  pageId: string;
  name: string;
  width: number | null;
  height: number | null;
}

export interface FigAssetSummary {
  format: ImageFormat | null;
  bytes: number;
  width: number | null;
  height: number | null;
}

export interface FigInspection {
  fileName: string;
  metadata: {
    prelude: string;
    version: number;
    chunkCount: number;
    zipEntries: number;
    zipBytes: number;
    canvasBytes: number;
  };
  pages: FigPageSummary[];
  frames: FigFrameSummary[];
  nodeCount: number;
  assets: FigAssetSummary[];
  metrics: {
    schemaBytes: number;
    messageBytes: number;
    assetBytes: number;
    assetPixels: number;
    durationMs: number;
    decoder: DecodeMetrics;
  };
  warnings: string[];
}
