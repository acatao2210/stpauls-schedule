import { app, db } from "./firebase-config.js";
import { buildDisplayNames, displayName } from "./names.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-lite.js";

// ---------------------------------------------------------------------------
// Weekly ministry email generator — admin only.
//
// This was originally a standalone HTML file with every Sunday's date,
// liturgical title, and assigned people hardcoded in a SCHEDULE object, which
// meant hand-editing the file each quarter and re-typing names that the admin
// page already knew. It now reads both from Firestore:
//
//   months/{YYYY-MM}.weeks   -> the date list and each Sunday's title
//   schedules/{YYYY-MM}      -> who's assigned to each role that day
//
// The fields the schedule has no idea about — intro message, gospel, the two
// reading citations, and the reflection link — are typed here and saved back
// onto that week's own entry in months/{month}.weeks under an `email` key, so
// a half-finished draft survives a refresh or a different computer.
//
// Role mapping: Lector slot 1 -> firstReader, slot 2 -> secondReader (the
// schedule keeps lectors in reading order); Collector -> ushers;
// Extraordinary Minister -> ems. Names are joined with " & " to match how
// this email has always read.
// ---------------------------------------------------------------------------
const auth = getAuth(app);

// Same allowlist as admin.js and firestore.rules — keep all three in sync.
// This copy is UX only; Firestore itself is what actually refuses writes
// from an account that isn't on the list.
const ALLOWED_ADMIN_EMAILS = ["acatao2210@gmail.com"];

const loginWrap = document.getElementById("loginWrap");
const loginCard = document.getElementById("loginCard");
const loginForm = document.getElementById("loginForm");
const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");
const loginBtn = document.getElementById("loginBtn");
const loginError = document.getElementById("loginError");
const googleSignInBtn = document.getElementById("googleSignInBtn");
const generator = document.getElementById("generator");

const monthSelect = document.getElementById("monthSelect");
const dateSelect = document.getElementById("dateSelect");
const loadStatus = document.getElementById("loadStatus");
const saveStatus = document.getElementById("saveStatus");
const copyBtn = document.getElementById("copyBtn");
const preview = document.getElementById("preview");
const importSeedBtn = document.getElementById("importSeedBtn");
const importStatus = document.getElementById("importStatus");
const usccbLink = document.getElementById("usccbLink");

// Fields typed by hand and saved back to Firestore per week.
const SAVED_FIELDS = [
  "sundayName",
  "gospel",
  "introMessage",
  "reflectionText",
  "reflectionLink",
  "firstReading",
  "secondReading",
];

// Fields filled in from the published schedule. Still editable — the email
// sometimes needs a name the schedule doesn't carry — but they're refilled
// from the schedule whenever you switch dates, so they aren't persisted.
const ROLE_FIELDS = ["firstReader", "secondReader", "ushers", "ems"];

const ALL_FIELDS = [...SAVED_FIELDS, ...ROLE_FIELDS];

// The published schedule the email points people at. Absolute, not relative
// — this HTML gets pasted into a mail client, where "schedule.html" would
// resolve against nothing. Update this if the site ever moves.
const SCHEDULE_URL = "https://acatao2210.github.io/stpauls-schedule/schedule.html";

// ---------------------------------------------------------------------------
// Auth (mirrors admin.js)
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

let booted = false;

onAuthStateChanged(auth, async (user) => {
  if (user) {
    if (!ALLOWED_ADMIN_EMAILS.includes(user.email)) {
      console.warn("[auth] Signed-in account is not on the admin allowlist; signing out");
      loginError.textContent = "This Google account isn't authorized for admin access.";
      loginError.hidden = false;
      signOut(auth);
      return;
    }
    console.log("[auth] Auth state: signed in, loading generator");
    loginWrap.hidden = true;
    generator.hidden = false;
    if (!booted) {
      booted = true;
      loadMonths().catch((err) => {
        console.error("[email] Couldn't load months:", err.message);
        setLoadStatus("Couldn't load the schedule: " + err.message, "error");
      });
    }
  } else {
    console.log("[auth] Auth state: signed out");
    loginWrap.hidden = false;
    generator.hidden = true;
  }
});

// ---------------------------------------------------------------------------
// Loading the date list and assignments
// ---------------------------------------------------------------------------
let monthsData = {};        // { [month]: [week, ...] }
let currentMonth = null;
let currentSchedule = null; // schedules/{month} doc data for currentMonth
let rosterNames = [];       // every name on the roster, for the display-name map
let displayNames = new Map(); // full name -> what the email should call them

function setLoadStatus(message, kind) {
  if (!loadStatus) return;
  if (!message) {
    loadStatus.hidden = true;
    return;
  }
  loadStatus.hidden = false;
  loadStatus.textContent = message;
  loadStatus.classList.toggle("is-error", kind === "error");
}

function setSaveStatus(message, kind) {
  if (!saveStatus) return;
  saveStatus.textContent = message;
  saveStatus.classList.toggle("is-visible", Boolean(message));
  saveStatus.classList.toggle("is-error", kind === "error");
}

// USCCB's daily-readings URLs are keyed by MMDDYY. Derived from the ISO date
// rather than stored, so it can't drift out of step with the date itself.
function usccbCodeFor(iso) {
  const [y, m, d] = iso.split("-");
  return `${m}${d}${y.slice(2)}`;
}

function monthLabel(yearMonth) {
  const [y, m] = yearMonth.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// Rebuilt whenever the known set of names changes (roster load, month
// switch), since a name present only in one month's schedule still has to
// be considered when deciding what's ambiguous.
function refreshDisplayNames() {
  const scheduled = [];
  for (const day of Object.values(currentSchedule || {})) {
    for (const slots of Object.values(day || {})) {
      if (Array.isArray(slots)) scheduled.push(...slots.filter(Boolean));
    }
  }
  displayNames = buildDisplayNames([...rosterNames, ...scheduled]);
}

async function loadRosterNames() {
  try {
    const snap = await getDocs(collection(db, "roster"));
    rosterNames = snap.docs.map((d) => d.id);
    console.log(`[email] Loaded ${rosterNames.length} roster names for disambiguation`);
  } catch (err) {
    // Non-fatal: without the roster we just judge ambiguity from the
    // schedule alone, which is a slightly smaller pool but still correct
    // for anyone actually named in the email.
    console.warn("[email] Couldn't load the roster:", err.message);
    rosterNames = [];
  }
}

async function loadMonths() {
  setLoadStatus("Loading…");
  await loadRosterNames();
  const snap = await getDocs(collection(db, "months"));

  monthsData = {};
  snap.forEach((docSnap) => {
    const weeks = Array.isArray(docSnap.data().weeks) ? docSnap.data().weeks : [];
    if (weeks.length) {
      monthsData[docSnap.id] = weeks.slice().sort((a, b) => a.date.localeCompare(b.date));
    }
  });

  // Newest month first, matching the public schedule page — the email
  // you're writing is almost always for an upcoming Sunday.
  const months = Object.keys(monthsData).sort((a, b) => b.localeCompare(a));
  if (!months.length) {
    setLoadStatus("No months are set up yet. Create one on the admin page first.", "error");
    return;
  }

  monthSelect.innerHTML = "";
  for (const month of months) {
    const opt = document.createElement("option");
    opt.value = month;
    opt.textContent = monthLabel(month);
    monthSelect.appendChild(opt);
  }

  // Default to whichever month contains the next upcoming Sunday, falling
  // back to the newest month if every date is in the past.
  const todayIso = new Date().toISOString().slice(0, 10);
  const upcoming = months
    .slice()
    .reverse()
    .find((m) => monthsData[m].some((w) => w.date >= todayIso));
  monthSelect.value = upcoming || months[0];

  await selectMonth(monthSelect.value);
  setLoadStatus("");
}

async function selectMonth(month) {
  currentMonth = month;

  // Assignments live in a separate doc per month. A month with no schedule
  // yet isn't an error — the role fields just come up blank.
  try {
    const snap = await getDoc(doc(db, "schedules", month));
    currentSchedule = snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn(`[email] Couldn't load assignments for ${month}:`, err.message);
    currentSchedule = null;
  }
  refreshDisplayNames();

  dateSelect.innerHTML = "";
  for (const week of monthsData[month]) {
    const opt = document.createElement("option");
    opt.value = week.date;
    opt.textContent = week.label || week.date;
    dateSelect.appendChild(opt);
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const nextUp = monthsData[month].find((w) => w.date >= todayIso);
  dateSelect.value = nextUp ? nextUp.date : monthsData[month][0].date;

  populate(dateSelect.value);
  refreshPreview();
}

function currentWeek() {
  return monthsData[currentMonth]?.find((w) => w.date === dateSelect.value) || null;
}

// Pulls the assigned names for one date out of the schedule doc, shortened
// to how the email should address people (see buildDisplayNames).
function rolesFor(date) {
  const day = currentSchedule?.[date] || {};
  const filled = (role) =>
    (Array.isArray(day[role]) ? day[role].filter(Boolean) : []).map((n) => displayName(displayNames, n));
  const lectors = filled("Lector");
  return {
    firstReader: lectors[0] || "",
    secondReader: lectors[1] || "",
    ushers: filled("Collector").join(" & "),
    ems: filled("Extraordinary Minister").join(" & "),
  };
}

function populate(date) {
  const week = currentWeek();
  if (!week) return;

  // Point the "Check readings" link at the selected Sunday, so verifying a
  // citation is one click rather than hand-assembling a MMDDYY URL.
  if (usccbLink) {
    usccbLink.href = `https://bible.usccb.org/bible/readings/${usccbCodeFor(date)}.cfm`;
  }

  const saved = week.email || {};
  const roles = rolesFor(date);

  // Sunday name defaults to the liturgical title the admin page already
  // computed, unless a draft has overridden it.
  document.getElementById("sundayName").value = saved.sundayName || week.title || "";
  for (const f of SAVED_FIELDS) {
    if (f === "sundayName") continue;
    document.getElementById(f).value = saved[f] || "";
  }
  for (const f of ROLE_FIELDS) {
    document.getElementById(f).value = roles[f] || "";
  }

  const anyRole = Object.values(roles).some(Boolean);
  setLoadStatus(
    anyRole ? "" : "No one is assigned to this date yet — role fields are blank.",
  );
}

function getFormValues() {
  const v = {};
  for (const f of ALL_FIELDS) v[f] = document.getElementById(f).value;
  const week = currentWeek();
  const iso = dateSelect.value;
  v.usccbCode = usccbCodeFor(iso);
  // "Sunday, August 2" -> "August 2"; the email wants the date without the
  // weekday, and the month name on its own for the footer.
  const [y, m, d] = iso.split("-").map(Number);
  const dateObj = new Date(y, m - 1, d);
  v.date = dateObj.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  v.month = dateObj.toLocaleDateString("en-US", { month: "long" });
  v.label = week?.label || iso;
  return v;
}

// ---------------------------------------------------------------------------
// Saving the typed fields back to months/{month}.weeks[].email
//
// Debounced so a sentence being typed is one write, not one per keystroke.
// Writes the whole weeks array back (Firestore can't update one element of
// an array in place), which is the same thing the admin page's title and
// Pre-Cana editors already do.
// ---------------------------------------------------------------------------
let saveTimer = null;

function queueSave() {
  clearTimeout(saveTimer);
  setSaveStatus("Saving…");
  saveTimer = setTimeout(() => {
    saveDraft().catch((err) => {
      console.error("[email] Save failed:", err.message);
      setSaveStatus("Couldn't save", "error");
    });
  }, 900);
}

async function saveDraft() {
  const month = currentMonth;
  const date = dateSelect.value;
  if (!month || !date) return;

  const draft = {};
  for (const f of SAVED_FIELDS) draft[f] = document.getElementById(f).value;

  const weeks = monthsData[month].map((w) =>
    w.date === date ? { ...w, email: draft } : w
  );

  await setDoc(
    doc(db, "months", month),
    { month, weeks, updatedAt: serverTimestamp() },
    { merge: true }
  );
  monthsData[month] = weeks;
  console.log(`[email] Saved draft for ${date}`);
  setSaveStatus("Saved");
  setTimeout(() => setSaveStatus(""), 1800);
}

function refreshPreview() {
  preview.srcdoc = generateHTML(getFormValues());
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
monthSelect.addEventListener("change", async () => {
  clearTimeout(saveTimer); // don't let a pending save land on the old month
  setSaveStatus("");
  await selectMonth(monthSelect.value);
});

dateSelect.addEventListener("change", () => {
  clearTimeout(saveTimer);
  setSaveStatus("");
  populate(dateSelect.value);
  refreshPreview();
});

for (const f of SAVED_FIELDS) {
  document.getElementById(f).addEventListener("input", () => {
    refreshPreview();
    queueSave();
  });
}

// Role fields still redraw the preview, but aren't persisted — they're
// refilled from the schedule on the next date switch.
for (const f of ROLE_FIELDS) {
  document.getElementById(f).addEventListener("input", refreshPreview);
}

// ---------------------------------------------------------------------------
// One-time import of the written drafts that used to live hardcoded in the
// original standalone generator. Deliberately additive: a week that already
// has an `email` object is left alone, so running this twice — or running it
// after writing something new — can't destroy work.
// ---------------------------------------------------------------------------
// Not optional-chained on purpose. `importSeedBtn?.addEventListener(...)`
// silently does nothing when the element is missing, which is
// indistinguishable from a dead button — say so instead.
if (!importSeedBtn) {
  console.error(
    "[email] #importSeedBtn not found. If the button is visible on the page, " +
      "this file is a stale cached copy — hard-reload (Cmd/Ctrl+Shift+R)."
  );
}

importSeedBtn.addEventListener("click", async () => {
  importSeedBtn.disabled = true;
  const original = importSeedBtn.textContent;
  importSeedBtn.textContent = "Importing…";
  const setStatus = (msg, kind) => {
    importStatus.hidden = false;
    importStatus.textContent = msg;
    importStatus.classList.toggle("is-error", kind === "error");
  };

  try {
    const res = await fetch("email-seed.json");
    if (!res.ok) throw new Error(`couldn't read email-seed.json (${res.status})`);
    const { drafts } = await res.json();

    let imported = 0;
    let skipped = 0;
    const touchedMonths = new Set();
    const missingMonths = new Set();
    const missingDates = [];

    for (const [date, draft] of Object.entries(drafts)) {
      const month = date.slice(0, 7);
      const weeks = monthsData[month];
      if (!weeks) {
        // That month has no doc in Firestore at all.
        missingMonths.add(month);
        continue;
      }

      const week = weeks.find((w) => w.date === date);
      if (!week) {
        // Month exists but this Sunday isn't in its weeks list.
        missingDates.push(date);
        continue;
      }

      // Anything already written wins — this only fills genuine gaps.
      const existing = week.email;
      const hasContent = existing && Object.values(existing).some((v) => v && v.trim());
      if (hasContent) {
        skipped++;
        continue;
      }

      monthsData[month] = weeks.map((w) => (w.date === date ? { ...w, email: draft } : w));
      touchedMonths.add(month);
      imported++;
    }

    for (const month of touchedMonths) {
      await setDoc(
        doc(db, "months", month),
        { month, weeks: monthsData[month], updatedAt: serverTimestamp() },
        { merge: true }
      );
    }

    console.log(
      `[email] Import: ${imported} written, ${skipped} already had content, ` +
        `months not in Firestore: [${[...missingMonths].join(", ") || "none"}], ` +
        `dates missing from their month: [${missingDates.join(", ") || "none"}]`
    );

    // Report every reason a week didn't import, so a partial result is
    // explainable rather than looking like a silent failure.
    const notes = [];
    if (imported) notes.push(`Imported ${imported} draft${imported === 1 ? "" : "s"}.`);
    if (skipped) {
      notes.push(`Left ${skipped} week${skipped === 1 ? "" : "s"} alone (already written).`);
    }
    if (missingMonths.size) {
      notes.push(
        `No Firestore entry for ${[...missingMonths].sort().join(", ")} — ` +
          `create ${missingMonths.size === 1 ? "it" : "them"} in Availability month on the admin page, then run this again.`
      );
    }
    if (missingDates.length) {
      notes.push(
        `These dates aren't in their month's week list: ${missingDates.join(", ")}. ` +
          `Click "Reset schedule" for that month on the admin page to generate its Sundays.`
      );
    }

    setStatus(notes.join(" "), imported ? null : "error");

    if (imported) {
      // Reload the current week so the restored text shows immediately.
      populate(dateSelect.value);
      refreshPreview();
    }
  } catch (err) {
    console.error("[email] Import failed:", err.message);
    setStatus("Import failed: " + err.message, "error");
  } finally {
    importSeedBtn.disabled = false;
    importSeedBtn.textContent = original;
  }
});

copyBtn.addEventListener("click", () => {
  const html = generateHTML(getFormValues());
  navigator.clipboard.writeText(html).then(
    () => {
      copyBtn.classList.add("copied");
      copyBtn.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.classList.remove("copied");
        copyBtn.textContent = "Copy HTML";
      }, 2200);
    },
    (err) => {
      console.error("[email] Clipboard write failed:", err.message);
      copyBtn.textContent = "Copy failed";
      setTimeout(() => { copyBtn.textContent = "Copy HTML"; }, 2200);
    }
  );
});

// ---------------------------------------------------------------------------
// Email template — copied verbatim from the original standalone
// liturgical_email_generator.html so the produced markup is byte-identical.
// It's table-based with inline styles and a prefers-color-scheme block on
// purpose: that's what survives Outlook/Gmail, so resist tidying it into
// modern CSS.
// ---------------------------------------------------------------------------
function citationHTML(text) {
  if (!text || !text.trim()) return '';
  return `<div class="em-cite" style="font-family:Georgia,serif;font-size:11px;color:#A8833A;font-style:italic;margin-top:3px;line-height:1.4;">${text.trim()}</div>`;
}

function generateHTML(f) {
  const usccbLink  = "https://bible.usccb.org/bible/readings/" + f.usccbCode + ".cfm";
  const reflLink   = f.reflectionLink || "#";
  const reflSection = f.reflectionText
    ? ` We encourage you to watch this short reflection: <a href="${reflLink}" style="color:#1A3B28;font-weight:bold;">${f.reflectionText}</a>.`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Liturgical Roles \u2014 ${f.date}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .em-bg    { background-color:#111111 !important; }
    .em-card  { background-color:#182217 !important; }
    .em-header { background-color:#0c1a0f !important; }
    .em-sunday { border-bottom-color:#C9A84C !important; }
    .em-sunday-name { color:#6a8070 !important; }
    .em-gospel { color:#bccfbc !important; }
    .em-content { background-color:#182217 !important; }
    .em-text  { color:#b8ccb8 !important; }
    .em-row   { border-bottom-color:#243020 !important; }
    .em-label { color:#6a7e6a !important; }
    .em-name  { color:#6dbf85 !important; }
    .em-cite  { color:#C9A84C !important; }
    .em-sec-row { border-bottom-color:#2a4835 !important; }
    .em-sec   { color:#6dbf85 !important; }
    .em-link  { color:#6dbf85 !important; }
    .em-footer { background-color:#0e1610 !important; border-top-color:#1e2e1e !important; }
    .em-footer-text { color:#4a5a4a !important; }
    .em-sig   { color:#6dbf85 !important; }
  }
  [data-ogsc] .em-bg    { background-color:#111111 !important; }
  [data-ogsc] .em-card  { background-color:#182217 !important; }
  [data-ogsc] .em-header { background-color:#0c1a0f !important; }
  [data-ogsc] .em-content { background-color:#182217 !important; }
  [data-ogsc] .em-text  { color:#b8ccb8 !important; }
  [data-ogsc] .em-label { color:#6a7e6a !important; }
  [data-ogsc] .em-name  { color:#6dbf85 !important; }
  [data-ogsc] .em-cite  { color:#C9A84C !important; }
  [data-ogsc] .em-sec   { color:#6dbf85 !important; }
  [data-ogsc] .em-link  { color:#6dbf85 !important; }
  [data-ogsc] .em-footer { background-color:#0e1610 !important; }
  [data-ogsc] .em-footer-text { color:#4a5a4a !important; }
  [data-ogsc] .em-sig   { color:#6dbf85 !important; }
</style>
</head>
<body class="em-bg" style="margin:0;padding:0;background-color:#f5f5f5;font-family:Arial,sans-serif;">
<table class="em-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f5f5;">
<tr><td align="center" style="padding:32px 16px;">
<table class="em-card" width="560" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;max-width:560px;width:100%;">

<!-- Header bar -->
<tr><td class="em-header" style="background-color:#1A3B28;padding:7px 0;text-align:center;">
<span style="font-family:Arial,sans-serif;font-size:10px;letter-spacing:2.5px;text-transform:uppercase;color:#C9A84C;">St. Paul\u2019s Inside the Walls</span>
</td></tr>

<!-- Sunday / Gospel -->
<tr><td class="em-sunday em-content" style="padding:30px 40px 22px;border-bottom:2px solid #C9A84C;text-align:center;">
<p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#595959;" class="em-sunday-name">${f.sundayName}</p>
<p style="margin:0;font-family:Georgia,serif;font-size:15px;color:#3d3d3d;font-style:italic;" class="em-gospel">${f.gospel}</p>
</td></tr>

<!-- Body -->
<tr><td class="em-content" style="padding:30px 40px;">
<p style="margin:0 0 18px;font-family:Arial,sans-serif;font-size:15px;color:#1C1C1C;line-height:1.6;" class="em-text">Good morning, everyone!</p>
<p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:14px;color:#4A4A4A;line-height:1.75;" class="em-text">${f.introMessage}${reflSection}</p>
<p style="margin:0 0 30px;font-family:Arial,sans-serif;font-size:14px;color:#4A4A4A;line-height:1.75;" class="em-text">Have a beautiful and blessed Sunday! &#x1F64F;</p>

<!-- Roles header -->
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
<tr><td style="padding-bottom:10px;border-bottom:1.5px solid #1A3B28;" class="em-sec-row">
<span style="font-family:Arial,sans-serif;font-size:10px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#1A3B28;" class="em-sec">Liturgical Roles &nbsp;&middot;&nbsp; Sunday, ${f.date}</span>
</td></tr></table>

<!-- Roles table -->
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:30px;">

<tr>
<td width="65%" class="em-row" valign="top" style="padding:11px 0;border-bottom:1px solid #F0EBE3;vertical-align:top;">
  <div class="em-label" style="font-family:Arial,sans-serif;font-size:12px;color:#595959;text-transform:uppercase;letter-spacing:0.5px;">1st Reading &amp; Intercessions</div>
  ${citationHTML(f.firstReading)}
</td>
<td width="35%" class="em-row" align="right" valign="top" style="padding:11px 0 11px 12px;border-bottom:1px solid #F0EBE3;text-align:right;vertical-align:top;white-space:nowrap;">
  <span class="em-name" style="font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#1A3B28;">${f.firstReader}</span>
</td>
</tr>

<tr>
<td width="65%" class="em-row" valign="top" style="padding:11px 0;border-bottom:1px solid #F0EBE3;vertical-align:top;">
  <div class="em-label" style="font-family:Arial,sans-serif;font-size:12px;color:#595959;text-transform:uppercase;letter-spacing:0.5px;">2nd Reading</div>
  ${citationHTML(f.secondReading)}
</td>
<td width="35%" class="em-row" align="right" valign="top" style="padding:11px 0 11px 12px;border-bottom:1px solid #F0EBE3;text-align:right;vertical-align:top;white-space:nowrap;">
  <span class="em-name" style="font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#1A3B28;">${f.secondReader}</span>
</td>
</tr>

<tr>
<td width="65%" class="em-label em-row" style="padding:11px 0;border-bottom:1px solid #F0EBE3;font-family:Arial,sans-serif;font-size:12px;color:#595959;text-transform:uppercase;letter-spacing:0.5px;vertical-align:middle;">Collection / Greeting Usher</td>
<td width="35%" class="em-name em-row" align="right" style="padding:11px 0 11px 12px;border-bottom:1px solid #F0EBE3;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#1A3B28;text-align:right;vertical-align:middle;white-space:nowrap;">${f.ushers}</td>
</tr>

<tr>
<td width="65%" class="em-label" style="padding:11px 0;font-family:Arial,sans-serif;font-size:12px;color:#595959;text-transform:uppercase;letter-spacing:0.5px;vertical-align:middle;">Extraordinary Ministers</td>
<td width="35%" class="em-name" align="right" style="padding:11px 0 11px 12px;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#1A3B28;text-align:right;vertical-align:middle;white-space:nowrap;">${f.ems}</td>
</tr>

</table>

<!-- Reminders header -->
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
<tr><td style="padding-bottom:10px;border-bottom:1.5px solid #1A3B28;" class="em-sec-row">
<span style="font-family:Arial,sans-serif;font-size:10px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#1A3B28;" class="em-sec">A Few Reminders</span>
</td></tr></table>

<p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:14px;color:#4A4A4A;line-height:1.75;" class="em-text">&#x1F4D6;&nbsp; This Sunday\u2019s <a href="${usccbLink}" style="color:#1A3B28;font-weight:bold;" class="em-link">readings</a> are available on the USCCB website.</p>
<p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:14px;color:#4A4A4A;line-height:1.75;" class="em-text">&#x1F4C5;&nbsp; The <a href="${SCHEDULE_URL}" style="color:#1A3B28;font-weight:bold;" class="em-link">Ministry Schedule</a> is posted for <strong>${f.month}</strong>. Please check your dates and confirm your availability.</p>
<p style="margin:0 0 30px;font-family:Arial,sans-serif;font-size:14px;color:#4A4A4A;line-height:1.75;" class="em-text">&#x1F504;&nbsp; If you have a conflict, please find a teammate to swap with and let us know so we can update the schedule.</p>

<p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:14px;color:#4A4A4A;line-height:1.75;" class="em-text">Thank you so much for your commitment to serving the Lord each week!</p>
<p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:14px;color:#4A4A4A;" class="em-text">Blessings,</p>
<p style="margin:0;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#1A3B28;" class="em-sig">Amy &amp; Andre</p>

</td></tr>

<!-- Footer -->
<tr><td class="em-footer" style="background-color:#F5F2EC;padding:14px 40px;text-align:center;border-top:1px solid #E8E0D4;">
<p style="margin:0;font-family:Arial,sans-serif;font-size:10px;color:#5e5e5e;letter-spacing:0.8px;text-transform:uppercase;" class="em-footer-text">Liturgical Ministry Team &nbsp;&middot;&nbsp; St. Paul\u2019s Inside the Walls &nbsp;&middot;&nbsp; Madison, NJ</p>
</td></tr>

</table>
</td></tr></table>
</body></html>`;
}
