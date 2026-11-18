// @vitest-environment jsdom
// The file the "Export list" button hands to the browser. The link to it must live on after the click: Safari and Firefox
// may still be reading the file when the click returns, so it is let go a little later, not at once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadCsv } from "./template-library";

const clicked: Array<{ href: string; download: string }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  clicked.length = 0;
  URL.createObjectURL = vi.fn(() => "blob:csv");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("downloadCsv", () => {
  it("clicks a link to the file under the given name", () => {
    downloadCsv("templates.csv", "a,b\r\n");
    expect(clicked).toEqual([{ href: "blob:csv", download: "templates.csv" }]);
  });

  it("lets the file go only after a while, not right after the click", () => {
    downloadCsv("templates.csv", "a,b\r\n");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:csv");
  });
});
