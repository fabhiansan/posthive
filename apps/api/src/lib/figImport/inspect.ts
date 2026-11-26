import { Worker } from "node:worker_threads";
import { FIG_LIMITS, FigError } from "./limits.js";
import type { FigInspection } from "./types.js";

let busy = false;

export function tryAcquireFigSlot(): (() => void) | null {
  if (busy) return null;
  busy = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    busy = false;
  };
}

const CODES = new Set(["FIG_INVALID", "FIG_LIMIT", "FIG_TOO_LARGE", "FIG_UNSUPPORTED", "FIG_WORKER_FAILED"]);

export function inspectFigWithWorker(filePath: string, fileName: string): Promise<FigInspection> {
  const dev = import.meta.url.endsWith(".ts");
  const entry = dev ? new URL("./worker.ts", import.meta.url) : new URL("./worker.js", import.meta.url);
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const mod = workerData.dev
        ? await (await import("tsx/esm/api")).tsImport(workerData.url, workerData.parentUrl)
        : await import(workerData.url);
      const result = await mod.inspectFigFile(workerData.filePath, workerData.fileName);
      parentPort.postMessage({ ok: true, result });
    })().catch((error) => parentPort.postMessage({
      ok: false,
      code: ${JSON.stringify([...CODES])}.includes(error && error.code) ? error.code : "FIG_WORKER_FAILED",
    }));
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { dev, url: entry.href, parentUrl: import.meta.url, filePath, fileName },
      resourceLimits: { maxOldGenerationSizeMb: FIG_LIMITS.workerHeapMb },
    });
    let settled = false;
    const finish = (error: FigError | null, result?: FigInspection) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(new FigError("FIG_TIMEOUT", 504)), FIG_LIMITS.parseTimeoutMs);
    timer.unref();
    worker.once("message", (data: unknown) => {
      if (typeof data !== "object" || data === null) return finish(new FigError("FIG_WORKER_FAILED", 500));
      const message = data as { ok?: unknown; code?: unknown; result?: unknown };
      if (message.ok === true && typeof message.result === "object" && message.result !== null) finish(null, message.result as FigInspection);
      else if (message.ok === false && typeof message.code === "string" && CODES.has(message.code)) {
        const code = message.code as FigError["code"];
        finish(new FigError(code, code === "FIG_TOO_LARGE" ? 413 : code === "FIG_WORKER_FAILED" ? 500 : 422));
      } else finish(new FigError("FIG_WORKER_FAILED", 500));
    });
    worker.once("error", () => finish(new FigError("FIG_WORKER_FAILED", 500)));
    worker.once("exit", (code) => {
      if (!settled) finish(new FigError(code === 0 ? "FIG_WORKER_FAILED" : "FIG_WORKER_FAILED", 500));
    });
  });
}
