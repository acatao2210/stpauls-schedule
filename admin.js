import { db, auth } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
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

function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  const dist = levenshtein(na, nb);
  const longest = Math.max(na.length, nb.length) || 1;
  const direct = 1 - dist / longest;
  const reversed = 1 - levenshtein(na, nb.split(" ").reverse().join(" ")) / longest;
  return Math.max(direct, reversed);
}

// Auto-link only fires above this similarity, given a device-key match
// already provides strong independent evidence it's the same person.
const AUTO_LINK_THRESHOLD = 0.55;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const loginCard = document.getElementById("loginCard");
const loginForm = document.getElementById("loginForm");
const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");
const loginBtn = document.getElementById("loginBtn");
const loginError = document.getElementById("loginError");

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

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  loginBtn.disabled = true;
  loginBtn.textContent = "Signing in…";
  try {
    await signInWithEmailAndPassword(auth, loginEmail.value.trim(), loginPassword.value);
  } catch (err) {
    loginError.textContent = "Sign-in failed: " + (err.message || "check your email/password.");
    loginError.hidden = false;
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Sign in";
  }
});

signOutBtn.addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (user) {
    loginCard.hidden = true;
    dashboard.hidden = false;
    if (!monthInput.value) {
      monthInput.value = new Date().toISOString().slice(0, 7);
    }
    refreshDashboard();
  } else {
    loginCard.hidden = false;
    dashboard.hidden = true;
  }
});

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
let rosterList = [];       // [{ name, email, phone, roles }]
let deviceLinksMap = {};   // { [deviceKey]: { rosterName, lastRawName, linkCount } }

async function loadRoster() {
  const snap = await getDocs(collection(db, "roster"));
  rosterList = snap.docs.map((d) => ({ name: d.id, ...d.data() }));
  rosterList.sort((a, b) => a.name.localeCompare(b.name));
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
    for (const person of people) {
      if (!person.name || !person.name.trim()) {
        console.warn("[roster import] Skipping entry with no name:", person);
        continue;
      }
      console.log("[roster import] Writing:", person.name);
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
  const snap = await getDocs(collection(db, "deviceLinks"));
  deviceLinksMap = {};
  snap.docs.forEach((d) => {
    deviceLinksMap[d.id] = d.data();
  });
}

async function loadResponsesForMonth(month) {
  const q = query(collection(db, "responses"), where("month", "==", month));
  const snap = await getDocs(q);
  const responses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Fetch each response's metadata doc in parallel (same ID, separate
  // collection — see submissionMeta rules/design).
  const metas = await Promise.all(
    responses.map((r) =>
      getDoc(doc(db, "submissionMeta", r.id)).then((snap) => (snap.exists() ? snap.data() : null))
    )
  );

  return responses.map((r, i) => ({ ...r, meta: metas[i] }));
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------
async function applyLink(responseId, rosterName, linkStatus, deviceKey) {
  await updateDoc(doc(db, "responses", responseId), {
    linkedRosterName: rosterName,
    linkStatus,
    linkedAt: serverTimestamp(),
  });

  if (deviceKey) {
    await setDoc(
      doc(db, "deviceLinks", deviceKey),
      {
        rosterName,
        lastLinkedAt: serverTimestamp(),
        linkCount: increment(1),
      },
      { merge: true }
    );
  }
}

// Runs against whatever is currently loaded; auto-links confident matches
// and leaves the rest for manual review via the dropdown.
async function runAutoLink(items) {
  let autoCount = 0;
  for (const item of items) {
    if (item.linkedRosterName) continue;
    const deviceKey = item.meta?.deviceKey;
    if (!deviceKey) continue;
    const learned = deviceLinksMap[deviceKey];
    if (!learned?.rosterName) continue;

    const sim = nameSimilarity(item.rawName, learned.rosterName);
    if (sim >= AUTO_LINK_THRESHOLD) {
      await applyLink(item.id, learned.rosterName, "auto", deviceKey);
      item.linkedRosterName = learned.rosterName;
      item.linkStatus = "auto";
      autoCount++;
    } else {
      // Below threshold: surface as a suggestion in the dropdown, but
      // don't write anything until the admin confirms it.
      item._suggestedName = learned.rosterName;
    }
  }
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
    const preselect = item.linkedRosterName || item._suggestedName || "";
    renderRosterOptions(select, preselect);

    const badge = document.createElement("span");
    badge.className = "link-badge";
    if (item.linkedRosterName) {
      badge.classList.add(item.linkStatus === "auto" ? "auto" : "manual");
      badge.textContent = item.linkStatus === "auto" ? "Auto-linked" : "Linked";
    } else if (item._suggestedName) {
      badge.classList.add("unlinked");
      badge.textContent = "Suggested (unconfirmed)";
    } else {
      badge.classList.add("unlinked");
      badge.textContent = "Unlinked";
    }

    select.addEventListener("change", async () => {
      const newName = select.value || null;
      select.disabled = true;
      try {
        if (newName) {
          await applyLink(item.id, newName, "manual", item.meta?.deviceKey);
          item.linkedRosterName = newName;
          item.linkStatus = "manual";
        } else {
          await updateDoc(doc(db, "responses", item.id), {
            linkedRosterName: null,
            linkStatus: null,
            linkedAt: serverTimestamp(),
          });
          item.linkedRosterName = null;
          item.linkStatus = null;
        }
        renderTable(items, month);
      } catch (err) {
        dashboardError.textContent = "Failed to save link: " + err.message;
        dashboardError.hidden = false;
      } finally {
        select.disabled = false;
      }
    });

    linkTd.appendChild(select);
    linkTd.appendChild(document.createElement("br"));
    linkTd.appendChild(badge);
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
      if (!confirm(`Delete this submission from "${item.rawName}"? This can't be undone.`)) return;
      try {
        await deleteDoc(doc(db, "responses", item.id));
        await deleteDoc(doc(db, "submissionMeta", item.id)).catch(() => {});
        await refreshDashboard();
      } catch (err) {
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
  summaryLine.textContent =
    `${total} submission${total === 1 ? "" : "s"} — ` +
    `${auto} auto-linked, ${manual} manually linked, ${unlinked} unlinked.`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
let currentItems = [];

async function refreshDashboard() {
  dashboardError.hidden = true;
  summaryLine.textContent = "Loading…";
  responsesBody.innerHTML = "";
  const month = monthInput.value;
  if (!month) return;

  try {
    await Promise.all([loadRoster(), loadDeviceLinks()]);
    currentItems = await loadResponsesForMonth(month);
    await runAutoLink(currentItems);
    renderTable(currentItems, month);
    renderSummary(currentItems);
  } catch (err) {
    dashboardError.textContent = "Failed to load data: " + err.message;
    dashboardError.hidden = false;
    summaryLine.textContent = "";
  }
}

refreshBtn.addEventListener("click", refreshDashboard);
monthInput.addEventListener("change", refreshDashboard);

autoLinkBtn.addEventListener("click", async () => {
  autoLinkBtn.disabled = true;
  autoLinkBtn.textContent = "Running…";
  try {
    await loadDeviceLinks();
    const count = await runAutoLink(currentItems);
    renderTable(currentItems, monthInput.value);
    renderSummary(currentItems);
    summaryLine.textContent += ` (${count} newly auto-linked)`;
  } catch (err) {
    dashboardError.textContent = "Auto-link failed: " + err.message;
    dashboardError.hidden = false;
  } finally {
    autoLinkBtn.disabled = false;
    autoLinkBtn.textContent = "Run auto-link";
  }
});
