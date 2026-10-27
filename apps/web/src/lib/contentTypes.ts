// Content pillars and categories — docs/content-types.md.
// Mirrored in apps/api/src/lib/contentTypes.ts; keep both identical.

export const PILLARS = ["Promotional", "Educational", "Entertainment", "Conversational"] as const;
export type Pillar = (typeof PILLARS)[number];

// Category → pillar (null = outside the 4 pillars) and default slide count per the template diagram.
export const CATEGORY_INFO = {
  "Product Features":             { pillar: "Promotional",    slides: 5 },
  "Case Study":                   { pillar: "Promotional",    slides: 5 },
  "Success Story":                { pillar: "Promotional",    slides: 5 },
  "Client Testimonial":           { pillar: "Promotional",    slides: 1 },
  "Event Partnership":            { pillar: "Promotional",    slides: 5 },
  "External Event":               { pillar: "Promotional",    slides: 5 },
  "Geospatial Insight/Expertise": { pillar: "Educational",    slides: 4 },
  "Blog Post":                    { pillar: "Educational",    slides: 4 },
  "Tips/How To":                  { pillar: "Educational",    slides: 4 },
  "Highlight CSR":                { pillar: "Entertainment",  slides: 4 },
  "Behind the Scene":             { pillar: "Entertainment",  slides: 4 },
  "Polling & Survey":             { pillar: "Conversational", slides: 1 },
  "Trend Response":               { pillar: "Conversational", slides: 1 },
  "Internal Event":               { pillar: "Conversational", slides: 4 },
  "Commemorative Content":        { pillar: "Conversational", slides: 1 },
  "Ask Me Anything":              { pillar: null,             slides: 1 },
} as const satisfies Record<string, { pillar: Pillar | null; slides: number }>;

export type Category = keyof typeof CATEGORY_INFO;
export const CATEGORIES = Object.keys(CATEGORY_INFO) as [Category, ...Category[]];

export function pillarFor(category: Category): Pillar | null {
  return CATEGORY_INFO[category].pillar;
}

/** ["Cover", "Slide 1", "Slide 2", …] — copywriting sections per docs/content-types.md. */
export function defaultSlideLabels(count: number): string[] {
  return Array.from({ length: count }, (_, i) => (i === 0 ? "Cover" : `Slide ${i}`));
}
