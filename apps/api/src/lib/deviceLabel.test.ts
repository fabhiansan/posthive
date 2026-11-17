import { describe, expect, it } from "vitest";
import { USER_AGENT_MAX, cleanUserAgent, deviceOf } from "./deviceLabel.js";

const UA = {
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
  chromeIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  operaWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
  chromeOs: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

describe("deviceOf", () => {
  it.each([
    ["chromeMac", "Chrome on macOS", "Mac"],
    ["safariMac", "Safari on macOS", "Mac"],
    ["edgeWin", "Edge on Windows", "Win"],
    ["firefoxLinux", "Firefox on Linux", "Linux"],
    ["safariIphone", "Safari on iOS", "iOS"],
    ["chromeIphone", "Chrome on iOS", "iOS"],
    ["chromeAndroid", "Chrome on Android", "Droid"],
    ["operaWin", "Opera on Windows", "Win"],
    ["chromeOs", "Chrome on ChromeOS", "CrOS"],
  ] as const)("%s is %s", (key, name, tile) => {
    expect(deviceOf(UA[key])).toEqual({ name, tile });
  });

  it("an iPhone is iOS even though its text also says Mac OS X, and Edge is Edge though it also says Chrome", () => {
    expect(deviceOf(UA.safariIphone).name).toContain("iOS");
    expect(deviceOf(UA.edgeWin).name).toBe("Edge on Windows");
  });

  it("nothing, or text that is not a browser, is just a browser", () => {
    for (const odd of [null, undefined, "", "   ", "curl/8.4.0", "x".repeat(5000)]) expect(deviceOf(odd), String(odd).slice(0, 12)).toEqual({ tile: "Web", name: "Browser" });
  });

  it("a known system with an unknown browser says Browser on that system", () => {
    expect(deviceOf("SomeApp/1.0 (Windows NT 10.0)")).toEqual({ tile: "Win", name: "Browser on Windows" });
  });

  it("never gives back any of the text it was given", () => {
    const sneaky = "<script>alert(1)</script> Chrome/1 (Macintosh)";
    expect(JSON.stringify(deviceOf(sneaky))).not.toContain("script");
  });
});

describe("cleanUserAgent", () => {
  it("trims, and cuts a very long header", () => {
    expect(cleanUserAgent("  Mozilla/5.0  ")).toBe("Mozilla/5.0");
    expect(cleanUserAgent("a".repeat(USER_AGENT_MAX + 50))).toHaveLength(USER_AGENT_MAX);
  });

  it("nothing in it is nothing", () => {
    for (const odd of [undefined, null, "", "   ", 42, ["a"], {}]) expect(cleanUserAgent(odd)).toBeNull();
  });
});
