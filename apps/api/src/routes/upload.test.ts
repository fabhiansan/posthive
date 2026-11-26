// POST /upload gained one type for Path A: a generated PDF (LinkedIn). It is stored unchanged, never compressed,
// and recorded like any other upload so the media lock protocol can own and release it. A generated picture asks for
// the same treatment with ?keep=1: the bytes are stored as produced, so the extension, the MIME and the format the
// draft claims agree (the old path could turn a PNG into a .jpg and the attach then refused it).
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ created: [] as Array<{ url: string; userId: string }> }));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    upload: {
      create: vi.fn(async ({ data }: { data: { url: string; userId: string } }) => {
        h.created.push(data);
        return data;
      }),
    },
  },
}));
vi.mock("../lib/auth/withAuth.js", async () => {
  const real = await vi.importActual<typeof import("../lib/auth/withAuth.js")>("../lib/auth/withAuth.js");
  return { ...real, withAuth: async () => {}, getUser: () => ({ id: "u1" }) };
});

import { uploadRoutes } from "./upload.js";

const extOf = (mime: string) => (mime === "application/pdf" ? ".pdf" : mime === "image/jpeg" ? ".jpg" : ".png");
const storage = {
  upload: vi.fn(async (_buf: Buffer, mime: string) => `/uploads/a${extOf(mime)}`),
  getBuffer: vi.fn(),
  delete: vi.fn(),
  listFolder: vi.fn(),
  ownsUrl: () => true,
};

let app: FastifyInstance;
let png: Buffer;
let jpeg: Buffer;
beforeAll(async () => {
  const sharp = (await import("sharp")).default;
  png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#ffffff" } }).png().toBuffer();
  jpeg = await sharp(png).jpeg().toBuffer();
  app = Fastify();
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 4 } });
  await app.register(uploadRoutes, { storage } as never);
  await app.ready();
});
afterAll(async () => void (await app.close()));
beforeEach(() => {
  h.created = [];
  storage.upload.mockClear();
});

const send = (buf: Buffer, type: string, name: string, query = "") => {
  const b = "----upload";
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return app.inject({ method: "POST", url: `/upload${query}`, payload, headers: { "content-type": `multipart/form-data; boundary=${b}` } });
};

describe("POST /upload: a generated design", () => {
  it("keeps a PNG as PNG: .png URL, image/png, and the exact bytes", async () => {
    const res = await send(png, "image/png", "design.png", "?keep=1");
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ url: "/uploads/a.png", type: "image", mimeType: "image/png" });
    expect(storage.upload).toHaveBeenCalledWith(png, "image/png");
    expect(h.created).toEqual([{ url: "/uploads/a.png", userId: "u1" }]);
  });

  it("keeps a JPEG as JPEG: .jpg URL, image/jpeg", async () => {
    const res = await send(jpeg, "image/jpeg", "design.jpg", "?keep=1");
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ url: "/uploads/a.jpg", type: "image", mimeType: "image/jpeg" });
    expect(storage.upload).toHaveBeenCalledWith(jpeg, "image/jpeg");
  });

  it("stores a PDF unchanged, with its own extension, and reports application/pdf", async () => {
    const res = await send(Buffer.from("%PDF-1.4\n..."), "application/pdf", "design.pdf");
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ url: "/uploads/a.pdf", type: "pdf", mimeType: "application/pdf" });
    expect(storage.upload).toHaveBeenCalledWith(expect.any(Buffer), "application/pdf");
    expect(h.created).toEqual([{ url: "/uploads/a.pdf", userId: "u1" }]);
  });

  it("refuses a picture whose bytes are not the type it claims", async () => {
    const res = await send(jpeg, "image/png", "design.png", "?keep=1");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("That file is not a PNG image.");
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("refuses a PDF over 10 MB", async () => {
    const res = await send(Buffer.alloc(10_000_001), "application/pdf", "big.pdf");
    expect(res.statusCode).toBe(400);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("refuses a file that claims to be a PDF but does not start with the PDF signature", async () => {
    const res = await send(Buffer.from("hello"), "application/pdf", "a.pdf");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("That file is not a PDF.");
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("still refuses a file that is neither an image, a video nor a PDF", async () => {
    const res = await send(Buffer.from("hello"), "text/plain", "a.txt");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Unsupported file type");
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
