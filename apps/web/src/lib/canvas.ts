// Canvas client helpers. API calls and types for designs are added here as the persistence phases land.

const FONT_TIMEOUT_MS = 10_000;

/**
 * Loads the faces the editor draws text with. Next's font loader gives each family a generated
 * name, exposed on <html> as --font-inter / --font-koho, so the real name is read from there.
 * Rejects if a face fails to load or takes longer than 10s, so the loader can offer a retry.
 */
export async function loadEditorFonts(): Promise<void> {
  const root = getComputedStyle(document.documentElement);
  const faces: Array<[weight: number, variable: string]> = [
    [400, "--font-inter"],
    [600, "--font-inter"],
    [600, "--font-koho"],
  ];

  const loading = Promise.all(
    faces.map(([weight, variable]) => {
      const family = root.getPropertyValue(variable).trim() || "sans-serif";
      return document.fonts.load(`${weight} 16px ${family}`);
    }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Fonts took too long to load")), FONT_TIMEOUT_MS);
  });
  try {
    await Promise.race([loading, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
