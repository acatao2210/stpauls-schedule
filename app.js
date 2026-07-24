import { db } from "./firebase-config.js";
import {
  doc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------------------------------------------------------------------
// NOTE: name-matching (free-text -> roster) happens later, in the admin
// page, not here. The public form just records exactly what the person
// types; linking to a roster identity is a separate, authenticated step.
// ---------------------------------------------------------------------------

// Config: which month's Sundays to ask about. Update this by hand once a
// month (e.g. when August starts, change it to "2026-09" a week or so
// before the switch). Format: "YYYY-MM".
const TARGET_MONTH = "2026-08";

function getSundaysInMonth(yearMonth) {
  const [year, month] = yearMonth.split("-").map(Number); // month is 1-12
  const dates = [];
  const d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) {
    if (d.getDay() === 0) dates.push(new Date(d));
    d.setDate(d.getDate() + 1);
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

const sundays = getSundaysInMonth(TARGET_MONTH);

const subtitleEl = document.getElementById("subtitle");
if (subtitleEl) {
  const [y, m] = TARGET_MONTH.split("-").map(Number);
  const monthLabel = new Date(y, m - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  subtitleEl.textContent = `St. Paul's Inside the Walls — let us know which Sundays in ${monthLabel} you're available to serve.`;
}

const nameInput = document.getElementById("nameInput");

// ---------------------------------------------------------------------------
// Submission metadata (device/browser + best-effort IP/location).
// None of this is shown to the visitor; it's just attached to the record.
// ---------------------------------------------------------------------------
function getDeviceType(ua) {
  if (/iPad|Tablet(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return "mobile";
  return "desktop";
}

// Stable per-device/browser key, generated once and reused on every future
// visit via localStorage — lets you spot repeat submissions from the same
// device by matching this key across submissionMeta docs, without any
// visible sign-in or UI. Not a perfect fingerprint (cleared if the visitor
// clears site data, or differs per-browser on the same device), just a
// best-effort linking signal.
const DEVICE_KEY_STORAGE_KEY = "spw_device_key";

function getDeviceKey() {
  try {
    let key = localStorage.getItem(DEVICE_KEY_STORAGE_KEY);
    if (!key) {
      key = crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(DEVICE_KEY_STORAGE_KEY, key);
    }
    return key;
  } catch (err) {
    // localStorage can be unavailable (private browsing, disabled storage).
    // Fail quietly — the submission still goes through, just unlinked.
    console.warn("Device key unavailable:", err.message);
    return null;
  }
}

function getBrowserInfo() {
  const ua = navigator.userAgent;
  return {
    userAgent: ua,
    deviceType: getDeviceType(ua),
    platform: navigator.platform || null,
    language: navigator.language || null,
    screen: `${window.screen.width}x${window.screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    referrer: document.referrer || null,
  };
}

async function getIpInfo(timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://ipapi.co/json/", { signal: controller.signal });
    if (!res.ok) throw new Error(`ipapi.co returned ${res.status}`);
    const data = await res.json();
    return {
      ip: data.ip || null,
      city: data.city || null,
      region: data.region || null,
      country: data.country_name || null,
    };
  } catch (err) {
    console.warn("IP lookup skipped:", err.message);
    return { ip: null, city: null, region: null, country: null };
  } finally {
    clearTimeout(timer);
  }
}

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
// Readable submission IDs: YYYYMMDD_HHmm_xxxx (date/time + short random
// suffix), instead of Firestore's opaque auto-IDs. Sorts chronologically
// and is easy to eyeball in the console; the random suffix just guards
// against two submissions landing in the same minute.
// ---------------------------------------------------------------------------
function buildSubmissionId(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const datePart = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}${pad(date.getMinutes())}`;
  const randomPart = Math.random().toString(36).slice(2, 6);
  return `${datePart}_${timePart}_${randomPart}`;
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

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms — check Firestore rules/config`)), ms)
    ),
  ]);
}

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

  const notes = document.getElementById("notes").value.trim();

  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";

  try {
    // Response and metadata are written to two separate collections, linked
    // by a shared, human-readable document ID — the response itself never
    // carries device/IP fields, but you can still join them by that ID.
    const submissionId = buildSubmissionId();

    const payload = {
      rawName,
      month: TARGET_MONTH, // lets the admin page filter/query by month directly
      responses: sundays.map((s) => ({
        date: isoDate(s),
        label: formatDate(s),
        status: responseState[isoDate(s)],
      })),
      notes,
      submittedAt: serverTimestamp(),
    };

    console.log("Submitting payload:", submissionId, payload);
    await withTimeout(
      setDoc(doc(db, "responses", submissionId), payload),
      10000,
      "Firestore write"
    );

    // Metadata write happens after the response is safely recorded, and its
    // failure (or the IP lookup's) never blocks showing success to the
    // visitor — it's best-effort supplementary data.
    try {
      const ipInfo = await getIpInfo();
      const metaPayload = {
        responseId: submissionId,
        deviceKey: getDeviceKey(),
        ...getBrowserInfo(),
        ...ipInfo,
        submittedAt: serverTimestamp(),
      };
      await withTimeout(
        setDoc(doc(db, "submissionMeta", submissionId), metaPayload),
        10000,
        "Metadata write"
      );
    } catch (metaErr) {
      console.warn("Metadata write failed (response was still saved):", metaErr);
    }

    successName.textContent = rawName;
    formCard.hidden = true;
    successCard.hidden = false;
  } catch (err) {
    console.error("Submit failed:", err);
    formError.textContent = `Something went wrong submitting your response: ${err.message}`;
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
