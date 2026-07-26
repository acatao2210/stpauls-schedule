import { db } from "./firebase-config.js";
import { liturgicalColor, parseIsoDate } from "./liturgical.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-lite.js";

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

// Privacy: the public page shows "Jane D" rather than the full "Jane Doe"
// stored in Firestore. Only the first and last tokens of the name matter —
// a middle name, if any, is dropped rather than initialed separately. Names
// that are just one word (nicknames, roster typos) are shown as-is.
function toDisplayName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return fullName;
  const first = parts[0];
  const lastInitial = parts[parts.length - 1][0];
  return `${first} ${lastInitial}`;
}

// Builds the "who's serving" line for one role on one date. Only names that
// are actually filled in are shown — an unfilled slot is just left out
// rather than calling attention to the gap on the public page. Used for
// every role except Lector, where slot order matters (see lectorSlots).
function peopleForRole(scheduleForDate, role) {
  const slots = scheduleForDate?.[role];
  if (!Array.isArray(slots)) return [];
  return slots.filter(Boolean).map(toDisplayName);
}

// Lector has a fixed first-reader/second-reader order (unlike Extraordinary
// Minister and Collector, which are interchangeable), so it's numbered
// rather than just listed — and unlike the other roles, an empty slot still
// needs to show as "1." or "2." so the numbering itself stays meaningful.
// Defaults to 2 slots if nothing's been assigned yet at all.
function lectorSlots(scheduleForDate) {
  const raw = scheduleForDate?.["Lector"];
  return Array.isArray(raw) && raw.length ? raw : [null, null];
}

// Builds one row: the date/title in the first (accented) cell, then one
// cell per role in ROLE_LIST — roles run as columns across the table
// rather than stacked underneath each date, so a whole month reads as one
// scannable grid.
function buildWeekRow(week, scheduleForDate) {
  const tr = document.createElement("tr");

  const dateTd = document.createElement("td");
  // Computed from the date itself, same as the title, rather than parsed
  // out of the title text — this way it's correct even for a custom day
  // (Christmas Eve, an Easter Vigil) whose title is free text with no fixed
  // wording to key off of. See liturgical.js for the season logic.
  const color = liturgicalColor(parseIsoDate(week.date));
  dateTd.className = `schedule-date-cell liturgical-${color}`;

  const dateSpan = document.createElement("span");
  dateSpan.className = "schedule-week-date";
  dateSpan.textContent = week.label || week.date;
  dateTd.appendChild(dateSpan);

  if (week.title) {
    const titleSpan = document.createElement("span");
    titleSpan.className = "schedule-week-title";
    titleSpan.textContent = week.title;
    dateTd.appendChild(titleSpan);
  }
  tr.appendChild(dateTd);

  for (const role of ROLE_LIST) {
    const td = document.createElement("td");

    if (role === "Lector") {
      // Numbered — first reader, second reader — since the order is fixed,
      // unlike Extraordinary Minister and Collector below.
      lectorSlots(scheduleForDate).forEach((slot, i) => {
        const nameSpan = document.createElement("span");
        nameSpan.className = "schedule-role-name";
        if (slot) {
          nameSpan.textContent = `${i + 1}. ${toDisplayName(slot)}`;
        } else {
          nameSpan.textContent = `${i + 1}. TBD`;
          nameSpan.classList.add("is-tbd");
        }
        td.appendChild(nameSpan);
      });
    } else {
      const people = peopleForRole(scheduleForDate, role);
      if (people.length) {
        // One name per line, rather than a comma-separated run — reads
        // more like a roster than a sentence, especially with 2 slots.
        // Unlike Lector, these roles are interchangeable, so no numbering.
        for (const name of people) {
          const nameSpan = document.createElement("span");
          nameSpan.className = "schedule-role-name";
          nameSpan.textContent = name;
          td.appendChild(nameSpan);
        }
      } else {
        td.textContent = "TBD";
        td.classList.add("is-tbd");
      }
    }

    tr.appendChild(td);
  }

  return tr;
}

function buildMonthGroup(month, weeks, scheduleDoc) {
  const group = document.createElement("div");
  group.className = "month-group";
  group.id = `month-${month}`; // scroll target for the side nav

  const divider = document.createElement("h2");
  divider.className = "month-divider";
  divider.textContent = monthLabel(month);
  group.appendChild(divider);

  const scroll = document.createElement("div");
  scroll.className = "table-scroll";

  const table = document.createElement("table");
  table.className = "schedule-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const dateTh = document.createElement("th");
  dateTh.textContent = "Date";
  headRow.appendChild(dateTh);
  for (const role of ROLE_LIST) {
    const th = document.createElement("th");
    th.className = "schedule-role-col";
    // Multi-word role names (e.g. "Extraordinary Minister") wrap onto their
    // own line per word rather than however the browser happens to break
    // them, so a narrow column still reads cleanly.
    for (const word of role.split(" ")) {
      const wordSpan = document.createElement("span");
      wordSpan.className = "schedule-role-col-word";
      wordSpan.textContent = word;
      th.appendChild(wordSpan);
    }
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const week of weeks) {
    const scheduleForDate = scheduleDoc?.[week.date] || {};
    tbody.appendChild(buildWeekRow(week, scheduleForDate));
  }
  table.appendChild(tbody);

  scroll.appendChild(table);
  group.appendChild(scroll);
  return group;
}

async function loadPublishedSchedule() {
  console.log("[schedule] Loading published weeks across all months");

  const monthsSnap = await withTimeout(
    getDocs(collection(db, "months")),
    10000,
    "Months lookup"
  );

  // Only months with at least one week marked `published`. Months run
  // newest-first (so the current month is at the top and scrolling down
  // goes further back), but the weeks *within* each month stay in normal
  // first-to-last order — doc ID is "YYYY-MM", so a plain string sort works
  // for both, just reversed at the month level.
  const publishedByMonth = [];
  monthsSnap.forEach((snap) => {
    const weeks = Array.isArray(snap.data().weeks) ? snap.data().weeks : [];
    const published = weeks
      .filter((w) => w.published)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (published.length) publishedByMonth.push({ month: snap.id, weeks: published });
  });
  publishedByMonth.sort((a, b) => b.month.localeCompare(a.month));

  console.log(
    `[schedule] Found ${publishedByMonth.length} month(s) with published weeks`
  );

  if (!publishedByMonth.length) {
    showEmpty();
    return;
  }

  // Fetch every month's assignments in parallel rather than one at a time —
  // with several published months this was previously a chain of sequential
  // round-trips (each waiting on the last), now they all fire at once.
  const scheduleDocs = await Promise.all(
    publishedByMonth.map(async ({ month }) => {
      try {
        const snap = await withTimeout(
          getDoc(doc(db, "schedules", month)),
          10000,
          `Schedule lookup for ${month}`
        );
        return snap.exists() ? snap.data() : null;
      } catch (err) {
        console.warn(`[schedule] Couldn't load assignments for ${month}:`, err.message);
        return null;
      }
    })
  );

  publishedByMonth.forEach(({ month, weeks }, i) => {
    scheduleContent.appendChild(buildMonthGroup(month, weeks, scheduleDocs[i]));
  });

  buildMonthNav(publishedByMonth.map((m) => m.month));

  hideLoading();
}

// Month jump-nav pinned to the right edge. Hidden entirely on narrow
// screens (see the media query in style.css) — it's a hover affordance,
// which doesn't translate to touch, and there's no room for it there
// anyway. Only built when there's more than one month to jump between.
function buildMonthNav(months) {
  if (months.length < 2) return;

  const nav = document.createElement("nav");
  nav.className = "month-nav";
  nav.setAttribute("aria-label", "Jump to month");

  for (const month of months) {
    const link = document.createElement("a");
    link.className = "month-nav-item";
    link.href = `#month-${month}`;
    // Full label ("August 2026") for screen readers and the expanded
    // hover state; the collapsed state shows just the abbreviated form.
    const [y, m] = month.split("-").map(Number);
    const short = new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short" });
    const shortSpan = document.createElement("span");
    shortSpan.className = "month-nav-short";
    shortSpan.textContent = short;
    shortSpan.setAttribute("aria-hidden", "true");
    const fullSpan = document.createElement("span");
    fullSpan.className = "month-nav-full";
    fullSpan.textContent = monthLabel(month);
    link.appendChild(shortSpan);
    link.appendChild(fullSpan);
    nav.appendChild(link);
  }

  document.body.appendChild(nav);
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
