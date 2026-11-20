// The failure e-mail names each platform and says why it failed. The reason is text from a platform or an adapter, so it must
// reach the page escaped: a reason with markup in it would otherwise be markup in somebody's inbox.
import { describe, expect, it, vi } from "vitest";

// the mailer reads its settings when it loads; with no key it writes to the console instead of sending
vi.hoisted(() => {
  delete process.env.RESEND_API_KEY;
});

import { failureReasonsHtml, sendPostFailedEmail } from "./mailer.js";

describe("failureReasonsHtml", () => {
  it("a reason with markup in it is shown as text", () => {
    const html = failureReasonsHtml([{ platform: "threads", reason: '<script>alert("x")</script> & <b>bold</b>' }]);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;");
  });

  it("each platform has its own name (twitter is X) and its own reason, in order", () => {
    const html = failureReasonsHtml([
      { platform: "linkedin", reason: "Your LinkedIn connection has expired." },
      { platform: "twitter", reason: "X is limiting how fast we can post." },
    ]);
    expect(html.indexOf("LinkedIn:")).toBeLessThan(html.indexOf("Your LinkedIn connection has expired."));
    expect(html.indexOf("Your LinkedIn connection has expired.")).toBeLessThan(html.indexOf("X:"));
    expect(html.indexOf("X:")).toBeLessThan(html.indexOf("X is limiting how fast we can post."));
    expect(html).not.toContain("twitter");
  });

  it("nothing failed that it can name: empty, so the e-mail falls back to its general advice", () => {
    expect(failureReasonsHtml([])).toBe("");
  });
});

describe("sendPostFailedEmail", () => {
  it("with no mail service set up it writes a line and does not throw, with or without reasons", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(sendPostFailedEmail("a@b.co", ["linkedin", "twitter"], new Date("2026-11-20T03:00:00Z"), "job1")).resolves.toBeUndefined();
    await expect(sendPostFailedEmail("a@b.co", ["linkedin"], new Date("2026-11-20T03:00:00Z"), "job1", [{ platform: "linkedin", reason: "<b>x</b>" }])).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("job job1 on LinkedIn, X"));
    log.mockRestore();
  });
});
