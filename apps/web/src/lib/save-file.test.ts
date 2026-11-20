// @vitest-environment jsdom
// The one place a file is handed to the browser to save. The link to it must live on after the click: Safari and Firefox may
// still be reading the file when the click returns, so it is let go a little later, not at once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveFile } from "./save-file";

const clicked: Array<{ href: string; download: string }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  clicked.length = 0;
  URL.createObjectURL = vi.fn(() => "blob:file");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("saveFile", () => {
  it("hands the browser the file under the name given", () => {
    const blob = new Blob(["a"], { type: "text/plain" });
    saveFile(blob, "codes.txt");
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual([{ href: "blob:file", download: "codes.txt" }]);
  });

  it("lets the link go 10 seconds later, not at once", () => {
    saveFile(new Blob(["a"]), "codes.txt");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(9_999);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:file");
  });
});
