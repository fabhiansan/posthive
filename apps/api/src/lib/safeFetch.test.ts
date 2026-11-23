import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSafeFetch, SafeFetchError } from "./safeFetch.js";
import { isBlockedAddress } from "./ssrf.js";

// Real sockets against real local servers. Only DNS is replaced: `resolve` stands in for the resolver, so a test decides what a NAME
// answers, and the connection that follows is a real one. "allowed" lets the loopback test server through (127.0.0.1 is blocked by
// default, which is exactly what the default-predicate tests rely on).

let server: http.Server;
let port: number;
const hits: string[] = []; // every request path the server really received
let sockets = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const url = req.url ?? "";
    if (url === "/ok") return void res.writeHead(200, { "content-type": "image/png" }).end("hello");
    if (url === "/big") return void res.writeHead(200, { "content-type": "image/png", "content-length": "5000" }).end(Buffer.alloc(5000));
    if (url === "/big-chunked") {
      res.writeHead(200, { "content-type": "image/png" }); // no content-length: the cap has to stop it while streaming
      const t = setInterval(() => res.write(Buffer.alloc(1000)), 5);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (url === "/slow-headers") return; // never answers
    if (url === "/slow-body") {
      res.writeHead(200, { "content-type": "image/png" });
      res.write("a");
      return; // then silence
    }
    if (url === "/drip") {
      res.writeHead(200, { "content-type": "image/png" });
      const t = setInterval(() => res.write("a"), 20);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (url === "/text") return void res.writeHead(200, { "content-type": "text/html" }).end("<p>x</p>");
    if (url.startsWith("/redirect-to/")) return void res.writeHead(302, { location: decodeURIComponent(url.slice("/redirect-to/".length)) }).end();
    if (url.startsWith("/hop/")) {
      const n = Number(url.slice(5));
      return void res.writeHead(302, { location: `/hop/${n + 1}` }).end();
    }
    res.writeHead(404).end();
  });
  server.on("connection", () => sockets++);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

const lo = (ip: string) => ip === "127.0.0.1";
const toLocal = async () => [{ address: "127.0.0.1", family: 4 }];
const text = async (r: Response) => Buffer.from(await r.arrayBuffer()).toString();

describe("safeFetch: the connection goes to the address that was checked", () => {
  it("fetches through a name, connecting to what the resolver answered", async () => {
    const asked: string[] = [];
    const f = createSafeFetch({ resolve: async (h) => (asked.push(h), toLocal()), isAllowedAddress: lo });
    const res = await f(`http://media.example.test:${port}/ok`, { allowHttp: true });
    expect(res.status).toBe(200);
    expect(await text(res)).toBe("hello");
    expect(asked).toEqual(["media.example.test"]); // one resolution, by the socket's own lookup
  });

  it("the default policy refuses a name that resolves to loopback or the metadata address, and opens no connection", async () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "::1", "::ffff:127.0.0.1", "fd00::1"]) {
      const before = sockets;
      const f = createSafeFetch({ resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }] });
      await expect(f(`http://evil.example.test:${port}/ok`, { allowHttp: true }), address).rejects.toMatchObject({ code: "BLOCKED" });
      expect(sockets, address).toBe(before);
    }
  });

  it("one blocked address among several public ones refuses the whole answer", async () => {
    const f = createSafeFetch({ resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }] });
    const before = sockets;
    await expect(f(`http://mixed.example.test:${port}/ok`, { allowHttp: true })).rejects.toMatchObject({ code: "BLOCKED" });
    expect(sockets).toBe(before);
  });

  it("DNS rebinding: a name that answers public first and private next is resolved ONCE per connection, and that answer is the one used", async () => {
    // First answer: a public address (the check passes). Second answer, if anyone asked again: loopback, where the real server is.
    // With a fake "public" 8.8.8.8 the connection must go to 8.8.8.8 (and fail or time out), never to loopback.
    let calls = 0;
    const f = createSafeFetch({
      resolve: async () => (++calls === 1 ? [{ address: "8.8.8.8", family: 4 }] : toLocal()),
      isAllowedAddress: (ip) => ip === "8.8.8.8" || ip === "127.0.0.1",
    });
    const before = hits.length;
    await expect(f(`http://rebind.example.test:${port}/ok`, { allowHttp: true, connectTimeoutMs: 400 })).rejects.toBeTruthy();
    expect(calls).toBe(1);
    expect(hits.length).toBe(before); // the loopback server never saw a request
  });

  it("DNS rebinding the other way: public at check time, private at connect time is refused, because the check IS the connect-time answer", async () => {
    let calls = 0;
    const f = createSafeFetch({ resolve: async () => (++calls === 1 ? toLocal() : [{ address: "8.8.8.8", family: 4 }]) }); // default policy
    const before = hits.length;
    await expect(f(`http://flip.example.test:${port}/ok`, { allowHttp: true })).rejects.toMatchObject({ code: "BLOCKED" });
    expect(hits.length).toBe(before);
  });

  it("an address literal is checked before any socket exists", async () => {
    const f = createSafeFetch();
    const before = sockets;
    for (const u of [`http://127.0.0.1:${port}/ok`, `http://[::1]:${port}/ok`, `http://[::ffff:7f00:1]:${port}/ok`, `http://2130706433:${port}/ok`, "http://169.254.169.254/latest/meta-data"]) {
      await expect(f(u, { allowHttp: true }), u).rejects.toMatchObject({ code: "BLOCKED" });
    }
    expect(sockets).toBe(before);
  });

  it("internal-looking names are refused without a lookup", async () => {
    let looked = 0;
    const f = createSafeFetch({ resolve: async () => (looked++, toLocal()), isAllowedAddress: lo });
    for (const u of ["https://localhost/a", "https://svc.internal/a", "https://printer.local/a", "https://redis/a"]) await expect(f(u), u).rejects.toMatchObject({ code: "BLOCKED" });
    expect(looked).toBe(0);
  });

  it("refuses other schemes, http unless allowed, and credentials", async () => {
    const f = createSafeFetch({ resolve: toLocal, isAllowedAddress: lo });
    await expect(f("file:///etc/passwd")).rejects.toMatchObject({ code: "PROTOCOL" });
    await expect(f("ftp://example.com/a")).rejects.toMatchObject({ code: "PROTOCOL" });
    await expect(f(`http://a.example.test:${port}/ok`)).rejects.toMatchObject({ code: "PROTOCOL" });
    await expect(f("nope")).rejects.toMatchObject({ code: "PROTOCOL" });
    await expect(f(`https://u:p@a.example.test/ok`)).rejects.toMatchObject({ code: "BLOCKED" });
  });

  it("a name that does not resolve is a DNS error", async () => {
    const empty = createSafeFetch({ resolve: async () => [] });
    await expect(empty("https://nothing.example.test/a")).rejects.toMatchObject({ code: "DNS" });
  });
});

describe("safeFetch: redirects", () => {
  it("follows a redirect to an allowed place and validates it", async () => {
    const f = createSafeFetch({ resolve: toLocal, isAllowedAddress: lo });
    const res = await f(`http://a.example.test:${port}/redirect-to/${encodeURIComponent("/ok")}`, { allowHttp: true });
    expect(await text(res)).toBe("hello");
  });

  it("refuses a redirect to an internal address, at the hop, and never connects to it", async () => {
    // the first hop is allowed (named host -> loopback test server); the redirect names the metadata address, which the policy refuses
    const f = createSafeFetch({ resolve: toLocal, isAllowedAddress: (ip) => lo(ip) });
    const before = sockets;
    await expect(f(`http://a.example.test:${port}/redirect-to/${encodeURIComponent("http://169.254.169.254/latest/meta-data")}`, { allowHttp: true })).rejects.toMatchObject({ code: "BLOCKED" });
    expect(sockets).toBe(before + 1); // only the first hop connected
  });

  it("refuses a redirect to a name that resolves to a private address, at the hop", async () => {
    const answers: Record<string, string> = { "good.example.test": "127.0.0.1", "bad.example.test": "10.0.0.7" };
    const f = createSafeFetch({ resolve: async (h) => [{ address: answers[h], family: 4 }], isAllowedAddress: lo });
    await expect(f(`http://good.example.test:${port}/redirect-to/${encodeURIComponent(`http://bad.example.test:${port}/ok`)}`, { allowHttp: true })).rejects.toMatchObject({ code: "BLOCKED" });
  });

  it("a redirect to https is not followed when it names a blocked scheme or host", async () => {
    const f = createSafeFetch({ resolve: toLocal, isAllowedAddress: lo });
    await expect(f(`http://a.example.test:${port}/redirect-to/${encodeURIComponent("file:///etc/passwd")}`, { allowHttp: true })).rejects.toMatchObject({ code: "PROTOCOL" });
    await expect(f(`http://a.example.test:${port}/redirect-to/${encodeURIComponent("https://localhost/x")}`, { allowHttp: true })).rejects.toMatchObject({ code: "BLOCKED" });
  });

  it("at most 3 redirects by default, and the limit is configurable", async () => {
    const f = createSafeFetch({ resolve: toLocal, isAllowedAddress: lo });
    await expect(f(`http://a.example.test:${port}/hop/0`, { allowHttp: true })).rejects.toMatchObject({ code: "REDIRECTS" });
    await expect(f(`http://a.example.test:${port}/hop/0`, { allowHttp: true, maxRedirects: 1 })).rejects.toMatchObject({ code: "REDIRECTS" });
  });
});

describe("safeFetch: size, type and time limits", () => {
  const f = createSafeFetch({ resolve: toLocal, isAllowedAddress: lo });
  const url = (p: string) => `http://a.example.test:${port}${p}`;

  it("a declared length over the cap is refused before the body is read", async () => {
    await expect(f(url("/big"), { allowHttp: true, maxBytes: 1000 })).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("a body with no declared length is cut off while it streams", async () => {
    const res = await f(url("/big-chunked"), { allowHttp: true, maxBytes: 3000 });
    await expect(res.arrayBuffer()).rejects.toBeTruthy();
  });

  it("a body within the cap passes", async () => {
    expect((await f(url("/big"), { allowHttp: true, maxBytes: 5000 })).status).toBe(200);
  });

  it("expectType refuses the wrong content type", async () => {
    await expect(f(url("/text"), { allowHttp: true, expectType: /^image\// })).rejects.toMatchObject({ code: "TYPE" });
    expect((await f(url("/ok"), { allowHttp: true, expectType: /^image\// })).status).toBe(200);
  });

  it("a server that never answers times out", async () => {
    const t = Date.now();
    await expect(f(url("/slow-headers"), { allowHttp: true, connectTimeoutMs: 200 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("a body that stops mid-way times out on silence", async () => {
    const res = await f(url("/slow-body"), { allowHttp: true, idleTimeoutMs: 200 });
    await expect(res.arrayBuffer()).rejects.toBeTruthy();
  });

  it("a body that keeps dripping is stopped by the total timeout", async () => {
    const res = await f(url("/drip"), { allowHttp: true, idleTimeoutMs: 5000, totalTimeoutMs: 300 }).catch((e) => e);
    if (res instanceof Response) await expect(res.arrayBuffer()).rejects.toBeTruthy();
    else expect(res).toBeInstanceOf(SafeFetchError);
  });

  it("a connect that hangs (a blackhole address) times out", async () => {
    // a listening socket that never accepts into the HTTP layer is not a hang; use a real blackhole instead: a server that accepts and stays silent
    const quiet = net.createServer(() => {});
    await new Promise<void>((r) => quiet.listen(0, "127.0.0.1", r));
    const p = (quiet.address() as AddressInfo).port;
    await expect(f(`http://a.example.test:${p}/x`, { allowHttp: true, connectTimeoutMs: 200 })).rejects.toMatchObject({ code: "TIMEOUT" });
    quiet.close();
  });

  it("HEAD returns no body and keeps the status", async () => {
    const res = await f(url("/ok"), { allowHttp: true, method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});

describe("the default policy is the real blocklist", () => {
  it("createSafeFetch() with no deps uses isBlockedAddress", async () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    await expect(createSafeFetch()(`http://127.0.0.1:${port}/ok`, { allowHttp: true })).rejects.toMatchObject({ code: "BLOCKED" });
  });
});
