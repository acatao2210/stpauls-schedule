import { db } from "./firebase-config.js";
import { buildDisplayNames, displayName } from "./names.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-lite.js";

// ---------------------------------------------------------------------------
// Sunday checklist — a pre-Mass run-through, meant to be opened on a phone in
// the sacristy and ticked off.
//
// Two kinds of item:
//   * Who's here — built from that Sunday's actual assignments in
//     schedules/{month}, so it names real people rather than asking a vague
//     "is everyone here?". Lectors keep their reading order (1st/2nd), since
//     that's the one role where the order matters.
//   * Everything else — a fixed list of sacristy items, same every week.
//
// Ticks live in localStorage keyed by date, so a refresh mid-morning doesn't
// lose them and next Sunday starts clean. Nothing is written to Firestore:
// this is a personal working list, not a record anyone else needs to see.
// ---------------------------------------------------------------------------
const ROLE_LIST = ["Lector", "Extraordinary Minister", "Collector"];

// Grouped so the list reads in roughly the order you'd walk through it.
const FIXED_SECTIONS = [
  {
    title: "Liturgy",
    items: [
      { id: "readings", label: "Readings checked", hint: "Right Sunday, lectionary open and marked" },
      { id: "intentions", label: "Mass intentions confirmed" },
      { id: "petitions", label: "Intercessions ready", hint: "Printed and handed to the first reader" },
    ],
  },
  {
    title: "Sound",
    items: [
      { id: "micBatteries", label: "Lector mic batteries", hint: "Check level, swap if in doubt — spares in the sacristy" },
      { id: "micTest", label: "Mic tested at the ambo" },
    ],
  },
  {
    title: "Altar",
    items: [
      { id: "hostsWine", label: "Hosts and wine out" },
      { id: "ciborium", label: "Ciborium count for expected attendance" },
      { id: "chalice", label: "Chalice set" },
      { id: "cruets", label: "Cruets filled", hint: "Water and wine" },
      { id: "linens", label: "Altar linens and corporal set" },
      { id: "candles", label: "Candles lit" },
    ],
  },
  {
    title: "Before the procession",
    items: [
      { id: "baskets", label: "Offertory baskets ready" },
      { id: "giftsFamily", label: "Gift bearers identified" },
    ],
  },
];

const loadingCard = document.getElementById("loadingCard");
const emptyCard = document.getElementById("emptyCard");
const emptyText = document.getElementById("emptyText");
const toolbar = document.getElementById("toolbar");
const dateSelect = document.getElementById("dateSelect");
const resetBtn = document.getElementById("resetBtn");
const content = document.getElementById("checklistContent");
const subtitle = document.getElementById("subtitle");

let weeksByDate = new Map();   // isoDate -> week object (label, title)
let schedulesByMonth = new Map(); // "YYYY-MM" -> schedules doc data
let displayNames = new Map();

function storageKey(date) {
  return `spw_checklist_${date}`;
}

// localStorage can be unavailable (private browsing). The checklist still
// works in that case — ticks just don't survive a refresh.
function loadTicks(date) {
  try {
    return new Set(JSON.parse(localStorage.getItem(storageKey(date)) || "[]"));
  } catch {
    return new Set();
  }
}

function saveTicks(date, ticks) {
  try {
    localStorage.setItem(storageKey(date), JSON.stringify([...ticks]));
  } catch (err) {
    console.warn("[checklist] Couldn't save ticks:", err.message);
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

function showEmpty(message) {
  if (loadingCard) loadingCard.hidden = true;
  if (message && emptyText) emptyText.textContent = message;
  if (emptyCard) emptyCard.hidden = false;
}

// The people assigned that Sunday, as tick-off lines. Lectors stay numbered
// because first/second reader is a real distinction; the other roles are
// interchangeable and just list out.
function peopleItemsFor(date) {
  const month = date.slice(0, 7);
  const day = schedulesByMonth.get(month)?.[date] || {};
  const items = [];

  for (const role of ROLE_LIST) {
    const slots = Array.isArray(day[role]) ? day[role] : [];
    const filled = slots.filter(Boolean);

    if (role === "Lector") {
      slots.forEach((name, i) => {
        if (!name) return;
        items.push({
          id: `person-${role}-${i}`,
          label: displayName(displayNames, name),
          hint: `Lector ${i + 1}`,
        });
      });
      // An unfilled lector slot is worth surfacing — it's a gap someone has
      // to cover before Mass, not just an absence of information.
      slots.forEach((name, i) => {
        if (name) return;
        items.push({
          id: `person-${role}-gap-${i}`,
          label: `Lector ${i + 1} — nobody assigned`,
          hint: "Needs covering",
          isGap: true,
        });
      });
    } else {
      filled.forEach((name, i) => {
        items.push({
          id: `person-${role}-${i}`,
          label: displayName(displayNames, name),
          hint: role,
        });
      });
    }
  }

  return items;
}

function buildSection(title, items, date, ticks) {
  const section = document.createElement("section");
  section.className = "checklist-section";

  const h = document.createElement("h2");
  h.className = "checklist-section-title";
  h.textContent = title;
  section.appendChild(h);

  const list = document.createElement("div");
  list.className = "checklist-items";

  for (const item of items) {
    const label = document.createElement("label");
    label.className = "checklist-item" + (item.isGap ? " is-gap" : "");

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = ticks.has(item.id);
    box.addEventListener("change", () => {
      if (box.checked) ticks.add(item.id);
      else ticks.delete(item.id);
      saveTicks(date, ticks);
      label.classList.toggle("is-done", box.checked);
      updateProgress(date, ticks);
    });

    const text = document.createElement("span");
    text.className = "checklist-text";

    const main = document.createElement("span");
    main.className = "checklist-label";
    main.textContent = item.label;
    text.appendChild(main);

    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "checklist-hint";
      hint.textContent = item.hint;
      text.appendChild(hint);
    }

    if (box.checked) label.classList.add("is-done");
    label.appendChild(box);
    label.appendChild(text);
    list.appendChild(label);
  }

  section.appendChild(list);
  return section;
}

function allItemIds(date) {
  const ids = peopleItemsFor(date).map((i) => i.id);
  for (const s of FIXED_SECTIONS) for (const i of s.items) ids.push(i.id);
  return ids;
}

function updateProgress(date, ticks) {
  const total = allItemIds(date).length;
  const done = allItemIds(date).filter((id) => ticks.has(id)).length;
  const el = document.getElementById("progressLine");
  if (!el) return;
  el.textContent = done === total ? "All set ✓" : `${done} of ${total} done`;
  el.classList.toggle("is-complete", done === total);
}

function render(date) {
  content.innerHTML = "";
  const ticks = loadTicks(date);
  const week = weeksByDate.get(date);

  const heading = document.createElement("div");
  heading.className = "checklist-heading";
  const dateLine = document.createElement("p");
  dateLine.className = "checklist-date";
  dateLine.textContent = week?.label || date;
  heading.appendChild(dateLine);
  if (week?.title) {
    const titleLine = document.createElement("p");
    titleLine.className = "checklist-title";
    titleLine.textContent = week.title;
    heading.appendChild(titleLine);
  }
  const progress = document.createElement("p");
  progress.className = "checklist-progress";
  progress.id = "progressLine";
  heading.appendChild(progress);
  content.appendChild(heading);

  const people = peopleItemsFor(date);
  if (people.length) {
    content.appendChild(buildSection("Who's here", people, date, ticks));
  } else {
    const none = document.createElement("p");
    none.className = "hint checklist-noassign";
    none.textContent = "Nobody is assigned to this date yet.";
    content.appendChild(none);
  }

  for (const s of FIXED_SECTIONS) {
    content.appendChild(buildSection(s.title, s.items, date, ticks));
  }

  updateProgress(date, ticks);
  content.hidden = false;
}

async function load() {
  const monthsSnap = await withTimeout(
    getDocs(collection(db, "months")),
    10000,
    "Months lookup"
  );

  const allWeeks = [];
  monthsSnap.forEach((snap) => {
    const weeks = Array.isArray(snap.data().weeks) ? snap.data().weeks : [];
    for (const w of weeks) {
      weeksByDate.set(w.date, w);
      allWeeks.push(w);
    }
  });

  if (!allWeeks.length) {
    showEmpty("No dates are set up yet.");
    return;
  }

  allWeeks.sort((a, b) => a.date.localeCompare(b.date));

  // Only months that actually have assignments are worth fetching.
  const months = [...new Set(allWeeks.map((w) => w.date.slice(0, 7)))];
  const docs = await Promise.all(
    months.map(async (month) => {
      try {
        const snap = await withTimeout(
          getDoc(doc(db, "schedules", month)),
          10000,
          `Schedule lookup for ${month}`
        );
        return [month, snap.exists() ? snap.data() : null];
      } catch (err) {
        console.warn(`[checklist] Couldn't load ${month}:`, err.message);
        return [month, null];
      }
    })
  );
  schedulesByMonth = new Map(docs);

  // Same shortening rule as the schedule page and the email.
  const everyName = [];
  for (const [, sched] of schedulesByMonth) {
    for (const day of Object.values(sched || {})) {
      for (const slots of Object.values(day || {})) {
        if (Array.isArray(slots)) everyName.push(...slots.filter(Boolean));
      }
    }
  }
  displayNames = buildDisplayNames(everyName);

  dateSelect.innerHTML = "";
  for (const w of allWeeks) {
    const opt = document.createElement("option");
    opt.value = w.date;
    opt.textContent = w.label || w.date;
    dateSelect.appendChild(opt);
  }

  // Default to today if it's a scheduled date, otherwise the next one
  // coming up — so on a Sunday morning it opens on the right day with no
  // interaction at all.
  const todayIso = new Date().toISOString().slice(0, 10);
  const target = allWeeks.find((w) => w.date >= todayIso) || allWeeks[allWeeks.length - 1];
  dateSelect.value = target.date;

  if (subtitle) {
    subtitle.textContent =
      target.date === todayIso ? "Before Mass begins." : "Before Mass begins — showing the next scheduled date.";
  }

  loadingCard.hidden = true;
  toolbar.hidden = false;
  render(dateSelect.value);
}

dateSelect.addEventListener("change", () => render(dateSelect.value));

resetBtn.addEventListener("click", () => {
  const date = dateSelect.value;
  if (!confirm("Clear every tick for this date?")) return;
  saveTicks(date, new Set());
  console.log(`[checklist] Cleared ticks for ${date}`);
  render(date);
});

load().catch((err) => {
  console.error("[checklist] Couldn't load:", err.message);
  showEmpty("We couldn't load the schedule just now. Please refresh, or try again in a few minutes.");
});
