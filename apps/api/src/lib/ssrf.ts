import net from "node:net";

// What the server must never be tricked into connecting to: loopback, private, link-local (the cloud metadata address included),
// carrier-grade NAT, documentation/benchmark/reserved ranges, multicast and everything IPv6 that is not global unicast.
// isBlockedAddress checks an ADDRESS (what a connection would really use; lib/safeFetch.ts runs it on every DNS answer).
// isBlockedHost and isSsrfBlocked check what can be read off a URL WITHOUT a DNS lookup: an address literal in any spelling the URL parser
// normalises (2130706433, 0x7f.1, [::ffff:7f00:1]), or a name that is internal by construction. A name that merely RESOLVES to a private
// address is only caught by the lookup in safeFetch, so code that fetches must use safeFetch, not this check alone.

function v4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const n = parts.map(Number);
  return n.every((x) => x <= 255) ? n : null;
}

function v6Bytes(input: string): number[] | null {
  let s = input.split("%")[0].toLowerCase(); // a zone id (fe80::1%eth0) is not part of the address
  if (!net.isIPv6(s)) return null;
  if (s.includes(".")) {
    const last = s.lastIndexOf(":");
    const q = v4(s.slice(last + 1));
    if (!q) return null;
    s = `${s.slice(0, last + 1)}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const r = rest === undefined ? [] : rest ? rest.split(":") : [];
  const groups = rest === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - r.length)).fill("0"), ...r];
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 255];
  });
}

function blockedV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this network", 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT (Railway's own proxy network is here)
    (a === 169 && b === 254) || // link-local, the metadata address 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, documentation
    (a === 192 && b === 88 && c === 99) || // old 6to4 relay
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

function blockedV6(b: number[]): boolean {
  if ((b[0] & 0xe0) !== 0x20) return true; // only global unicast 2000::/3: refuses ::, ::1, ::ffff:x (IPv4-mapped), fc00::/7, fe80::/10, ff00::/8, 64:ff9b::/96
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] <= 0x01) return true; // 2001::/23: Teredo and protocol assignments
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  if (b[0] === 0x20 && b[1] === 0x02) return true; // 6to4: embeds an IPv4 address we would not check
  return false;
}

/** True for any address a server-side fetch must not connect to. Anything that is not an IP address at all is refused too. */
export function isBlockedAddress(ip: string): boolean {
  const a = v4(ip);
  if (a) return blockedV4(a);
  const b = v6Bytes(ip);
  return b ? blockedV6(b) : true;
}

/** True when a URL hostname is blocked on its face: an address literal in a blocked range, or a name that is internal by construction. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (net.isIP(bare)) return isBlockedAddress(bare);
  return (
    !h.includes(".") || // a single label (localhost, redis, db) is an internal name
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".localdomain")
  );
}

/** https only, no credentials in the URL, and a host that is not blocked on its face. (No DNS: see the note at the top.) */
export function isSsrfBlocked(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== "https:") return true;
  if (parsed.username || parsed.password) return true;
  return isBlockedHost(parsed.hostname);
}
