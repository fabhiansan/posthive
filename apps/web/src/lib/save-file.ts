/** Gives the browser a file to save: the CSV export of the Template Library, the recovery codes of two-step verification. */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // not at once: Safari and Firefox may still be reading the file when the click returns
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
