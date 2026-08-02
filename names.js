// ---------------------------------------------------------------------------
// names.js — how a person's name is shortened for public display.
//
// Shared by the email generator (email.js) and the public schedule page
// (schedule.js) so the two can't drift apart: someone shown as "John S" in
// the email should read the same way on the schedule.
//
// The rule is "as short as stays unambiguous": first name only ("Amy"),
// escalating to a last initial ("John S") only where a bare first name would
// be ambiguous, and to the full name if even that collides.
//
// What counts as ambiguous depends on the pool of names passed in, and the
// two callers pass different pools on purpose:
//
//   email.js     the whole roster, plus anyone named in the loaded month's
//                schedule. It's an admin page, so it can read the roster.
//   schedule.js  only names appearing on the published schedule — the
//                roster is admin-only in firestore.rules, and that's the
//                right pool for that page anyway.
//
// Either way the pool should be as wide as that page can see, so a person
// reads consistently across it rather than flipping between "John" and
// "John S" depending on who else happens to appear nearby.
// ---------------------------------------------------------------------------

/**
 * Build a lookup from full name to display name.
 *
 * @param {string[]} allNames every name the calling page knows about;
 *   duplicates and empty values are ignored.
 * @returns {Map<string, string>} full name -> display name
 */
export function buildDisplayNames(allNames) {
  const map = new Map();

  // Group by first name, case-insensitively, so "john" and "John" collide.
  const byFirst = new Map();
  for (const full of new Set(allNames.filter(Boolean))) {
    const first = full.trim().split(/\s+/)[0];
    const key = first.toLowerCase();
    if (!byFirst.has(key)) byFirst.set(key, []);
    byFirst.get(key).push(full);
  }

  for (const group of byFirst.values()) {
    if (group.length === 1) {
      const full = group[0];
      map.set(full, full.trim().split(/\s+/)[0]);
      continue;
    }

    // Shared first name — try "First L". Count how many land on each form
    // so we can tell whether the initial is actually enough.
    const counts = new Map();
    const withInitial = new Map();
    for (const full of group) {
      const parts = full.trim().split(/\s+/);
      // Someone with no surname on file can't be disambiguated this way;
      // their first name is all we have.
      const form = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}` : parts[0];
      withInitial.set(full, form);
      counts.set(form, (counts.get(form) || 0) + 1);
    }

    for (const full of group) {
      const form = withInitial.get(full);
      // Two people who'd both read as "John S" get their full names, since
      // anything shorter would be actively misleading.
      map.set(full, counts.get(form) > 1 ? full.trim() : form);
    }
  }

  return map;
}

/**
 * Look a name up in a map from buildDisplayNames, falling back to the bare
 * first name for anyone the map doesn't know about.
 */
export function displayName(map, fullName) {
  if (!fullName) return "";
  return map.get(fullName) || fullName.trim().split(/\s+/)[0];
}
