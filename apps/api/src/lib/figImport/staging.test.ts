import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIG_LIMITS } from "./limits.js";
import { createFigStaging, deleteFigStaging, figStagingRoot, saveFigUpload, sweepFigStaging } from "./staging.js";

let dir: string;
let previous: string | undefined;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fig-staging-"));
  previous = process.env.FIG_IMPORT_STAGING_DIR;
  process.env.FIG_IMPORT_STAGING_DIR = dir;
});
afterEach(async () => {
  vi.useRealTimers();
  if (previous === undefined) delete process.env.FIG_IMPORT_STAGING_DIR;
  else process.env.FIG_IMPORT_STAGING_DIR = previous;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("private .fig staging", () => {
  it("keeps active uploads past the TTL and deletes them after release", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const staged = await createFigStaging();
    await fs.writeFile(staged, "upload");
    expect(path.dirname(staged)).toBe(await fs.realpath(dir));
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z").getTime() + FIG_LIMITS.stagingTtlMs + 1_000);
    expect(await sweepFigStaging()).toBe(0);
    await expect(fs.stat(staged)).resolves.toBeDefined();
    await deleteFigStaging(staged);
    expect(await sweepFigStaging()).toBe(0);
    await expect(fs.stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sweeps abandoned files using the timestamp in their name", async () => {
    const root = figStagingRoot();
    await fs.mkdir(root, { recursive: true });
    const old = path.join(root, `${Date.now() - FIG_LIMITS.stagingTtlMs - 1_000}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.fig`);
    const fresh = path.join(root, `${Date.now()}-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.fig`);
    await fs.writeFile(old, "old");
    await fs.writeFile(fresh, "fresh");
    expect(await sweepFigStaging()).toBe(1);
    await expect(fs.stat(old)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(fresh)).resolves.toBeDefined();
  });

  it("streams an upload to disk and refuses data above 50 MB", async () => {
    const staged = await createFigStaging();
    const chunk = new Uint8Array(1024);
    await saveFigUpload({ file: (async function* () { yield chunk; })(), destroy() {} }, staged);
    expect((await fs.stat(staged)).size).toBe(1024);
    await expect(saveFigUpload({
      file: (async function* () { yield new Uint8Array(FIG_LIMITS.uploadBytes + 1); })(),
      destroy() {},
    }, staged)).rejects.toMatchObject({ code: "FIG_TOO_LARGE" });
    await deleteFigStaging(staged);
  });
});
