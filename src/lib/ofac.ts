/**
 * OFAC sanctions screening — US Treasury SDN list.
 *
 * Calls the public OFAC API (no key required). On network/API failure this
 * returns { hit: false, error } — the `error` field signals the screen could
 * NOT be completed (distinct from a clean { hit: false }). Callers decide the
 * posture: the live formation path FAILS CLOSED (blocks creation when `error`
 * is set), so a screening outage can never wave a sanctioned party through.
 * See src/routes/formations.ts (sanctions_screening_unavailable).
 *
 * Score threshold: 85 — balances false-positive rate vs coverage.
 * The score is the API's own match confidence (0–100).
 */

const OFAC_API = "https://ofac.treasury.gov/ofac-api/search";
const SCORE_THRESHOLD = 85;
const TIMEOUT_MS = 5_000;

export interface OfacScreenResult {
  hit: boolean;
  match_name?: string;
  match_score?: number;
  match_uid?: string;
  error?: string;
}

/**
 * Screen a full name against the US Treasury OFAC SDN list.
 * Returns { hit: false } on network errors (fail-open).
 */
export async function screenOfac(fullName: string): Promise<OfacScreenResult> {
  const url = `${OFAC_API}?term=${encodeURIComponent(fullName)}&searchIn=Individual&type=PERSON&scoreThreshold=${SCORE_THRESHOLD}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      return { hit: false, error: `ofac_api_${res.status}` };
    }

    const json = (await res.json()) as {
      sdn_count?: number;
      results?: Array<{ uid?: string; sdn_name?: string; score?: number }>;
    };

    const matches = (json.results ?? []).filter(
      (r) => (r.score ?? 0) >= SCORE_THRESHOLD,
    );

    if (matches.length === 0) return { hit: false };

    const top = matches[0];
    if (!top) return { hit: false };
    const result: OfacScreenResult = { hit: true };
    if (top.sdn_name !== undefined) result.match_name = top.sdn_name;
    if (top.score !== undefined) result.match_score = top.score;
    if (top.uid !== undefined) result.match_uid = top.uid;
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { hit: false, error: `ofac_fetch_failed: ${msg.slice(0, 100)}` };
  }
}
