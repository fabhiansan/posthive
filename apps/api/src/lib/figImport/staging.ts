import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIG_LIMITS, FigError, fail } from "./limits.js";

const active = new Set<string>();
let sweeping = false;
let cleanupStarted = false;

export function figStagingRoot(): string {
  return process.env.FIG_IMPORT_STAGING_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../uploads/.canvas-private/fig-imports");
}

export async function createFigStaging(): Promise<string> {
  const root = await fs.realpath(await fs.mkdir(figStagingRoot(), { recursive: true }).then(() => figStagingRoot()));
  const filePath = path.join(root, `${Date.now()}-${crypto.randomUUID()}.fig`);
  active.add(filePath); // before creation, so the TTL sweep cannot race an in-progress upload
  try {
    const handle = await fs.open(filePath, "wx");
    await handle.close();
    return filePath;
  } catch (error) {
    active.delete(filePath);
    throw error;
  }
}

export interface FigUploadStream {
  file: AsyncIterable<Uint8Array> & { destroy(error?: Error): unknown };
}

export async function saveFigUpload(upload: FigUploadStream, filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r+");
  let bytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    upload.file.destroy();
  }, FIG_LIMITS.uploadTimeoutMs);
  timer.unref();
  try {
    for await (const raw of upload.file) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > FIG_LIMITS.uploadBytes) fail("FIG_TOO_LARGE", 413);
      await handle.write(chunk);
    }
    if (timedOut) fail("FIG_UPLOAD_TIMEOUT", 408);
  } catch (error) {
    if (timedOut) fail("FIG_UPLOAD_TIMEOUT", 408);
    if (error instanceof FigError) throw error;
    if ((error as { statusCode?: number }).statusCode === 413) fail("FIG_TOO_LARGE", 413);
    fail("FIG_INVALID");
  } finally {
    clearTimeout(timer);
    await handle.close();
  }
}

export async function deleteFigStaging(filePath: string): Promise<void> {
  active.delete(filePath);
  await fs.rm(filePath, { force: true }).catch(() => {
    // The boot/interval TTL sweep is the backstop if this unlink fails.
  });
}

export async function sweepFigStaging(now = Date.now()): Promise<number> {
  if (sweeping) return 0;
  sweeping = true;
  let removed = 0;
  try {
    const configured = figStagingRoot();
    const root = await fs.realpath(configured).catch(() => configured);
    const names = await fs.readdir(root).catch(() => [] as string[]);
    for (const name of names) {
      const match = /^(\d+)-[a-f0-9-]+\.fig$/.exec(name);
      if (!match) continue;
      const filePath = path.join(root, name);
      if (active.has(filePath) || now - Number(match[1]) <= FIG_LIMITS.stagingTtlMs) continue;
      try {
        await fs.rm(filePath, { force: true });
        removed++;
      } catch {
        // A concurrent creator or a filesystem fault leaves it for the next sweep.
      }
    }
    return removed;
  } finally {
    sweeping = false;
  }
}

export function startFigStagingCleanup(): void {
  if (cleanupStarted) return;
  cleanupStarted = true;
  void sweepFigStaging();
  const timer = setInterval(() => void sweepFigStaging(), 60_000);
  timer.unref();
}
