import { db } from "./firebase-config.js";
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------------------------------------------------------------------
// NOTE: name-matching (free-text -> roster) happens later, in the admin
// page, not here. The public form just records exactly what the person
// types; linking to a roster identity is a separate, authenticated step.
//
// Which month this form asks about is no longer hardcoded — it's read from
// Firestore (config/site.activeMonth, plus that month's doc in `months`),
// so opening a new month is a click on the admin page rather than a code
// change and redeploy.
// ---------------------------------------------------------------------------

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
    console.warn("[form] Device key unavailable, continuing without one:", err.message);
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
  console.log("[form] Requesting IP/location lookup");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://ipapi.co/json/", { signal: controller.signal });
    if (!res.ok) throw new Error(`ipapi.co returned ${res.status}`);
    const data = await res.json();
    console.log("[form] IP/location lookup succeeded");
    return {
      ip: data.ip || null,
      city: data.city || null,
      region: data.region || null,
      country: data.country_name || null,
    };
  } catch (err) {
    console.warn("[form] IP/location lookup skipped:", err.message);
    return { ip: null, city: null, region: null, country: null };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Load the active month and its weeks from Firestore, then build date rows.
//
// Two reads: config/site tells us which month is open, months/{month} holds
// that month's Sundays and their liturgical titles. If either is missing the
// form stays hidden and says so, rather than silently showing no dates.
// ---------------------------------------------------------------------------
const dateList = document.getElementById("dateList");
const responseState = {}; // isoDate -> "yes" | "no"

let activeMonth = null;
let weeks = []; // [{ date, label, title }]

function hideLoading() {
  const loading = document.getElementById("loadingCard");
  if (loading) loading.hidden = true;
}

function setClosedMessage(message) {
  hideLoading();
  const closed = document.getElementById("closedCard");
  const closedText = document.getElementById("closedText");
  if (closedText) closedText.textContent = message;
  if (closed) closed.hidden = false;
  if (formCard) formCard.hidden = true;
}

function monthLabelFor(yearMonth) {
  const [y, m] = yearMonth.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function buildDateRows() {
  for (const week of weeks) {
    const key = week.date;
    responseState[key] = null;

    const row = document.createElement("div");
    row.className = "date-row";
    row.dataset.date = key;

    const label = document.createElement("div");
    label.className = "date-label";

    const dateText = document.createElement("span");
    dateText.className = "date-label-date";
    dateText.textContent = week.label;
    label.appendChild(dateText);

    // The liturgical title ("Fifteenth Sunday in Ordinary Time") is shown
    // under the date so people recognise the Sunday they're answering about.
    if (week.title) {
      const titleText = document.createElement("span");
      titleText.className = "date-label-title";
      titleText.textContent = week.title;
      label.appendChild(titleText);
    }

    const toggle = document.createElement("div");
    toggle.className = "status-toggle";

    const options = [
      { status: "yes", text: "Yes" },
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
}

async function loadActiveMonth() {
  console.log("[form] Loading active month from Firestore");
  const configSnap = await withTimeout(
    getDoc(doc(db, "config", "site")),
    10000,
    "Active-month lookup"
  );

  if (!configSnap.exists() || !configSnap.data().activeMonth) {
    console.warn("[form] No active month is set in config/site");
    setClosedMessage(
      "The availability form isn't open right now. Please check back soon."
    );
    return;
  }

  activeMonth = configSnap.data().activeMonth;
  console.log(`[form] Active month is ${activeMonth}`);

  const monthSnap = await withTimeout(
    getDoc(doc(db, "months", activeMonth)),
    10000,
    "Month lookup"
  );

  if (!monthSnap.exists() || !Array.isArray(monthSnap.data().weeks) || !monthSnap.data().weeks.length) {
    console.warn(`[form] Month ${activeMonth} has no weeks set up`);
    setClosedMessage(
      "The availability form isn't open right now. Please check back soon."
    );
    return;
  }

  weeks = monthSnap.data().weeks;
  console.log(`[form] Loaded ${weeks.length} weeks for ${activeMonth}`);

  const subtitleEl = document.getElementById("subtitle");
  if (subtitleEl) {
    subtitleEl.textContent = `Let us know which Sundays in ${monthLabelFor(
      activeMonth
    )} you're available to serve.`;
  }

  buildDateRows();
  hideLoading();
  if (formCard) formCard.hidden = false;
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
  console.log("[form] Submit triggered");
  formError.hidden = true;

  const rawName = nameInput.value.trim();
  if (!rawName) {
    console.warn("[form] Validation failed: name field empty");
    formError.textContent = "Please enter your name.";
    formError.hidden = false;
    return;
  }

  const unanswered = Object.values(responseState).some((v) => v === null);
  if (unanswered) {
    console.warn("[form] Validation failed: not every date answered");
    formError.textContent = "Please respond to every date before submitting.";
    formError.hidden = false;
    return;
  }

  console.log("[form] Validation passed, preparing submission");
  const notes = document.getElementById("notes").value.trim();

  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";

  try {
    // Response and metadata are written to two separate collections, linked
    // by a shared, human-readable document ID — the response itself never
    // carries device/IP fields, but you can still join them by that ID.
    const submissionId = buildSubmissionId();
    console.log("[form] Generated submission ID");

    const payload = {
      rawName,
      month: activeMonth, // lets the admin page filter/query by month directly
      responses: weeks.map((w) => ({
        date: w.date,
        label: w.label,
        // The liturgical title is stored alongside the answer so the record
        // still reads correctly later even if the month doc is edited.
        title: w.title || "",
        status: responseState[w.date],
      })),
      notes,
      submittedAt: serverTimestamp(),
    };

    console.log("[form] Writing response document");
    await withTimeout(
      setDoc(doc(db, "responses", submissionId), payload),
      10000,
      "Firestore write"
    );
    console.log("[form] Response document written successfully");

    // Metadata write happens after the response is safely recorded, and its
    // failure (or the IP lookup's) never blocks showing success to the
    // visitor — it's best-effort supplementary data.
    try {
      console.log("[form] Collecting submission metadata");
      const ipInfo = await getIpInfo();
      const metaPayload = {
        responseId: submissionId,
        deviceKey: getDeviceKey(),
        ...getBrowserInfo(),
        ...ipInfo,
        submittedAt: serverTimestamp(),
      };
      console.log("[form] Writing metadata document");
      await withTimeout(
        setDoc(doc(db, "submissionMeta", submissionId), metaPayload),
        10000,
        "Metadata write"
      );
      console.log("[form] Metadata document written successfully");
    } catch (metaErr) {
      console.warn("[form] Metadata write failed (response was still saved):", metaErr.message);
    }

    console.log("[form] Submission complete, showing success state");
    successName.textContent = rawName;
    formCard.hidden = true;
    successCard.hidden = false;
  } catch (err) {
    console.error("[form] Submission failed:", err.message);
    formError.textContent = `Something went wrong submitting your response: ${err.message}`;
    formError.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit Availability";
  }
});

submitAnotherBtn.addEventListener("click", () => {
  console.log("[form] Resetting form for another submission");
  form.reset();
  document.querySelectorAll(".status-btn.active").forEach((b) => b.classList.remove("active"));
  for (const key in responseState) responseState[key] = null;
  successCard.hidden = true;
  formCard.hidden = false;
});

// ---------------------------------------------------------------------------
// Kick everything off. Runs last so every const above it is initialised.
// ---------------------------------------------------------------------------
loadActiveMonth().catch((err) => {
  console.error("[form] Could not load the active month:", err.message);
  setClosedMessage(
    "We couldn't load the availability form just now. Please refresh, or try again in a few minutes."
  );
});
