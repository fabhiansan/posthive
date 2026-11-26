import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { inspectFigFile } from "../src/lib/figImport/worker.js";

const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), "../..");
const insideRepo = (value: string) => {
  const relative = path.relative(repo, path.resolve(value));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

async function measureOne(file: string) {
  const started = performance.now();
  const before = process.memoryUsage();
  try {
    const result = await inspectFigFile(file, path.basename(file));
    const after = process.memoryUsage();
    const resources = process.resourceUsage();
    console.log(JSON.stringify({
      ok: true,
      file: path.basename(file),
      inputBytes: result.metadata.zipBytes,
      parseMs: Math.round((performance.now() - started) * 100) / 100,
      peakRssBytes: resources.maxRSS * 1024,
      heapBeforeBytes: before.heapUsed,
      heapAfterBytes: after.heapUsed,
      rssAfterBytes: after.rss,
      nodeCount: result.nodeCount,
      pageCount: result.pages.length,
      frameCount: result.frames.length,
      assetCount: result.assets.length,
      schemaBytes: result.metrics.schemaBytes,
      messageBytes: result.metrics.messageBytes,
      decoder: result.metrics.decoder,
      warnings: result.warnings,
    }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, file: path.basename(file), code: (error as { code?: string }).code ?? "FIG_INVALID" }));
  }
}

function child(file: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--max-old-space-size=384", "--import", "tsx", script, "--one", file], { cwd: path.dirname(script), windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`Measurement timed out for ${path.basename(file)}`)); }, 60_000);
    proc.on("error", (error) => { clearTimeout(timer); reject(error); });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `Measurement exited ${code}`));
      try { resolve(JSON.parse(stdout.trim()) as Record<string, unknown>); } catch { reject(new Error("Measurement produced no JSON")); }
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  if (args[0] === "--one") return measureOne(args[1]);
  const [first, second] = args;
  if (!first || !second) throw new Error("Usage: tsx scripts/fig-measure.ts <external-fig-directory> <external-output.json>");
  const input = path.resolve(first);
  const output = path.resolve(second);
  if (insideRepo(input) || insideRepo(output)) throw new Error("Input and output must be outside the repository.");
  const files = (await fs.readdir(input)).filter((name) => name.toLowerCase().endsWith(".fig")).sort().map((name) => path.join(input, name));
  const results: Record<string, unknown>[] = [];
  for (const file of files) results.push(await child(file));
  await fs.writeFile(output, JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2));
  console.log(`Measured ${results.length} file(s); wrote ${output}`);
}

void main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
