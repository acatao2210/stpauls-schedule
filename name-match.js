// ---------------------------------------------------------------------------
// Free-text name -> roster matching.
//
// The visitor just types their name in a plain text box. This module quietly
// figures out which roster name they most likely mean so we can attach a
// canonical `matchedName` to the submission — without ever showing the
// visitor a dropdown, suggestion, or "did you mean" prompt.
//
// Note: this only matches against names (see roster.js). Email/phone/role
// lookups happen later, server-side, by joining matchedName against the
// private "roster" collection in Firestore — that data never reaches the
// browser.
// ---------------------------------------------------------------------------

function normalize(str) {
  return str
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")       // drop punctuation
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function similarity(a, b) {
  const dist = levenshtein(a, b);
  const longest = Math.max(a.length, b.length) || 1;
  return 1 - dist / longest;
}

/**
 * Matches free-text input against a list of roster names (plain strings).
 * Returns { matchedName, confidence, candidates } where:
 *   confidence: "exact" | "fuzzy" | "partial" | "ambiguous" | "none"
 *   candidates: up to 3 best guesses (for admin review in Firestore),
 *               each { name, score }
 */
export function matchName(rawInput, rosterNames) {
  const input = normalize(rawInput);
  if (!input) return { matchedName: null, confidence: "none", candidates: [] };

  const inputTokens = input.split(" ");
  const scored = rosterNames.map((name) => {
    const full = normalize(name);
    const tokens = full.split(" ");
    const reversed = [...tokens].reverse().join(" ");

    let score = Math.max(similarity(input, full), similarity(input, reversed));

    // Boost if every input token appears as a prefix of some roster token
    // (handles nicknames-as-typed, extra middle names, etc.)
    const tokenHits = inputTokens.filter((t) =>
      tokens.some((rt) => rt.startsWith(t) || t.startsWith(rt))
    ).length;
    const tokenCoverage = tokenHits / Math.max(inputTokens.length, tokens.length);
    score = Math.max(score, tokenCoverage * 0.9);

    return { name, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  const candidates = scored.slice(0, 3).map((s) => ({ name: s.name, score: Number(s.score.toFixed(3)) }));

  if (!best || best.score < 0.5) {
    return { matchedName: null, confidence: "none", candidates };
  }

  if (best.score >= 0.97) {
    return { matchedName: best.name, confidence: "exact", candidates };
  }

  // Ambiguous if the top two candidates are close to each other.
  if (second && best.score - second.score < 0.08 && best.score < 0.85) {
    return { matchedName: best.name, confidence: "ambiguous", candidates };
  }

  if (best.score >= 0.75) {
    return { matchedName: best.name, confidence: "fuzzy", candidates };
  }

  return { matchedName: best.name, confidence: "partial", candidates };
}
