import { db } from "./firebase-config.js";
import { ROSTER } from "./roster.js";
import { matchName } from "./name-match.js";
import {
  collection,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------------------------------------------------------------------
// Config: how many upcoming Sundays to ask about.
// ---------------------------------------------------------------------------
const NUM_SUNDAYS = 6;

function getUpcomingSundays(count) {
  const dates = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  // advance to the next Sunday (if today is Sunday, start with today)
  const dayOfWeek = d.getDay(); // 0 = Sunday
  const daysUntilSunday = (7 - dayOfWeek) % 7;
  d.setDate(d.getDate() + daysUntilSunday);
  for (let i = 0; i < count; i++) {
    dates.push(new Date(d));
    d.setDate(d.getDate() + 7);
  }
  return dates;
}

function formatDate(date) {
  const opts = { weekday: "long", month: "long", day: "numeric" };
  return date.toLocaleDateString("en-US", opts);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

const sundays = getUpcomingSundays(NUM_SUNDAYS);

// ---------------------------------------------------------------------------
// Name field — plain free text, no dropdown, no autocomplete UI.
// Matching against the roster happens silently at submit time.
// ---------------------------------------------------------------------------
const nameInput = document.getElementById("nameInput");

// ---------------------------------------------------------------------------
// Build date rows
// ---------------------------------------------------------------------------
const dateList = document.getElementById("dateList");
const responseState = {}; // isoDate -> "yes" | "no" | "maybe"

for (const sunday of sundays) {
  const key = isoDate(sunday);
  responseState[key] = null;

  const row = document.createElement("div");
  row.className = "date-row";
  row.dataset.date = key;

  const label = document.createElement("div");
  label.className = "date-label";
  label.textContent = formatDate(sunday);

  const toggle = document.createElement("div");
  toggle.className = "status-toggle";

  const options = [
    { status: "yes", text: "Yes" },
    { status: "maybe", text: "Maybe" },
    { status: "no", text: "No" },
  ];

  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "status-btn";
    btn.dataset.status = opt.status;
    btn.textContent = opt.text;
    btn.addEventListener("click", () => {
      responseState[key] = opt.status;
      toggle.querySelectorAll(".status-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
    toggle.appendChild(btn);
  }

  row.appendChild(label);
  row.appendChild(toggle);
  dateList.appendChild(row);
}

// ---------------------------------------------------------------------------
// Submit handler
// ---------------------------------------------------------------------------
const form = document.getElementById("availabilityForm");
const submitBtn = document.getElementById("submitBtn");
const formError = document.getElementById("formError");
const formCard = document.getElementById("formCard");
const successCard = document.getElementById("successCard");
const successName = document.getElementById("successName");
const submitAnotherBtn = document.getElementById("submitAnotherBtn");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.hidden = true;

  const rawName = nameInput.value.trim();
  if (!rawName) {
    formError.textContent = "Please enter your name.";
    formError.hidden = false;
    return;
  }

  const unanswered = Object.values(responseState).some((v) => v === null);
  if (unanswered) {
    formError.textContent = "Please respond to every date before submitting.";
    formError.hidden = false;
    return;
  }

  // Silent roster matching — the visitor never sees this happen.
  const { matchedPerson, confidence, candidates } = matchName(rawName, ROSTER);

  const notes = document.getElementById("notes").value.trim();

  const payload = {
    // What the person actually typed.
    rawName,
    // Best-guess canonical identity, resolved quietly against the roster.
    matchedName: matchedPerson ? matchedPerson.name : null,
    matchedEmail: matchedPerson ? matchedPerson.email : null,
    matchedRoles: matchedPerson ? matchedPerson.roles : [],
    matchConfidence: confidence, // "exact" | "fuzzy" | "partial" | "ambiguous" | "none"
    matchCandidates: candidates, // top guesses, for manual review if confidence is weak
    responses: sundays.map((s) => ({
      date: isoDate(s),
      label: formatDate(s),
      status: responseState[isoDate(s)],
    })),
    notes,
    submittedAt: serverTimestamp(),
  };

  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";

  try {
    await addDoc(collection(db, "responses"), payload);
    successName.textContent = rawName;
    formCard.hidden = true;
    successCard.hidden = false;
  } catch (err) {
    console.error(err);
    formError.textContent = "Something went wrong submitting your response. Please try again.";
    formError.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit Availability";
  }
});

submitAnotherBtn.addEventListener("click", () => {
  form.reset();
  document.querySelectorAll(".status-btn.active").forEach((b) => b.classList.remove("active"));
  for (const key in responseState) responseState[key] = null;
  successCard.hidden = true;
  formCard.hidden = false;
});
