import { describe, expect, it } from "vitest";
import { isBlockedAddress, isBlockedHost, isSsrfBlocked } from "./ssrf.js";

const BLOCKED_ADDRESSES = [
  // IPv4
  "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "127.0.0.1", "127.255.255.254",
  "100.64.0.1", "100.127.255.255", "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255",
  "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.0.1", "198.18.0.1", "198.19.255.255",
  "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
  // IPv6
  "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:8.8.8.8",
  "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "ff02::1", "64:ff9b::7f00:1",
  "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "2002:7f00:1::1", "2002:a9fe:a9fe::1",
  // not an address at all
  "", "localhost", "example.com", "999.1.1.1", "1.2.3", "01.2.3.4.5",
];

const ALLOWED_ADDRESSES = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e"];

describe("isBlockedAddress", () => {
  it.each(BLOCKED_ADDRESSES)("blocks %j", (ip) => expect(isBlockedAddress(ip)).toBe(true));
  it.each(ALLOWED_ADDRESSES)("allows the public address %s", (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe("isBlockedHost / isSsrfBlocked: what a URL says on its face", () => {
  const BAD = [
    "https://localhost/a.png", "https://LOCALHOST./a.png", "https://app.localhost/a", "https://db/a", "https://printer.local/a",
    "https://svc.internal/a", "https://x.localdomain/a",
    "https://127.0.0.1/a", "https://2130706433/a", "https://0x7f.1/a", "https://0177.0.0.1/a", "https://127.1/a",
    "https://[::1]/a", "https://[::ffff:7f00:1]/a", "https://[::ffff:127.0.0.1]/a", "https://[fe80::1]/a", "https://[fd00::1]/a",
    "https://169.254.169.254/latest/meta-data", "https://169.254.1.1/a", "https://10.1.2.3/a", "https://100.64.0.1/a", "https://192.168.1.1/a", "https://0.0.0.0/a",
    "http://example.com/a.png", "ftp://example.com/a", "file:///etc/passwd", "javascript:alert(1)", "data:text/plain,hi",
    "https://user:pass@example.com/a", "https://user@example.com/a", "not a url", "",
  ];
  it.each(BAD)("isSsrfBlocked refuses %j", (u) => expect(isSsrfBlocked(u)).toBe(true));

  it("allows a normal public https address", () => {
    expect(isSsrfBlocked("https://example.com/a.png")).toBe(false);
    expect(isSsrfBlocked("https://cdn.example.co.uk:8443/a.png?x=1")).toBe(false);
    expect(isSsrfBlocked("https://8.8.8.8/a.png")).toBe(false);
    expect(isSsrfBlocked("https://[2606:4700:4700::1111]/a.png")).toBe(false);
  });

  it("isBlockedHost handles brackets and a trailing dot", () => {
    expect(isBlockedHost("[::1]")).toBe(true);
    expect(isBlockedHost("localhost.")).toBe(true);
    expect(isBlockedHost("example.com.")).toBe(false);
  });
});
