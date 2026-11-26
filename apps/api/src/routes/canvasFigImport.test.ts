import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openFigCanvas, zipFig } from "../../test/figImportFixtures.js";

const h = vi.hoisted(() => ({ authed: true, role: "designer" as string | null }));
vi.mock("../lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../lib/auth/withAuth.js", () => ({
  withAuth: async (_req: unknown, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!h.authed) return reply.status(401).send({ error: "Unauthorized" });
  },
  getUser: () => ({ id: "user-1" }),
  getWorkspaceId: () => "ws-1",
  requireTemplateManagerRole: async () => h.role === "designer" ? null : { error: "Design team only", code: "FORBIDDEN" },
  requireContentEditorRole: async () => null,
}));

import { canvasRoutes } from "./canvas.js";
import { LocalDiskStorage } from "../lib/storage.js";
import { tryAcquireFigSlot } from "../lib/figImport/inspect.js";

let dir: string;
let staging: string;
let previous: string | undefined;
let app: FastifyInstance;
const valid = zipFig({ "canvas.fig": openFigCanvas() });

function upload(bytes: Buffer, filename = "sample.fig") {
  const boundary = "----figimporttest";
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/x-figma\r\n\r\n`);
  return { method: "POST" as const, url: "/canvas/imports/inspect", payload: Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fig-route-"));
  staging = path.join(dir, "staging");
  previous = process.env.FIG_IMPORT_STAGING_DIR;
  process.env.FIG_IMPORT_STAGING_DIR = staging;
  app = Fastify({ logger: false });
  await app.register(multipart);
  await app.register(canvasRoutes, { storage: new LocalDiskStorage(path.join(dir, "uploads")), gate: false } as never);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  if (previous === undefined) delete process.env.FIG_IMPORT_STAGING_DIR;
  else process.env.FIG_IMPORT_STAGING_DIR = previous;
  await fs.rm(dir, { recursive: true, force: true });
});
beforeEach(() => { h.authed = true; h.role = "designer"; });

describe("POST /canvas/imports/inspect", () => {
  it("authenticates, parses in the worker and removes private staging", async () => {
    const response = await app.inject(upload(valid));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ nodeCount: 4, metrics: { decoder: { invocations: expect.any(Number) } } });
    expect(response.body).not.toContain("PRIVATE TEXT MUST NOT ESCAPE");
    expect(await fs.readdir(staging)).toEqual([]);
  }, 30_000);

  it("refuses an unauthenticated request", async () => {
    h.authed = false;
    expect((await app.inject(upload(valid))).statusCode).toBe(401);
  });

  it("refuses a non-designer", async () => {
    h.role = "member";
    expect((await app.inject(upload(valid))).statusCode).toBe(403);
  });

  it("refuses a non-.fig filename", async () => {
    const response = await app.inject(upload(valid, "sample.zip"));
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("FIG_INVALID");
  });

  it("returns a sanitised invalid-file error", async () => {
    const response = await app.inject(upload(Buffer.from("not a zip")));
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "The file is not a valid supported .fig archive.", code: "FIG_INVALID" });
    expect(response.body).not.toContain("stack");
  }, 30_000);

  it("answers 503 with Retry-After while the global slot is held", async () => {
    const release = tryAcquireFigSlot();
    expect(release).not.toBeNull();
    try {
      const response = await app.inject(upload(valid));
      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("5");
      expect(response.json().code).toBe("FIG_BUSY");
    } finally {
      release!();
    }
  });

  it("refuses a multipart request with no file", async () => {
    const response = await app.inject({ method: "POST", url: "/canvas/imports/inspect", payload: "--x--\r\n", headers: { "content-type": "multipart/form-data; boundary=x" } });
    expect(response.statusCode).toBe(400);
  });
});
