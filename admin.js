import { db, auth } from "./firebase-config.js";
import { buildWeeksForMonth } from "./liturgical.js";
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------------------------------------------------------------------
// Fuzzy name matching (free-text -> roster name). Lives only here, in the
// authenticated admin page — never shipped to the public site.
// ---------------------------------------------------------------------------
function normalizeName(str) {
  return (str || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
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

function tokenSimilarity(t1, t2) {
  if (t1 === t2) return 1;
  const minLen = Math.min(t1.length, t2.length);
  const maxLen = Math.max(t1.length, t2.length);
  // Prefix bonus only kicks in above a bare initial (2+ letters) — "B"
  // matching "Bart" shouldn't score nearly as confidently as "Ba" or
  // "Bart" would, since a single letter is too weak a signal on its own.
  if (minLen >= 2 && (t1.startsWith(t2) || t2.startsWith(t1))) {
    // Scaled by how much of the longer token the shorter one covers, so a
    // two-letter prefix doesn't score as high as a near-complete one.
    return 0.6 + 0.4 * (minLen / maxLen);
  }
  const dist = levenshtein(t1, t2);
  return 1 - dist / (maxLen || 1);
}

// How well every word the admin/visitor typed matches *some* word in the
// candidate name — e.g. typing just "Bart" against roster entry
// "Bart Luczynski" scores highly here even though the two full strings
// look very different overall (missing a whole last name). Deliberately
// scored against inputTokens.length rather than the candidate's token
// count, so a shorter typed name isn't penalized for the roster name
// having more parts than what was typed.
function tokenCoverageSimilarity(inputTokens, candidateTokens) {
  if (inputTokens.length === 0 || candidateTokens.length === 0) return 0;
  let total = 0;
  for (const t of inputTokens) {
    let best = 0;
    for (const ct of candidateTokens) {
      best = Math.max(best, tokenSimilarity(t, ct));
    }
    total += best;
  }
  return total / inputTokens.length;
}

function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;

  const dist = levenshtein(na, nb);
  const longest = Math.max(na.length, nb.length) || 1;
  const direct = 1 - dist / longest;
  const reversed = 1 - levenshtein(na, nb.split(" ").reverse().join(" ")) / longest;

  const inputTokens = na.split(" ").filter(Boolean);
  const candidateTokens = nb.split(" ").filter(Boolean);
  const tokenCoverage = tokenCoverageSimilarity(inputTokens, candidateTokens);

  return Math.max(direct, reversed, tokenCoverage);
}

// Auto-link only fires above this similarity, given a device-key match
// already provides strong independent evidence it's the same person.
const AUTO_LINK_THRESHOLD = 0.55;

// Manual linking (picking from the dropdown) warns — but doesn't block —
// below this similarity, since a human is making the call and might
// legitimately know "Bob" is really "Robert Dunn." Lower bar than
// auto-link's threshold since there's no independent device signal here.
const MANUAL_LINK_WARN_THRESHOLD = 0.4;

// If some OTHER roster name matches the typed name meaningfully better
// than the one being considered, that's a red flag on its own — even if
// the candidate in question clears the thresholds above. E.g. typing
// "Mary Rallo" scoring 70% against "Mike Rallo" would normally pass, but
// if "Mary Rallo" is sitting right there in the roster at 100%, comparing
// against "Mike Rallo" was almost certainly the wrong candidate.
const RELATIVE_PENALTY_MARGIN = 0.12;

// Finds whichever roster entry best matches rawName, optionally ignoring
// one specific name (the candidate already being considered) so the
// comparison is "is there someone ELSE who fits better."
function findBestRosterMatch(rawName, excludeName) {
  let best = null;
  for (const person of rosterList) {
    if (person.name === excludeName) continue;
    const sim = nameSimilarity(rawName, person.name);
    if (!best || sim > best.sim) best = { name: person.name, sim };
  }
  return best;
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const loginCard = document.getElementById("loginCard");
const loginForm = document.getElementById("loginForm");
const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");
const loginBtn = document.getElementById("loginBtn");
const loginError = document.getElementById("loginError");
const googleSignInBtn = document.getElementById("googleSignInBtn");

const dashboard = document.getElementById("dashboard");
const signOutBtn = document.getElementById("signOutBtn");
const monthInput = document.getElementById("monthInput");
const refreshBtn = document.getElementById("refreshBtn");
const autoLinkBtn = document.getElementById("autoLinkBtn");
const summaryLine = document.getElementById("summaryLine");
const dashboardError = document.getElementById("dashboardError");
const responsesBody = document.getElementById("responsesBody");
const emptyState = document.getElementById("emptyState");

const rosterFileInput = document.getElementById("rosterFileInput");
const importRosterBtn = document.getElementById("importRosterBtn");
const rosterCount = document.getElementById("rosterCount");
const rosterImportStatus = document.getElementById("rosterImportStatus");

const weeklySummaryHead = document.getElementById("weeklySummaryHead");
const weeklySummaryBody = document.getElementById("weeklySummaryBody");

const scheduleHead = document.getElementById("scheduleHead");
const scheduleBody = document.getElementById("scheduleBody");
const autoAssignBtn = document.getElementById("autoAssignBtn");
const clearScheduleBtn = document.getElementById("clearScheduleBtn");
const scheduleStatus = document.getElementById("scheduleStatus");

const createWeeksBtn = document.getElementById("createWeeksBtn");
const setActiveBtn = document.getElementById("setActiveBtn");
const activeMonthLine = document.getElementById("activeMonthLine");
const monthStatus = document.getElementById("monthStatus");
const monthWeeksBody = document.getElementById("monthWeeksBody");
const monthWeeksEmpty = document.getElementById("monthWeeksEmpty");

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  console.log("[auth] Sign-in submitted");
  loginError.hidden = true;
  loginBtn.disabled = true;
  loginBtn.textContent = "Signing in…";
  try {
    await signInWithEmailAndPassword(auth, loginEmail.value.trim(), loginPassword.value);
    console.log("[auth] Sign-in succeeded");
  } catch (err) {
    console.warn("[auth] Sign-in failed:", err.code || err.message);
    loginError.textContent = "Sign-in failed: " + (err.message || "check your email/password.");
    loginError.hidden = false;
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Sign in";
  }
});

googleSignInBtn.addEventListener("click", async () => {
  console.log("[auth] Google sign-in requested");
  loginError.hidden = true;
  googleSignInBtn.disabled = true;
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
    console.log("[auth] Google sign-in succeeded");
  } catch (err) {
    console.warn("[auth] Google sign-in failed:", err.code || err.message);
    if (err.code !== "auth/popup-closed-by-user") {
      loginError.textContent = "Google sign-in failed: " + (err.message || "please try again.");
      loginError.hidden = false;
    }
  } finally {
    googleSignInBtn.disabled = false;
  }
});

signOutBtn.addEventListener("click", () => {
  console.log("[auth] Sign-out requested");
  signOut(auth);
});

// Client-side allowlist check. This is a convenience/UX layer only — the
// real enforcement is in firestore.rules (any signed-in Google account can
// reach this far, but Firestore itself rejects reads/writes from anyone
// not on the allowlist there). Keep this list in sync with the one in
// firestore.rules.
const ALLOWED_ADMIN_EMAILS = ["acatao2210@gmail.com"];

onAuthStateChanged(auth, async (user) => {
  if (user) {
    if (!ALLOWED_ADMIN_EMAILS.includes(user.email)) {
      console.warn("[auth] Signed-in account is not on the admin allowlist; signing out");
      loginError.textContent = "This Google account isn't authorized for admin access.";
      loginError.hidden = false;
      signOut(auth);
      return;
    }
    console.log("[auth] Auth state: signed in, loading dashboard");
    loginCard.hidden = true;
    dashboard.hidden = false;
    if (!monthInput.value) {
      // Defaults to whatever month the public form is currently asking about
      // (config/site.activeMonth in Firestore), so the dashboard opens on the
      // relevant month without you having to pick it. Falls back to the
      // current calendar month if nothing is live yet.
      try {
        await loadActiveMonth();
      } catch (err) {
        console.warn("[dashboard] Couldn't read the active month:", err.message);
      }
      const now = new Date();
      const thisMonth = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
      monthInput.value = activeMonth || thisMonth;
      console.log(`[dashboard] Defaulted month picker to ${monthInput.value}`);
    }
    refreshDashboard();
  } else {
    console.log("[auth] Auth state: signed out, showing login");
    loginCard.hidden = false;
    dashboard.hidden = true;
  }
});

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
let rosterList = [];       // [{ name, email, phone, roles }]
// { [deviceKey]: { names: { [rosterName]: { count, lastLinkedAt } } } }
// A device can be linked to more than one person over time (e.g. a shared
// family tablet) — we keep every name it's ever been linked to, each with
// its own count, rather than overwriting with just the most recent one.
let deviceLinksMap = {};

async function loadRoster() {
  console.log("[roster] Loading roster");
  const snap = await getDocs(collection(db, "roster"));
  rosterList = snap.docs.map((d) => ({ name: d.id, ...d.data() }));
  rosterList.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[roster] Loaded ${rosterList.length} roster entries`);
  if (rosterCount) {
    rosterCount.textContent = `${rosterList.length} people in roster`;
  }
}

// ---------------------------------------------------------------------------
// Roster import — reads a private-roster-data.json file straight from the
// browser and writes each entry to Firestore's roster collection. Runs
// entirely client-side, authenticated as the signed-in admin; no Node/CLI
// needed. Safe to re-run: writes are keyed by name, so existing entries
// just get overwritten, not duplicated.
// ---------------------------------------------------------------------------
function setRosterStatus(message, kind) {
  // kind: "info" | "success" | "error" — makes the outcome unmissable
  // instead of a small hint line that's easy to skim past.
  rosterImportStatus.hidden = false;
  rosterImportStatus.textContent = message;
  rosterImportStatus.classList.remove("roster-status-success", "roster-status-error");
  if (kind === "success") rosterImportStatus.classList.add("roster-status-success");
  if (kind === "error") rosterImportStatus.classList.add("roster-status-error");
}

importRosterBtn.addEventListener("click", async () => {
  console.log("[roster import] Import button clicked");
  const file = rosterFileInput.files?.[0];

  if (!file) {
    console.warn("[roster import] No file selected");
    setRosterStatus("Choose a JSON file first.", "error");
    return;
  }

  console.log("[roster import] File selected:", file.name, file.size, "bytes");
  importRosterBtn.disabled = true;
  setRosterStatus("Reading file…", "info");

  try {
    const text = await file.text();
    console.log("[roster import] File read, length:", text.length);

    const people = JSON.parse(text);
    console.log("[roster import] Parsed JSON, entries:", Array.isArray(people) ? people.length : typeof people);

    if (!Array.isArray(people)) {
      throw new Error("Expected a JSON array of { name, email, phone, roles } objects.");
    }

    setRosterStatus(`Uploading ${people.length} entries…`, "info");

    let count = 0;
    for (let i = 0; i < people.length; i++) {
      const person = people[i];
      if (!person.name || !person.name.trim()) {
        console.warn(`[roster import] Skipping entry ${i + 1} of ${people.length}: missing name`);
        continue;
      }
      console.log(`[roster import] Writing entry ${i + 1} of ${people.length}`);
      await setDoc(doc(db, "roster", person.name.trim()), person, { merge: true });
      count++;
    }

    await loadRoster();
    console.log("[roster import] Done. Wrote", count, "entries. Roster now has", rosterList.length, "people.");
    setRosterStatus(`✓ Imported ${count} roster entries. Roster now has ${rosterList.length} people.`, "success");
  } catch (err) {
    console.error("[roster import] Failed:", err);
    setRosterStatus("Import failed: " + err.message, "error");
  } finally {
    importRosterBtn.disabled = false;
  }
});

async function loadDeviceLinks() {
  console.log("[device-links] Loading device link records");
  const snap = await getDocs(collection(db, "deviceLinks"));
  deviceLinksMap = {};
  let migrated = 0;
  snap.docs.forEach((d) => {
    const data = d.data();
    // Normalize old single-name docs (from before multi-person devices
    // were supported) into the current { names: {...} } shape, so
    // previously-recorded links keep working.
    const names = { ...(data.names || {}) };
    if (data.rosterName && !names[data.rosterName]) {
      names[data.rosterName] = { count: data.linkCount || 1 };
      migrated++;
    }
    deviceLinksMap[d.id] = { names };
  });
  console.log(
    `[device-links] Loaded ${snap.docs.length} device records` +
      (migrated ? ` (migrated ${migrated} from old format)` : "")
  );
}

async function loadResponsesForMonth(month) {
  console.log(`[responses] Querying responses for month ${month}`);
  const q = query(collection(db, "responses"), where("month", "==", month));
  const snap = await getDocs(q);
  const responses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  console.log(`[responses] Query returned ${responses.length} responses; fetching metadata for each`);

  // Fetch each response's metadata doc in parallel (same ID, separate
  // collection — see submissionMeta rules/design).
  const metas = await Promise.all(
    responses.map((r) =>
      getDoc(doc(db, "submissionMeta", r.id)).then((snap) => (snap.exists() ? snap.data() : null))
    )
  );
  const metaHits = metas.filter(Boolean).length;
  console.log(`[responses] Metadata found for ${metaHits} of ${responses.length} responses`);

  return responses.map((r, i) => ({ ...r, meta: metas[i] }));
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------
async function applyLink(responseId, rosterName, linkStatus, deviceKey) {
  console.log(`[link] Writing ${linkStatus} link for response ${responseId}`);
  await updateDoc(doc(db, "responses", responseId), {
    linkedRosterName: rosterName,
    linkStatus,
    linkedAt: serverTimestamp(),
  });
  console.log(`[link] Response ${responseId} updated`);

  if (deviceKey) {
    // Nested merge: only this person's entry under `names` is touched,
    // so a device already linked to someone else keeps that entry too —
    // a device can be remembered as belonging to more than one person.
    console.log("[link] Updating device link record for this device");
    await setDoc(
      doc(db, "deviceLinks", deviceKey),
      {
        names: {
          [rosterName]: {
            count: increment(1),
            lastLinkedAt: serverTimestamp(),
          },
        },
        lastLinkedAt: serverTimestamp(),
      },
      { merge: true }
    );
    console.log("[link] Device link record updated");
  } else {
    console.log("[link] No device key on this response; skipping device link update");
  }
}

// Runs against whatever is currently loaded; auto-links confident matches
// and leaves the rest for manual review via the dropdown.
async function runAutoLink(items) {
  console.log(`[auto-link] Scanning ${items.length} responses for auto-link candidates`);
  let autoCount = 0;
  let skippedNoLink = 0;
  let skippedNoDevice = 0;
  let suggestedCount = 0;

  for (const item of items) {
    if (item.linkedRosterName) {
      skippedNoLink++;
      continue;
    }
    const deviceKey = item.meta?.deviceKey;
    if (!deviceKey) {
      skippedNoDevice++;
      continue;
    }
    const learned = deviceLinksMap[deviceKey];
    const candidateNames = learned ? Object.keys(learned.names || {}) : [];
    if (candidateNames.length === 0) continue;

    // A device can have been linked to more than one person (e.g. a
    // shared family tablet) — compare the typed name against everyone
    // that device has ever been linked to, and go with whichever is the
    // closest match, not just whoever was linked most recently.
    let best = null;
    for (const name of candidateNames) {
      const sim = nameSimilarity(item.rawName, name);
      if (!best || sim > best.sim) best = { name, sim };
    }

    // Relative sanity check: does someone else in the WHOLE roster (not
    // just this device's history) fit the typed name meaningfully better?
    // If so, the device-history match is probably a false positive (e.g.
    // a shared device previously linked to a different person with a
    // similar name) — don't auto-link it, and suggest the better-fitting
    // person instead.
    const rosterBest = findBestRosterMatch(item.rawName, best.name);
    const betterElsewhere = rosterBest && rosterBest.sim > best.sim + RELATIVE_PENALTY_MARGIN;

    const pct = Math.round(best.sim * 100);
    if (best.sim >= AUTO_LINK_THRESHOLD && !betterElsewhere) {
      console.log(`[auto-link] Response ${item.id}: auto-linking (${pct}% match against ${candidateNames.length} known device name(s))`);
      await applyLink(item.id, best.name, "auto", deviceKey);
      item.linkedRosterName = best.name;
      item.linkStatus = "auto";
      autoCount++;
    } else if (betterElsewhere) {
      // Surface the better-fitting roster name as the suggestion instead
      // of the device-history one that lost the comparison.
      const bestPct = Math.round(rosterBest.sim * 100);
      console.log(`[auto-link] Response ${item.id}: device match (${pct}%) beaten by a better roster-wide match (${bestPct}%), suggesting that instead`);
      item._suggestedName = rosterBest.name;
      item._suggestedSimilarity = rosterBest.sim;
      item._suggestionReason = "roster";
      suggestedCount++;
    } else {
      // Below threshold for every candidate: surface as an informational
      // hint only — the response stays unlinked (nothing written,
      // dropdown stays blank). The admin sees the typed name and this
      // hint side by side and picks manually.
      console.log(`[auto-link] Response ${item.id}: best match ${pct}% is below threshold, leaving unlinked with a hint`);
      item._suggestedName = best.name;
      item._suggestedSimilarity = best.sim;
      item._suggestionReason = "device";
      suggestedCount++;
    }
  }

  console.log(
    `[auto-link] Done: ${autoCount} auto-linked, ${suggestedCount} suggested only, ` +
      `${skippedNoLink} already linked, ${skippedNoDevice} had no device key`
  );
  return autoCount;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function formatTimestamp(ts) {
  if (!ts?.toDate) return "—";
  return ts.toDate().toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderRosterOptions(selectEl, selectedName) {
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "— unlinked —";
  selectEl.appendChild(blank);

  for (const person of rosterList) {
    const opt = document.createElement("option");
    opt.value = person.name;
    opt.textContent = person.name;
    if (person.name === selectedName) opt.selected = true;
    selectEl.appendChild(opt);
  }
}

function renderChips(responses, month) {
  const wrap = document.createElement("div");
  wrap.className = "chip-list";
  for (const r of responses || []) {
    if (!r.date?.startsWith(month)) continue;
    const chip = document.createElement("span");
    chip.className = `chip ${r.status}`;
    const day = r.date.slice(8, 10);
    chip.textContent = `${day}: ${r.status}`;
    wrap.appendChild(chip);
  }
  return wrap;
}

function renderMetaCell(meta) {
  if (!meta) return "—";
  const lines = [
    meta.deviceType || "?",
    [meta.city, meta.region, meta.country].filter(Boolean).join(", ") || null,
    meta.ip || null,
    meta.deviceKey ? `key: ${meta.deviceKey.slice(0, 8)}…` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

function renderTable(items, month) {
  console.log(`[render] Rendering responses table: ${items.length} rows for ${month}`);
  responsesBody.innerHTML = "";
  emptyState.hidden = items.length > 0;

  for (const item of items) {
    const tr = document.createElement("tr");

    const submittedTd = document.createElement("td");
    submittedTd.textContent = formatTimestamp(item.submittedAt);
    tr.appendChild(submittedTd);

    const nameTd = document.createElement("td");
    nameTd.textContent = item.rawName || "—";
    tr.appendChild(nameTd);

    const linkTd = document.createElement("td");
    const select = document.createElement("select");
    select.className = "link-select";
    // Only a confirmed link preselects the dropdown. A below-threshold
    // suggestion never does — it stays genuinely unlinked until the admin
    // actively picks someone, which matters most when a device is shared
    // by two different people (spouses, a family tablet, etc.): a weak
    // match there would otherwise silently point at the wrong person.
    renderRosterOptions(select, item.linkedRosterName || "");

    const badge = document.createElement("span");
    badge.className = "link-badge";
    if (item.linkedRosterName) {
      badge.classList.add(item.linkStatus === "auto" ? "auto" : "manual");
      badge.textContent = item.linkStatus === "auto" ? "Auto-linked" : "Linked";
    } else {
      badge.classList.add("unlinked");
      badge.textContent = "Unlinked";
    }

    let suggestionHint = null;
    if (!item.linkedRosterName && item._suggestedName) {
      suggestionHint = document.createElement("span");
      suggestionHint.className = "suggestion-hint";
      const pct = Math.round((item._suggestedSimilarity || 0) * 100);
      suggestionHint.textContent =
        item._suggestionReason === "roster"
          ? `"${item._suggestedName}" (${pct}% name match) fits better than this device's linking history — pick manually if that's right.`
          : `This device was last linked to "${item._suggestedName}" (${pct}% name match) — pick manually if that's right.`;
    }

    select.addEventListener("change", async () => {
      console.log(`[link] Dropdown changed for response ${item.id}`);
      const newName = select.value || null;
      const previousName = item.linkedRosterName || "";

      // Sanity checks: warn (don't silently block) if either —
      //  (a) the typed name doesn't look much like the roster name being
      //      picked (catches fat-finger dropdown mistakes), or
      //  (b) some OTHER roster name fits the typed name meaningfully
      //      better (catches picking "Mike Rallo" when "Mary Rallo" — an
      //      exact match — was sitting right there in the dropdown).
      if (newName) {
        const sim = nameSimilarity(item.rawName, newName);
        const rosterBest = findBestRosterMatch(item.rawName, newName);
        const betterElsewhere = rosterBest && rosterBest.sim > sim + RELATIVE_PENALTY_MARGIN;

        if (sim < MANUAL_LINK_WARN_THRESHOLD || betterElsewhere) {
          const pct = Math.round(sim * 100);
          console.log(
            `[link] Response ${item.id}: selection needs confirmation ` +
              `(${pct}% match${betterElsewhere ? ", better match exists elsewhere" : ""})`
          );
          let message = `"${item.rawName}" doesn't look much like "${newName}" (similarity ${pct}%).`;
          if (betterElsewhere) {
            const bestPct = Math.round(rosterBest.sim * 100);
            message = `"${item.rawName}" looks like a better match for "${rosterBest.name}" (${bestPct}%) than "${newName}" (${pct}%).`;
          }
          const proceed = confirm(message + " Link anyway?");
          if (!proceed) {
            console.log(`[link] Response ${item.id}: selection cancelled by admin`);
            select.value = previousName;
            return;
          }
          console.log(`[link] Response ${item.id}: selection confirmed by admin despite warning`);
        }
      }

      select.disabled = true;
      try {
        if (newName) {
          console.log(`[link] Response ${item.id}: saving manual link`);
          await applyLink(item.id, newName, "manual", item.meta?.deviceKey);
          item.linkedRosterName = newName;
          item.linkStatus = "manual";
        } else {
          console.log(`[link] Response ${item.id}: clearing link`);
          await updateDoc(doc(db, "responses", item.id), {
            linkedRosterName: null,
            linkStatus: null,
            linkedAt: serverTimestamp(),
          });
          item.linkedRosterName = null;
          item.linkStatus = null;
          console.log(`[link] Response ${item.id}: link cleared`);
        }
        renderAll(items, month);
      } catch (err) {
        console.error(`[link] Response ${item.id}: failed to save link change:`, err.message);
        dashboardError.textContent = "Failed to save link: " + err.message;
        dashboardError.hidden = false;
      } finally {
        select.disabled = false;
      }
    });

    linkTd.appendChild(select);
    linkTd.appendChild(document.createElement("br"));
    linkTd.appendChild(badge);
    if (suggestionHint) {
      linkTd.appendChild(document.createElement("br"));
      linkTd.appendChild(suggestionHint);
    }
    tr.appendChild(linkTd);

    const availTd = document.createElement("td");
    availTd.appendChild(renderChips(item.responses, month));
    tr.appendChild(availTd);

    const notesTd = document.createElement("td");
    notesTd.className = "notes-cell";
    notesTd.textContent = item.notes || "—";
    tr.appendChild(notesTd);

    const metaTd = document.createElement("td");
    metaTd.className = "meta-cell";
    metaTd.style.whiteSpace = "pre-line";
    metaTd.textContent = renderMetaCell(item.meta);
    tr.appendChild(metaTd);

    const actionsTd = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "delete-btn";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      console.log(`[delete] Delete requested for response ${item.id}`);
      if (!confirm(`Delete this submission from "${item.rawName}"? This can't be undone.`)) {
        console.log(`[delete] Response ${item.id}: cancelled by admin`);
        return;
      }
      try {
        console.log(`[delete] Response ${item.id}: deleting response document`);
        await deleteDoc(doc(db, "responses", item.id));
        console.log(`[delete] Response ${item.id}: deleting metadata document`);
        await deleteDoc(doc(db, "submissionMeta", item.id)).catch((err) => {
          console.warn(`[delete] Response ${item.id}: metadata delete failed (may not have existed):`, err.message);
        });
        console.log(`[delete] Response ${item.id}: deleted, refreshing dashboard`);
        await refreshDashboard();
      } catch (err) {
        console.error(`[delete] Response ${item.id}: delete failed:`, err.message);
        dashboardError.textContent = "Failed to delete: " + err.message;
        dashboardError.hidden = false;
      }
    });
    actionsTd.appendChild(delBtn);
    tr.appendChild(actionsTd);

    responsesBody.appendChild(tr);
  }
}

function renderSummary(items) {
  const total = items.length;
  const auto = items.filter((i) => i.linkStatus === "auto").length;
  const manual = items.filter((i) => i.linkStatus === "manual").length;
  const unlinked = total - auto - manual;
  console.log(`[render] Rendering summary line: ${total} total, ${auto} auto, ${manual} manual, ${unlinked} unlinked`);
  summaryLine.textContent =
    `${total} submission${total === 1 ? "" : "s"} — ` +
    `${auto} auto-linked, ${manual} manually linked, ${unlinked} unlinked.`;
}

// ---------------------------------------------------------------------------
// Weekly roster summary — "who do I have, per role, per Sunday"
// ---------------------------------------------------------------------------
const ROLE_LIST = ["Lector", "Extraordinary Minister", "Collector"];

// How many people are needed per role for a single Sunday Mass. Used by
// both the weekly summary (implicitly) and the schedule builder below.
// Adjust these numbers if your Mass staffing needs change.
const ROLE_SLOTS = {
  Lector: 2,
  "Extraordinary Minister": 2,
  Collector: 1,
};

// Roles exempt from the "don't repeat the same person on back-to-back
// Sundays" fairness rule during auto-assign. Collector is exempt to match
// how this parish's other scheduling tools treat it.
const ROTATION_EXEMPT_ROLES = new Set(["Collector"]);

function pad2(n) {
  return String(n).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Availability month
//
// Which month the public form asks about used to be a constant in config.js,
// which meant opening a new month was a code edit plus a redeploy. It now
// lives in Firestore in two docs:
//
//   config/site        { activeMonth: "2026-08" }   <- what the form reads
//   months/{YYYY-MM}   { month, weeks: [ ... ] }    <- that month's Sundays
//
// Both are publicly readable (the form needs them before anyone signs in)
// and admin-only to write. Titles are generated from the Church calendar by
// liturgical.js and are hand-editable here before they go live.
// ---------------------------------------------------------------------------
let activeMonth = null;
let currentMonthWeeks = []; // [{ date, label, title, usccbUrl }]

function setMonthStatus(message, kind) {
  if (!monthStatus) return;
  monthStatus.hidden = false;
  monthStatus.textContent = message;
  monthStatus.classList.remove("roster-status-success", "roster-status-error");
  if (kind === "success") monthStatus.classList.add("roster-status-success");
  if (kind === "error") monthStatus.classList.add("roster-status-error");
}

function monthLabel(yearMonth) {
  if (!yearMonth) return "(none)";
  const [y, m] = yearMonth.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

async function loadActiveMonth() {
  console.log("[months] Loading active month from config/site");
  const snap = await getDoc(doc(db, "config", "site"));
  activeMonth = snap.exists() ? snap.data().activeMonth || null : null;
  console.log(`[months] Active month is ${activeMonth || "(not set)"}`);
}

async function loadMonthWeeks(month) {
  console.log(`[months] Loading weeks for ${month}`);
  const snap = await getDoc(doc(db, "months", month));
  currentMonthWeeks =
    snap.exists() && Array.isArray(snap.data().weeks) ? snap.data().weeks : [];
  console.log(`[months] Loaded ${currentMonthWeeks.length} weeks for ${month}`);
}

async function writeMonthWeeks(month, weeks) {
  console.log(`[months] Writing ${weeks.length} weeks for ${month}`);
  await setDoc(
    doc(db, "months", month),
    { month, weeks, updatedAt: serverTimestamp() },
    { merge: true }
  );
  currentMonthWeeks = weeks;
  console.log(`[months] Weeks for ${month} saved`);
}

function renderMonthWeeks(month) {
  if (!monthWeeksBody) return;
  monthWeeksBody.innerHTML = "";

  if (activeMonthLine) {
    if (!activeMonth) {
      activeMonthLine.textContent =
        "No month is open to the parish right now — the public form is showing a “check back soon” message.";
    } else if (activeMonth === month) {
      activeMonthLine.textContent = `${monthLabel(month)} is live on the public form.`;
    } else {
      activeMonthLine.textContent = `Currently live on the public form: ${monthLabel(
        activeMonth
      )}. You're viewing ${monthLabel(month)}.`;
    }
  }

  if (setActiveBtn) {
    const alreadyLive = activeMonth === month;
    setActiveBtn.disabled = alreadyLive || currentMonthWeeks.length === 0;
    setActiveBtn.textContent = alreadyLive ? "Already live" : "Open to the parish";
  }

  if (!currentMonthWeeks.length) {
    if (monthWeeksEmpty) monthWeeksEmpty.hidden = false;
    console.log(`[render] Month ${month} has no weeks yet`);
    return;
  }
  if (monthWeeksEmpty) monthWeeksEmpty.hidden = true;

  console.log(`[render] Rendering ${currentMonthWeeks.length} weeks for ${month}`);

  currentMonthWeeks.forEach((week, index) => {
    const tr = document.createElement("tr");

    const dateTd = document.createElement("td");
    dateTd.className = "week-date-cell";
    dateTd.textContent = week.label || week.date;
    tr.appendChild(dateTd);

    // Title is a live-editable field. Blur (not keystroke) triggers the save,
    // so typing doesn't fire a write per character.
    const titleTd = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "week-title-input";
    input.value = week.title || "";
    input.placeholder = "e.g. Fifteenth Sunday in Ordinary Time";
    input.addEventListener("change", async () => {
      const newTitle = input.value.trim();
      if (newTitle === (week.title || "")) return;
      console.log(`[months] Title edited for ${week.date}`);
      const updated = currentMonthWeeks.map((w, i) =>
        i === index ? { ...w, title: newTitle } : w
      );
      try {
        await writeMonthWeeks(month, updated);
        setMonthStatus(`Saved the title for ${week.label || week.date}.`, "success");
      } catch (err) {
        console.error(`[months] Failed to save title for ${week.date}:`, err.message);
        setMonthStatus("Couldn't save that title: " + err.message, "error");
      }
    });
    titleTd.appendChild(input);
    tr.appendChild(titleTd);

    // Direct link to the USCCB page for that date, so a title can be
    // eyeballed against the source in one click.
    const linkTd = document.createElement("td");
    const link = document.createElement("a");
    link.href = week.usccbUrl || "#";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "usccb-link";
    link.textContent = "USCCB ↗";
    linkTd.appendChild(link);
    tr.appendChild(linkTd);

    monthWeeksBody.appendChild(tr);
  });
}

// Returns ISO date *strings* ("2026-08-02"), which is what the schedule and
// summary code keys everything off. Distinct from liturgical.js's
// getSundaysInMonth, which returns Date objects for calendar arithmetic.
function getSundayIsoDates(month) {
  const [year, m] = month.split("-").map(Number);
  const dates = [];
  const d = new Date(year, m - 1, 1);
  while (d.getMonth() === m - 1) {
    if (d.getDay() === 0) {
      dates.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`);
    }
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function formatShortDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function renderWeeklySummary(items, month) {
  if (!weeklySummaryHead || !weeklySummaryBody) return;

  const sundays = getSundayIsoDates(month);
  console.log(`[render] Rendering weekly summary: ${ROLE_LIST.length} roles x ${sundays.length} Sundays`);
  const rosterByName = new Map(rosterList.map((p) => [p.name, p]));

  weeklySummaryHead.innerHTML = "";
  const roleTh = document.createElement("th");
  roleTh.textContent = "Role";
  weeklySummaryHead.appendChild(roleTh);
  for (const date of sundays) {
    const th = document.createElement("th");
    th.textContent = formatShortDate(date);
    weeklySummaryHead.appendChild(th);
  }

  weeklySummaryBody.innerHTML = "";

  for (const role of ROLE_LIST) {
    const tr = document.createElement("tr");
    const roleTd = document.createElement("td");
    roleTd.className = "role-cell";
    roleTd.textContent = role;
    tr.appendChild(roleTd);

    for (const date of sundays) {
      const td = document.createElement("td");
      const matches = [];

      for (const item of items) {
        if (!item.linkedRosterName) continue;
        const person = rosterByName.get(item.linkedRosterName);
        if (!person?.roles?.includes(role)) continue;
        const resp = (item.responses || []).find((r) => r.date === date);
        if (!resp || resp.status === "no") continue;
        matches.push({ name: item.linkedRosterName, status: resp.status });
      }

      if (matches.length === 0) {
        const empty = document.createElement("span");
        empty.className = "summary-empty";
        empty.textContent = "—";
        td.appendChild(empty);
      } else {
        matches.sort((a, b) => a.name.localeCompare(b.name));
        const list = document.createElement("div");
        list.className = "summary-name-list";
        for (const m of matches) {
          const span = document.createElement("span");
          span.className = `summary-name ${m.status}`;
          span.textContent = m.status === "maybe" ? `${m.name} (maybe)` : m.name;
          list.appendChild(span);
        }
        td.appendChild(list);
      }
      tr.appendChild(td);
    }
    weeklySummaryBody.appendChild(tr);
  }

  // Unlinked-but-answered row, so you don't miss someone who hasn't been
  // linked to a roster identity yet.
  const unlinkedTr = document.createElement("tr");
  const unlinkedLabelTd = document.createElement("td");
  unlinkedLabelTd.className = "role-cell";
  unlinkedLabelTd.textContent = "Unlinked";
  unlinkedTr.appendChild(unlinkedLabelTd);

  for (const date of sundays) {
    const td = document.createElement("td");
    const count = items.filter((item) => {
      if (item.linkedRosterName) return false;
      const resp = (item.responses || []).find((r) => r.date === date);
      return resp && resp.status !== "no";
    }).length;

    if (count === 0) {
      const empty = document.createElement("span");
      empty.className = "summary-empty";
      empty.textContent = "—";
      td.appendChild(empty);
    } else {
      const note = document.createElement("span");
      note.className = "summary-unlinked-note";
      note.textContent = `${count} unlinked`;
      td.appendChild(note);
    }
    unlinkedTr.appendChild(td);
  }
  weeklySummaryBody.appendChild(unlinkedTr);
}

// ---------------------------------------------------------------------------
// Schedule — turns "who's available" into actual role assignments.
//
// Stored in Firestore at schedules/{month}, shaped as:
//   { [date]: { [role]: [name|null, name|null, ...] } }
// Each role's array length matches ROLE_SLOTS[role] (or is longer if the
// slot count was reduced after assignments already existed — nothing is
// ever silently discarded).
// ---------------------------------------------------------------------------
let currentSchedule = {}; // { [date]: { [role]: [name|null, ...] } }

function slotCountFor(role, existingArray) {
  return Math.max(ROLE_SLOTS[role] || 1, existingArray?.length || 0);
}

// Fills in any missing dates/roles/slots with nulls so every date in the
// month has a consistent, fully-shaped entry to render and write against.
function normalizeSchedule(raw, sundays) {
  const normalized = {};
  for (const date of sundays) {
    const rawDate = raw?.[date] || {};
    normalized[date] = {};
    for (const role of ROLE_LIST) {
      const existing = Array.isArray(rawDate[role]) ? rawDate[role].slice() : [];
      const count = slotCountFor(role, existing);
      while (existing.length < count) existing.push(null);
      normalized[date][role] = existing;
    }
  }
  return normalized;
}

function getPreviousMonthKey(month) {
  const [year, m] = month.split("-").map(Number);
  const d = new Date(year, m - 2, 1); // m is 1-based; m-2 = previous month, 0-based
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

async function loadSchedule(month) {
  console.log(`[schedule] Loading schedule for ${month}`);
  const snap = await getDoc(doc(db, "schedules", month));
  const sundays = getSundayIsoDates(month);
  currentSchedule = normalizeSchedule(snap.exists() ? snap.data() : {}, sundays);
  console.log(`[schedule] Loaded schedule for ${sundays.length} Sundays`);
}

// Looks at the previous month's schedule doc (if any) to find who served
// each rotation-sensitive role on its last Sunday — so the "don't repeat
// back-to-back" rule also respects the boundary between months, not just
// within the currently-viewed one.
async function loadPreviousMonthLastAssignments(month) {
  const prevMonth = getPreviousMonthKey(month);
  console.log(`[schedule] Checking ${prevMonth} for rotation continuity`);
  const snap = await getDoc(doc(db, "schedules", prevMonth));
  if (!snap.exists()) {
    console.log(`[schedule] No schedule found for ${prevMonth}; rotation starts fresh`);
    return {};
  }
  const data = snap.data();
  const dates = Object.keys(data).sort();
  if (dates.length === 0) return {};
  const lastDate = dates[dates.length - 1];
  console.log(`[schedule] Using ${lastDate} (last Sunday of ${prevMonth}) for rotation continuity`);
  const lastDay = data[lastDate] || {};
  const result = {};
  for (const role of ROLE_LIST) {
    if (ROTATION_EXEMPT_ROLES.has(role)) continue;
    result[role] = new Set((lastDay[role] || []).filter(Boolean));
  }
  return result;
}

// Writes one role's full slot array for one date. Nested merge means only
// this date+role is touched — everything else in the month doc (other
// dates, other roles) is left exactly as it was.
async function writeScheduleSlot(month, date, role, updatedArray) {
  console.log(`[schedule] Writing ${role} slots for ${date}`);
  currentSchedule[date][role] = updatedArray;
  await setDoc(
    doc(db, "schedules", month),
    { [date]: { [role]: updatedArray } },
    { merge: true }
  );
  console.log(`[schedule] Saved ${role} slots for ${date}`);
}

// Builds, for every date+role, the pool of roster people who are linked,
// have that role, and answered yes/maybe for that date. "yes" candidates
// are listed before "maybe" ones so auto-assign prefers them.
function buildAvailabilityPools(items, sundays) {
  const rosterByName = new Map(rosterList.map((p) => [p.name, p]));
  const pools = {}; // { [date]: { [role]: [{name, status}, ...] } }
  for (const date of sundays) {
    pools[date] = {};
    for (const role of ROLE_LIST) pools[date][role] = [];
  }
  for (const item of items) {
    if (!item.linkedRosterName) continue;
    const person = rosterByName.get(item.linkedRosterName);
    if (!person?.roles) continue;
    for (const resp of item.responses || []) {
      if (!pools[resp.date] || resp.status === "no") continue;
      for (const role of person.roles) {
        if (!(role in pools[resp.date])) continue;
        pools[resp.date][role].push({ name: item.linkedRosterName, status: resp.status });
      }
    }
  }
  for (const date of sundays) {
    for (const role of ROLE_LIST) {
      pools[date][role].sort((a, b) => (a.status === b.status ? 0 : a.status === "yes" ? -1 : 1));
    }
  }
  return pools;
}

// The auto-assign algorithm. Only fills slots that are currently empty —
// it never overwrites an existing assignment (manual or from a previous
// auto-assign run), so re-running it after linking more submissions is
// always safe.
async function autoAssignSchedule(items, month) {
  const sundays = getSundayIsoDates(month);
  console.log(`[schedule] Auto-assign starting for ${sundays.length} Sundays`);

  const pools = buildAvailabilityPools(items, sundays);
  const prevAssignments = await loadPreviousMonthLastAssignments(month);
  const assignmentCounts = {}; // { [name]: count this month so far } — for fairness tie-breaking

  // Seed assignmentCounts and prevAssignments with whatever is already
  // filled in (manual edits or earlier auto-assign runs), so new picks
  // are fairly balanced against the full picture, not just what this run
  // adds.
  for (const date of sundays) {
    for (const role of ROLE_LIST) {
      for (const name of currentSchedule[date][role]) {
        if (name) assignmentCounts[name] = (assignmentCounts[name] || 0) + 1;
      }
    }
  }

  let filledCount = 0;
  let gapCount = 0;
  let relaxedRotationCount = 0;

  for (const date of sundays) {
    const assignedToday = new Set();
    for (const role of ROLE_LIST) {
      for (const name of currentSchedule[date][role]) {
        if (name) assignedToday.add(name);
      }
    }

    for (const role of ROLE_LIST) {
      const slots = currentSchedule[date][role];
      const rotationExcluded = ROTATION_EXEMPT_ROLES.has(role) ? new Set() : prevAssignments[role] || new Set();

      for (let i = 0; i < slots.length; i++) {
        if (slots[i]) continue; // never overwrite an existing assignment

        const pool = pools[date][role] || [];
        const pickFrom = (excludeRotation) =>
          pool.filter(
            (c) =>
              !assignedToday.has(c.name) &&
              !slots.includes(c.name) &&
              (!excludeRotation || !rotationExcluded.has(c.name))
          );

        let candidates = pickFrom(true);
        let relaxed = false;
        if (candidates.length === 0 && rotationExcluded.size > 0) {
          candidates = pickFrom(false);
          relaxed = candidates.length > 0;
        }

        if (candidates.length === 0) {
          gapCount++;
          console.log(`[schedule] ${date} ${role} slot ${i + 1}: no eligible candidate, leaving as a gap`);
          continue;
        }

        candidates.sort((a, b) => {
          if (a.status !== b.status) return a.status === "yes" ? -1 : 1;
          const countDiff = (assignmentCounts[a.name] || 0) - (assignmentCounts[b.name] || 0);
          if (countDiff !== 0) return countDiff;
          return a.name.localeCompare(b.name);
        });

        const picked = candidates[0];
        slots[i] = picked.name;
        assignedToday.add(picked.name);
        assignmentCounts[picked.name] = (assignmentCounts[picked.name] || 0) + 1;
        filledCount++;
        if (relaxed) {
          relaxedRotationCount++;
          console.log(`[schedule] ${date} ${role} slot ${i + 1}: filled, relaxing rotation rule (no other candidate available)`);
        } else {
          console.log(`[schedule] ${date} ${role} slot ${i + 1}: filled`);
        }
      }
    }

    // What was assigned today (for rotation-sensitive roles) becomes the
    // exclusion set for next Sunday.
    for (const role of ROLE_LIST) {
      if (ROTATION_EXEMPT_ROLES.has(role)) continue;
      prevAssignments[role] = new Set(currentSchedule[date][role].filter(Boolean));
    }
  }

  console.log(
    `[schedule] Auto-assign done: ${filledCount} slots filled ` +
      `(${relaxedRotationCount} with rotation relaxed), ${gapCount} still need coverage`
  );

  await setDoc(doc(db, "schedules", month), currentSchedule, { merge: true });
  console.log("[schedule] Auto-assign results saved");

  return { filledCount, gapCount, relaxedRotationCount };
}

function renderSchedule(items, month) {
  if (!scheduleHead || !scheduleBody) return;

  const sundays = getSundayIsoDates(month);
  console.log(`[render] Rendering schedule: ${sundays.length} Sundays`);
  const pools = buildAvailabilityPools(items, sundays);
  const rosterByRole = {};
  for (const role of ROLE_LIST) {
    rosterByRole[role] = rosterList.filter((p) => p.roles?.includes(role)).map((p) => p.name);
  }

  // Detect same-day double-bookings (a person in more than one role slot
  // on the same date) so they can be flagged, regardless of whether they
  // got there via auto-assign or a manual override.
  const conflictsByDate = {};
  for (const date of sundays) {
    const counts = {};
    for (const role of ROLE_LIST) {
      for (const name of currentSchedule[date][role]) {
        if (name) counts[name] = (counts[name] || 0) + 1;
      }
    }
    conflictsByDate[date] = new Set(Object.keys(counts).filter((n) => counts[n] > 1));
  }

  scheduleHead.innerHTML = "";
  const roleTh = document.createElement("th");
  roleTh.textContent = "Role";
  scheduleHead.appendChild(roleTh);
  for (const date of sundays) {
    const th = document.createElement("th");
    th.textContent = formatShortDate(date);
    scheduleHead.appendChild(th);
  }

  scheduleBody.innerHTML = "";

  for (const role of ROLE_LIST) {
    const slotCount = Math.max(
      ROLE_SLOTS[role] || 1,
      ...sundays.map((d) => currentSchedule[d][role].length)
    );

    for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
      const tr = document.createElement("tr");
      const labelTd = document.createElement("td");
      labelTd.className = "role-cell";
      labelTd.textContent = slotCount > 1 ? `${role} ${slotIndex + 1}` : role;
      tr.appendChild(labelTd);

      for (const date of sundays) {
        const td = document.createElement("td");
        const slots = currentSchedule[date][role];
        while (slots.length <= slotIndex) slots.push(null);
        const currentName = slots[slotIndex];

        const select = document.createElement("select");
        select.className = "schedule-select";

        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = "— needs coverage —";
        select.appendChild(blank);

        const availableNames = new Set((pools[date][role] || []).map((c) => c.name));
        const availableGroup = document.createElement("optgroup");
        availableGroup.label = "Available";
        const otherGroup = document.createElement("optgroup");
        otherGroup.label = "Other roster members";

        for (const name of rosterByRole[role]) {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = availableNames.has(name)
            ? name + ((pools[date][role].find((c) => c.name === name)?.status) === "maybe" ? " (maybe)" : "")
            : name;
          if (name === currentName) opt.selected = true;
          (availableNames.has(name) ? availableGroup : otherGroup).appendChild(opt);
        }
        if (availableGroup.children.length) select.appendChild(availableGroup);
        if (otherGroup.children.length) select.appendChild(otherGroup);

        const isConflict = currentName && conflictsByDate[date].has(currentName);
        select.classList.toggle("slot-gap", !currentName);
        select.classList.toggle("slot-conflict", !!isConflict);

        select.addEventListener("change", async () => {
          console.log(`[schedule] Slot changed: ${date} / ${role} / slot ${slotIndex + 1}`);
          const newName = select.value || null;
          const updated = currentSchedule[date][role].slice();
          updated[slotIndex] = newName;
          select.disabled = true;
          try {
            await writeScheduleSlot(month, date, role, updated);
            renderSchedule(currentItems, month);
          } catch (err) {
            console.error(`[schedule] Failed to save slot change:`, err.message);
            dashboardError.textContent = "Failed to save schedule change: " + err.message;
            dashboardError.hidden = false;
          } finally {
            select.disabled = false;
          }
        });

        td.appendChild(select);
        if (isConflict) {
          const warn = document.createElement("span");
          warn.className = "slot-warning";
          warn.textContent = "Double-booked today";
          td.appendChild(warn);
        }
        tr.appendChild(td);
      }
      scheduleBody.appendChild(tr);
    }
  }
}

// Renders every view that depends on the current data set — keeps the
// table, the weekly summary, the schedule, and the header line all in sync.
function renderAll(items, month) {
  renderMonthWeeks(month);
  renderTable(items, month);
  renderWeeklySummary(items, month);
  renderSchedule(items, month);
  renderSummary(items);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
let currentItems = [];

async function refreshDashboard() {
  const month = monthInput.value;
  console.log(`[dashboard] Refresh started for month ${month || "(none selected)"}`);
  dashboardError.hidden = true;
  summaryLine.textContent = "Loading…";
  responsesBody.innerHTML = "";
  if (!month) {
    console.warn("[dashboard] Refresh aborted: no month selected");
    return;
  }

  try {
    console.log("[dashboard] Loading roster, device links, month, and schedule in parallel");
    await Promise.all([
      loadRoster(),
      loadDeviceLinks(),
      loadSchedule(month),
      loadActiveMonth(),
      loadMonthWeeks(month),
    ]);
    currentItems = await loadResponsesForMonth(month);
    await runAutoLink(currentItems);
    renderAll(currentItems, month);
    console.log(`[dashboard] Refresh complete: ${currentItems.length} items loaded`);
  } catch (err) {
    console.error("[dashboard] Refresh failed:", err.message);
    dashboardError.textContent = "Failed to load data: " + err.message;
    dashboardError.hidden = false;
    summaryLine.textContent = "";
  }
}

refreshBtn.addEventListener("click", () => {
  console.log("[dashboard] Refresh button clicked");
  refreshDashboard();
});
monthInput.addEventListener("change", () => {
  console.log(`[dashboard] Month picker changed to ${monthInput.value}`);
  refreshDashboard();
});

autoLinkBtn.addEventListener("click", async () => {
  console.log("[auto-link] Manual auto-link run triggered");
  autoLinkBtn.disabled = true;
  autoLinkBtn.textContent = "Running…";
  try {
    await loadDeviceLinks();
    const count = await runAutoLink(currentItems);
    renderAll(currentItems, monthInput.value);
    summaryLine.textContent += ` (${count} newly auto-linked)`;
    console.log(`[auto-link] Manual run complete: ${count} newly auto-linked`);
  } catch (err) {
    console.error("[auto-link] Manual run failed:", err.message);
    dashboardError.textContent = "Auto-link failed: " + err.message;
    dashboardError.hidden = false;
  } finally {
    autoLinkBtn.disabled = false;
    autoLinkBtn.textContent = "Run auto-link";
  }
});

function setScheduleStatus(message, kind) {
  if (!scheduleStatus) return;
  scheduleStatus.hidden = false;
  scheduleStatus.textContent = message;
  scheduleStatus.classList.remove("roster-status-success", "roster-status-error");
  if (kind === "success") scheduleStatus.classList.add("roster-status-success");
  if (kind === "error") scheduleStatus.classList.add("roster-status-error");
}

autoAssignBtn?.addEventListener("click", async () => {
  console.log("[schedule] Auto-assign button clicked");
  const month = monthInput.value;
  if (!month) return;
  autoAssignBtn.disabled = true;
  autoAssignBtn.textContent = "Assigning…";
  setScheduleStatus("Auto-assigning open slots…", "info");
  try {
    const { filledCount, gapCount, relaxedRotationCount } = await autoAssignSchedule(currentItems, month);
    renderSchedule(currentItems, month);
    let message = `✓ Filled ${filledCount} slot${filledCount === 1 ? "" : "s"}.`;
    if (relaxedRotationCount) {
      message += ` ${relaxedRotationCount} needed the back-to-back rule relaxed (no other candidate available).`;
    }
    if (gapCount) {
      message += ` ${gapCount} slot${gapCount === 1 ? "" : "s"} still need${gapCount === 1 ? "s" : ""} coverage — nobody available/linked yet.`;
    }
    setScheduleStatus(message, gapCount ? "error" : "success");
    console.log(`[schedule] Auto-assign complete: ${filledCount} filled, ${gapCount} gaps, ${relaxedRotationCount} relaxed`);
  } catch (err) {
    console.error("[schedule] Auto-assign failed:", err.message);
    setScheduleStatus("Auto-assign failed: " + err.message, "error");
  } finally {
    autoAssignBtn.disabled = false;
    autoAssignBtn.textContent = "Auto-assign";
  }
});

createWeeksBtn?.addEventListener("click", async () => {
  const month = monthInput.value;
  if (!month) return;
  console.log(`[months] Create-weeks clicked for ${month}`);

  // Regenerating would blow away any title you'd corrected by hand, so the
  // existing set has to be confirmed away explicitly.
  if (currentMonthWeeks.length) {
    if (
      !confirm(
        `${monthLabel(month)} already has ${currentMonthWeeks.length} weeks set up. ` +
          `Regenerate them from the Church calendar? Any titles you edited by hand will be replaced.`
      )
    ) {
      console.log("[months] Create-weeks cancelled by admin");
      return;
    }
  }

  createWeeksBtn.disabled = true;
  createWeeksBtn.textContent = "Creating…";
  try {
    const weeks = buildWeeksForMonth(month);
    console.log(`[months] Generated ${weeks.length} weeks with computed titles`);
    await writeMonthWeeks(month, weeks);
    renderMonthWeeks(month);
    setMonthStatus(
      `✓ Created ${weeks.length} week${weeks.length === 1 ? "" : "s"} for ${monthLabel(
        month
      )}. Check each title against its USCCB link, then open the month to the parish.`,
      "success"
    );
  } catch (err) {
    console.error("[months] Create-weeks failed:", err.message);
    setMonthStatus("Couldn't create the weeks: " + err.message, "error");
  } finally {
    createWeeksBtn.disabled = false;
    createWeeksBtn.textContent = "Create weeks";
  }
});

setActiveBtn?.addEventListener("click", async () => {
  const month = monthInput.value;
  if (!month) return;
  console.log(`[months] Set-active clicked for ${month}`);

  if (!currentMonthWeeks.length) {
    setMonthStatus("Create this month's weeks before opening it to the parish.", "error");
    return;
  }
  if (
    !confirm(
      `Make ${monthLabel(month)} the month the public form asks about?` +
        (activeMonth ? ` This replaces ${monthLabel(activeMonth)}.` : "")
    )
  ) {
    console.log("[months] Set-active cancelled by admin");
    return;
  }

  setActiveBtn.disabled = true;
  setActiveBtn.textContent = "Opening…";
  try {
    await setDoc(
      doc(db, "config", "site"),
      { activeMonth: month, updatedAt: serverTimestamp() },
      { merge: true }
    );
    activeMonth = month;
    renderMonthWeeks(month);
    setMonthStatus(
      `✓ ${monthLabel(month)} is now live — the public form is asking about its ${
        currentMonthWeeks.length
      } Sundays.`,
      "success"
    );
    console.log(`[months] Active month set to ${month}`);
  } catch (err) {
    console.error("[months] Set-active failed:", err.message);
    setMonthStatus("Couldn't open that month: " + err.message, "error");
    setActiveBtn.disabled = false;
    setActiveBtn.textContent = "Open to the parish";
  }
});

clearScheduleBtn?.addEventListener("click", async () => {
  console.log("[schedule] Clear schedule requested");
  const month = monthInput.value;
  if (!month) return;
  if (!confirm(`Clear the entire schedule for ${month}? This removes every assignment (auto and manual) and can't be undone.`)) {
    console.log("[schedule] Clear schedule cancelled by admin");
    return;
  }
  clearScheduleBtn.disabled = true;
  try {
    console.log(`[schedule] Deleting schedule document for ${month}`);
    await deleteDoc(doc(db, "schedules", month));
    await loadSchedule(month);
    renderSchedule(currentItems, month);
    setScheduleStatus("Schedule cleared.", "success");
    console.log("[schedule] Schedule cleared");
  } catch (err) {
    console.error("[schedule] Clear failed:", err.message);
    setScheduleStatus("Failed to clear schedule: " + err.message, "error");
  } finally {
    clearScheduleBtn.disabled = false;
  }
});
