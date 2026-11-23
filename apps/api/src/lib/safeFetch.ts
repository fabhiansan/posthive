import dns from "node:dns";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable, Transform } from "node:stream";
import { isBlockedAddress, isBlockedHost } from "./ssrf.js";

/**
 * fetch() for a URL somebody else chose (a pasted video link, a CSV's image column, a post's picture address).
 *
 *  - Every address the name resolves to is checked, and the connection is made to an address that was checked: the check lives in the
 *    `lookup` the socket itself uses, so there is no second resolution a DNS answer could change between "validated" and "connected".
 *    One blocked address in an answer refuses the whole answer. An address literal is checked before any socket exists.
 *  - Redirects are followed by hand, at most 3, and every hop is validated like the first request.
 *  - A connect/first-byte timeout, an idle timeout, a total timeout and a size cap. A body over the cap errors the stream.
 *  - The answer is a standard Response, so callers keep res.ok / res.headers / res.arrayBuffer() / res.body.
 *
 * https only unless the caller opts into http (a destination is just as dangerous either way; the option exists for callers that
 * accepted http addresses before). No credentials in the URL. A new connection per request (agent: false): nothing is pooled, so a
 * socket is never reused for a name whose answer has since changed.
 *
 * shortcut: an address that is public at connect time and later becomes private is not re-checked on the open socket; the connection
 * is short-lived and capped by the timeouts above.
 */

export class SafeFetchError extends Error {
  constructor(message: string, readonly code: "BLOCKED" | "PROTOCOL" | "REDIRECTS" | "TIMEOUT" | "TOO_LARGE" | "TYPE" | "DNS") {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  /** Also allow http:// (and a redirect to it). Default: https only. */
  allowHttp?: boolean;
  /** Default 3. */
  maxRedirects?: number;
  /** Default 25 MB. */
  maxBytes?: number;
  /** Until the response headers arrive. Default 10 s. */
  connectTimeoutMs?: number;
  /** Between two chunks of the body. Default 30 s. */
  idleTimeoutMs?: number;
  /** The whole call, body included. Default 60 s. */
  totalTimeoutMs?: number;
  /** The final response's content-type must match, or the call is refused. */
  expectType?: RegExp;
}

export interface SafeFetchDeps {
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  isAllowedAddress?: (ip: string) => boolean;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function createSafeFetch(deps: SafeFetchDeps = {}) {
  const resolve = deps.resolve ?? ((host: string) => dns.promises.lookup(host, { all: true, verbatim: true }));
  const allowed = deps.isAllowedAddress ?? ((ip: string) => !isBlockedAddress(ip));

  function checkUrl(url: URL, allowHttp: boolean): void {
    if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) throw new SafeFetchError(`Only ${allowHttp ? "http and https" : "https"} addresses are fetched.`, "PROTOCOL");
    if (url.username || url.password) throw new SafeFetchError("An address with a user name or password is not fetched.", "BLOCKED");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host)) {
      if (!allowed(host)) throw new SafeFetchError("That address is not allowed.", "BLOCKED");
    } else if (isBlockedHost(url.hostname)) {
      throw new SafeFetchError("That host is not allowed.", "BLOCKED");
    }
  }

  // The socket calls this with the name and connects to what it returns. Node 20+ asks for every address (all: true) to try them in turn.
  const lookup = ((hostname: string, options: { all?: boolean }, cb: (err: Error | null, a?: unknown, f?: number) => void) => {
    resolve(hostname).then(
      (answers) => {
        if (!answers.length) return cb(new SafeFetchError("The name did not resolve.", "DNS"));
        if (answers.some((a) => !allowed(a.address))) return cb(new SafeFetchError("That name resolves to an address that is not allowed.", "BLOCKED"));
        if (options?.all) cb(null, answers);
        else cb(null, answers[0].address, answers[0].family);
      },
      (err) => cb(err instanceof Error ? err : new SafeFetchError("The name did not resolve.", "DNS")),
    );
  }) as unknown as net.LookupFunction;

  function hop(url: URL, o: Required<Pick<SafeFetchOptions, "method" | "connectTimeoutMs" | "idleTimeoutMs">> & { headers: Record<string, string>; signal: AbortSignal }): Promise<IncomingMessage> {
    return new Promise((resolveHop, reject) => {
      const secure = url.protocol === "https:";
      let firstByte: NodeJS.Timeout | undefined;
      const req = (secure ? https : http).request(
        {
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port || (secure ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: o.method,
          headers: o.headers,
          lookup,
          agent: false,
          signal: o.signal,
        },
        (res) => {
          clearTimeout(firstByte);
          res.setTimeout(o.idleTimeoutMs, () => res.destroy(new SafeFetchError("The server stopped sending.", "TIMEOUT"))); // from here the limit is silence between chunks
          resolveHop(res);
        },
      );
      // our own timer, not req.setTimeout: that one only starts once a socket is connected, and a connect can hang
      firstByte = setTimeout(() => req.destroy(new SafeFetchError("The server did not answer in time.", "TIMEOUT")), o.connectTimeoutMs);
      req.on("error", (err) => {
        clearTimeout(firstByte);
        reject(o.signal.aborted ? new SafeFetchError("The request took too long.", "TIMEOUT") : err);
      });
      req.end();
    });
  }

  return async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<Response> {
    const o = {
      method: options.method ?? "GET",
      allowHttp: options.allowHttp ?? false,
      maxRedirects: options.maxRedirects ?? 3,
      maxBytes: options.maxBytes ?? 25 * 1024 * 1024,
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      idleTimeoutMs: options.idleTimeoutMs ?? 30_000,
      totalTimeoutMs: options.totalTimeoutMs ?? 60_000,
    };
    const signal = AbortSignal.timeout(o.totalTimeoutMs);
    // identity: this layer does not decompress, so a gzip answer would hand the caller compressed bytes
    const headers = { "accept-encoding": "identity", "user-agent": "Posthive/1.0", ...options.headers };

    let current: URL;
    try {
      current = new URL(rawUrl);
    } catch {
      throw new SafeFetchError("That is not a valid address.", "PROTOCOL");
    }

    for (let redirects = 0; ; redirects++) {
      checkUrl(current, o.allowHttp);
      const res = await hop(current, { method: o.method, connectTimeoutMs: o.connectTimeoutMs, idleTimeoutMs: o.idleTimeoutMs, headers, signal });
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (REDIRECTS.has(status) && location) {
        res.resume(); // drop the redirect's own body
        if (redirects >= o.maxRedirects) throw new SafeFetchError("Too many redirects.", "REDIRECTS");
        try {
          current = new URL(location, current);
        } catch {
          throw new SafeFetchError("The redirect points to an invalid address.", "PROTOCOL");
        }
        continue; // checkUrl runs again at the top: every hop is validated on its own
      }

      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > o.maxBytes) {
        res.destroy();
        throw new SafeFetchError("The file is too large.", "TOO_LARGE");
      }
      if (options.expectType && !options.expectType.test(String(res.headers["content-type"] ?? ""))) {
        res.destroy();
        throw new SafeFetchError("The file is not the kind of file expected.", "TYPE");
      }

      const responseHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) v.forEach((x) => responseHeaders.append(k, x));
        else if (v !== undefined) responseHeaders.set(k, v);
      }
      if (o.method === "HEAD" || status === 204 || status === 205 || status === 304 || status < 200) {
        res.resume();
        return new Response(null, { status: status < 200 ? 200 : status, headers: responseHeaders });
      }
      let seen = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          seen += chunk.length;
          if (seen > o.maxBytes) cb(new SafeFetchError("The file is too large.", "TOO_LARGE"));
          else cb(null, chunk);
        },
      });
      res.on("error", (err) => cap.destroy(err));
      cap.on("close", () => res.destroy()); // a reader that gives up (or a size error) must not leave the socket open
      return new Response(Readable.toWeb(res.pipe(cap)) as ReadableStream, { status, statusText: res.statusMessage, headers: responseHeaders });
    }
  };
}

export const safeFetch = createSafeFetch();
