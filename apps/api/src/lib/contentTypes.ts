// Content pillars and categories — docs/content-types.md.
// Mirrored in apps/web/src/lib/contentTypes.ts; keep both identical.

export const PILLARS = ["Promotional", "Educational", "Entertainment", "Conversational"] as const;
export type Pillar = (typeof PILLARS)[number];

// Category → pillar (null = outside the 4 pillars).
export const CATEGORY_INFO = {
  "Product Features":             { pillar: "Promotional" },
  "Case Study":                   { pillar: "Promotional" },
  "Success Story":                { pillar: "Promotional" },
  "Client Testimonial":           { pillar: "Promotional" },
  "Event Partnership":            { pillar: "Promotional" },
  "External Event":               { pillar: "Promotional" },
  "Geospatial Insight/Expertise": { pillar: "Educational" },
  "Blog Post":                    { pillar: "Educational" },
  "Tips/How To":                  { pillar: "Educational" },
  "Highlight CSR":                { pillar: "Entertainment" },
  "Behind the Scene":             { pillar: "Entertainment" },
  "Polling & Survey":             { pillar: "Conversational" },
  "Trend Response":               { pillar: "Conversational" },
  "Internal Event":               { pillar: "Conversational" },
  "Commemorative Content":        { pillar: "Conversational" },
  "Ask Me Anything":              { pillar: null },
} as const satisfies Record<string, { pillar: Pillar | null }>;

export type Category = keyof typeof CATEGORY_INFO;
export const CATEGORIES = Object.keys(CATEGORY_INFO) as [Category, ...Category[]];

export function pillarFor(category: Category): Pillar | null {
  return CATEGORY_INFO[category].pillar;
}

/** Categories under a pillar; null = the categories outside the 4 pillars (Ask Me Anything). */
export function categoriesFor(pillar: Pillar | null): Category[] {
  return CATEGORIES.filter((c) => CATEGORY_INFO[c].pillar === pillar);
}

/** Canonical category for free text (e.g. imported plans): trims, ignores case, accepts "AMA". */
export function normalizeCategory(raw: unknown): Category | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  if (key === "ama") return "Ask Me Anything";
  return CATEGORIES.find((c) => c.toLowerCase() === key) ?? null;
}
