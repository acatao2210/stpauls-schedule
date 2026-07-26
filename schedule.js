import { db } from "./firebase-config.js";
import { liturgicalColor, parseIsoDate } from "./liturgical.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------------------------------------------------------------------
// Public schedule page. Read-only — no sign-in, no form.
//
// A week only shows up here once an admin has explicitly marked it
// "Published" in the Schedule section of the admin page (a `published` flag
// on that week's entry in months/{month}.weeks). Unpublished weeks, and
// months with no published weeks at all, are simply skipped.
//
// Keep ROLE_LIST in sync with admin.js's copy — it controls both what's
// assigned there and what's displayed here.
// ---------------------------------------------------------------------------
const ROLE_LIST = ["Lector", "Extraordinary Minister", "Collector"];

const loadingCard = document.getElementById("loadingCard");
const emptyCard = document.getElementById("emptyCard");
const scheduleContent = document.getElementById("scheduleContent");

function hideLoading() {
  if (loadingCard) loadingCard.hidden = true;
}

function showEmpty() {
  hideLoading();
  if (emptyCard) emptyCard.hidden = false;
}

function monthLabel(yearMonth) {
  const [y, m] = yearMonth.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// Privacy: the public page shows "Jane D." rather than the full "Jane Doe"
// stored in Firestore. Only the first and last tokens of the name matter —
// a middle name, if any, is dropped rather than initialed separately. Names
// that are just one word (nicknames, roster typos) are shown as-is.
function toDisplayName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return fullName;
  const first = parts[0];
  const lastInitial = parts[parts.length - 1][0];
  return `${first} ${lastInitial}.`;
}

// Builds the "who's serving" line for one role on one date. Only names that
// are actually filled in are shown — an unfilled slot is just left out
// rather than calling attention to the gap on the public page.
function peopleForRole(scheduleForDate, role) {
  const slots = scheduleForDate?.[role];
  if (!Array.isArray(slots)) return [];
  return slots.filter(Boolean).map(toDisplayName);
}

function buildWeekCard(week, scheduleForDate) {
  const card = document.createElement("div");
  // Computed from the date itself, same as the title, rather than parsed
  // out of the title text — this way it's correct even for a custom day
  // (Christmas Eve, an Easter Vigil) whose title is free text with no fixed
  // wording to key off of. See liturgical.js for the season logic.
  const color = liturgicalColor(parseIsoDate(week.date));
  card.className = `schedule-week-card liturgical-${color}`;

  const header = document.createElement("div");
  header.className = "schedule-week-header";

  const dateSpan = document.createElement("span");
  dateSpan.className = "schedule-week-date";
  dateSpan.textContent = week.label || week.date;
  header.appendChild(dateSpan);

  if (week.title) {
    const titleSpan = document.createElement("span");
    titleSpan.className = "schedule-week-title";
    titleSpan.textContent = week.title;
    header.appendChild(titleSpan);
  }
  card.appendChild(header);

  const roleList = document.createElement("div");
  roleList.className = "schedule-role-list";

  for (const role of ROLE_LIST) {
    const row = document.createElement("div");
    row.className = "schedule-role-row";

    const nameSpan = document.createElement("span");
    nameSpan.className = "schedule-role-name";
    nameSpan.textContent = role;
    row.appendChild(nameSpan);

    const people = peopleForRole(scheduleForDate, role);
    const peopleSpan = document.createElement("span");
    peopleSpan.className = "schedule-role-people";
    if (people.length) {
      peopleSpan.textContent = people.join(", ");
    } else {
      peopleSpan.textContent = "TBD";
      peopleSpan.classList.add("is-tbd");
    }
    row.appendChild(peopleSpan);

    roleList.appendChild(row);
  }

  card.appendChild(roleList);
  return card;
}

function buildMonthGroup(month, weeks, scheduleDoc) {
  const group = document.createElement("div");
  group.className = "month-group";

  const divider = document.createElement("h2");
  divider.className = "month-divider";
  divider.textContent = monthLabel(month);
  group.appendChild(divider);

  for (const week of weeks) {
    const scheduleForDate = scheduleDoc?.[week.date] || {};
    group.appendChild(buildWeekCard(week, scheduleForDate));
  }

  return group;
}

async function loadPublishedSchedule() {
  console.log("[schedule] Loading published weeks across all months");

  const monthsSnap = await withTimeout(
    getDocs(collection(db, "months")),
    10000,
    "Months lookup"
  );

  // Only months with at least one week marked `published`, sorted
  // chronologically (doc ID is "YYYY-MM", so a plain string sort works).
  const publishedByMonth = [];
  monthsSnap.forEach((snap) => {
    const weeks = Array.isArray(snap.data().weeks) ? snap.data().weeks : [];
    const published = weeks
      .filter((w) => w.published)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (published.length) publishedByMonth.push({ month: snap.id, weeks: published });
  });
  publishedByMonth.sort((a, b) => a.month.localeCompare(b.month));

  console.log(
    `[schedule] Found ${publishedByMonth.length} month(s) with published weeks`
  );

  if (!publishedByMonth.length) {
    showEmpty();
    return;
  }

  for (const { month, weeks } of publishedByMonth) {
    let scheduleDoc = null;
    try {
      const snap = await withTimeout(
        getDoc(doc(db, "schedules", month)),
        10000,
        `Schedule lookup for ${month}`
      );
      scheduleDoc = snap.exists() ? snap.data() : null;
    } catch (err) {
      console.warn(`[schedule] Couldn't load assignments for ${month}:`, err.message);
    }
    scheduleContent.appendChild(buildMonthGroup(month, weeks, scheduleDoc));
  }

  hideLoading();
}

loadPublishedSchedule().catch((err) => {
  console.error("[schedule] Could not load the schedule:", err.message);
  hideLoading();
  if (emptyCard) {
    emptyCard.hidden = false;
    emptyCard.querySelector("p").textContent =
      "We couldn't load the schedule just now. Please refresh, or try again in a few minutes.";
  }
});
