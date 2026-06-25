/**
 * Country normalization — accept full country names (PT/EN) and normalize to
 * ISO 3166-1 alpha-2 codes.
 *
 * Why: agents (and humans) frequently send "Brasil" / "Brazil" / "br" instead
 * of the canonical "BR". Rejecting those forces a wasteful retry round-trip.
 * normalizeCountry() collapses the common variants to the ISO-2 code so the
 * first attempt succeeds; unknown inputs pass through unchanged so Zod still
 * surfaces a clear validation error.
 */

// Lowercased name → ISO 3166-1 alpha-2. Covers the jurisdictions and client
// nationalities we actually see; extend as needed.
const COUNTRY_NAME_TO_ISO: Record<string, string> = {
  // Brazil
  brasil: "BR",
  brazil: "BR",
  // United States
  "estados unidos": "US",
  "estados unidos da america": "US",
  eua: "US",
  usa: "US",
  "united states": "US",
  "united states of america": "US",
  america: "US",
  // United Kingdom
  "reino unido": "GB",
  "united kingdom": "GB",
  inglaterra: "GB",
  england: "GB",
  uk: "GB",
  // Portugal
  portugal: "PT",
  // Other common LATAM / client nationalities
  argentina: "AR",
  chile: "CL",
  colombia: "CO",
  mexico: "MX",
  "méxico": "MX",
  uruguai: "UY",
  uruguay: "UY",
  paraguai: "PY",
  paraguay: "PY",
  // Common formation / residency jurisdictions
  "emirados arabes unidos": "AE",
  "emirados árabes unidos": "AE",
  "united arab emirates": "AE",
  uae: "AE",
  "ilhas virgens britanicas": "VG",
  "ilhas virgens britânicas": "VG",
  "british virgin islands": "VG",
  bvi: "VG",
  panama: "PA",
  "panamá": "PA",
  espanha: "ES",
  spain: "ES",
  franca: "FR",
  "frança": "FR",
  france: "FR",
  alemanha: "DE",
  germany: "DE",
  italia: "IT",
  "itália": "IT",
  italy: "IT",
  canada: "CA",
  "canadá": "CA",
  india: "IN",
  "índia": "IN",
  china: "CN",
  japao: "JP",
  "japão": "JP",
  japan: "JP",
  australia: "AU",
  "austrália": "AU",
};

/**
 * Normalize a country value to its ISO 3166-1 alpha-2 code.
 *
 * - 2-char input → uppercased as-is ("br" → "BR").
 * - Known full name (PT/EN) → mapped code ("Brasil" → "BR").
 * - Anything else → trimmed input unchanged, so downstream validation can
 *   reject it with a clear message.
 */
export function normalizeCountry(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 2) return trimmed.toUpperCase();
  const mapped = COUNTRY_NAME_TO_ISO[trimmed.toLowerCase()];
  return mapped ?? trimmed;
}
