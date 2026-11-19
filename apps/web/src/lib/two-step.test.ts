// The small pure helpers of two-step verification on the web.
import { describe, expect, it } from "vitest";
import { cleanCode, groupedKey, looksLikeCode, recoveryCodesFile, twoStepDetail } from "./two-step";

describe("groupedKey", () => {
  it("writes the setup key in groups of four, as it is typed into an app", () => {
    expect(groupedKey("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
    expect(groupedKey("ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
  });
  it("has no trailing space when the length is a multiple of four, and survives an empty key", () => {
    expect(groupedKey("ABCDEFGH")).toBe("ABCD EFGH");
    expect(groupedKey("")).toBe("");
    expect(groupedKey("JBSW Y3DP")).toBe("JBSW Y3DP"); // already grouped: not grouped twice
  });
});

describe("looksLikeCode", () => {
  it("takes six digits, or a recovery code however it is written", () => {
    for (const ok of ["123456", " 123456 ", "ABCDE-FGHJK", "abcde-fghjk", "abcdefghjk", "ABCDE FGHJK"]) expect(looksLikeCode(ok)).toBe(true);
  });
  it("refuses what cannot be either: short, long, or with letters in an authenticator code", () => {
    for (const bad of ["", "12345", "1234567", "12345a", "ABCDE-FGHJ", "ABCDE-FGHJ0", "ABCDE-FGHJKL"]) expect(looksLikeCode(bad)).toBe(false);
  });
  it("cleanCode only trims: a recovery code keeps its letters for the API to read", () => {
    expect(cleanCode("  ABCDE-FGHJK ")).toBe("ABCDE-FGHJK");
  });
});

describe("recoveryCodesFile", () => {
  const text = recoveryCodesFile(["AAAAA-BBBBB", "CCCCC-DDDDD"], "Postly", "puteri@example.com", new Date("2026-11-18T10:00:00Z"));
  it("names the product, the account and the day, says what the codes are for, and lists every code on its own line", () => {
    expect(text).toContain("Postly recovery codes for puteri@example.com");
    expect(text).toContain("Made on 2026-11-18");
    expect(text).toContain("Each code works once");
    expect(text.split("\n")).toEqual(expect.arrayContaining(["AAAAA-BBBBB", "CCCCC-DDDDD"]));
  });
  it("warns that a code and the password are enough to sign in", () => {
    expect(text).toMatch(/Keep this file somewhere safe/);
  });
});

describe("twoStepDetail", () => {
  const day = (iso: string) => `${new Date(iso).getUTCDate()} Nov 2026`;
  it("says since when and how many recovery codes are left, singular and plural", () => {
    expect(twoStepDetail({ enabledAt: "2026-11-18T03:00:00Z", recoveryLeft: 8 }, day)).toBe("On since 18 Nov 2026 · 8 recovery codes left");
    expect(twoStepDetail({ enabledAt: "2026-11-18T03:00:00Z", recoveryLeft: 1 }, day)).toBe("On since 18 Nov 2026 · 1 recovery code left");
    expect(twoStepDetail({ enabledAt: "2026-11-18T03:00:00Z", recoveryLeft: 0 }, day)).toBe("On since 18 Nov 2026 · 0 recovery codes left");
  });
  it("without a date it still says it is on, and so does a date that cannot be read", () => {
    expect(twoStepDetail({ enabledAt: null, recoveryLeft: 3 }, day)).toBe("On · 3 recovery codes left");
    expect(twoStepDetail({ enabledAt: "not a date", recoveryLeft: 3 }, () => "")).toBe("On · 3 recovery codes left");
  });
});
