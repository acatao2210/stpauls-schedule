// ---------------------------------------------------------------------------
// Firebase configuration.
//
// Replace the placeholder values below with the config object from your
// Firebase project (Project settings -> General -> Your apps -> SDK setup
// and configuration -> Config). See SETUP.md for the full walkthrough.
//
// Note: this config (apiKey, projectId, etc.) is safe to publish — it's not
// a secret. Access control is enforced by firestore.rules, not by hiding
// this file.
// ---------------------------------------------------------------------------

// Auth is deliberately NOT imported here — only admin.js needs it, and
// pulling in the firebase-auth.js module on the two public pages
// (index.html, schedule.html) meant every visitor's browser was fetching
// and parsing an SDK chunk it never used, for no benefit. admin.js now
// imports getAuth itself and builds its own auth instance from the shared
// `app` exported below.
//
// Firestore is imported from "firebase-firestore-lite.js", not the regular
// "firebase-firestore.js" — the Lite SDK is a smaller build that talks to
// Firestore over plain HTTPS requests instead of opening the full SDK's
// persistent WebChannel (a long-polling connection meant for realtime
// onSnapshot listeners and offline caching). Nothing on this site uses
// either of those — every read here is a one-off getDoc/getDocs, and every
// write a one-off setDoc/updateDoc/deleteDoc — so the full SDK was paying
// for a live connection this site never needed, which was adding a
// noticeable delay before the first Firestore read came back (visible in
// the browser's network tab as several `channel?VER=8&...` requests before
// any real data loads). Lite skips all of that. If a future feature needs
// a live listener (e.g. the admin page auto-refreshing when someone else
// edits the schedule), that specific file would need to switch back to the
// regular SDK — Lite doesn't support onSnapshot at all.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-lite.js";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js";

const firebaseConfig = {
   apiKey: "AIzaSyDyVILg8Mi1nwBEE1uH-7aJpGjDxhW2iIo",
  authDomain: "st-pauls-schedule.firebaseapp.com",
  projectId: "st-pauls-schedule",
  storageBucket: "st-pauls-schedule.firebasestorage.app",
  messagingSenderId: "253588336443",
  appId: "1:253588336443:web:2dc31798f58992dd0e111e",
  measurementId: "G-TFHNNRFX5L"
};

export const app = initializeApp(firebaseConfig);

// ---------------------------------------------------------------------------
// App Check — proves to Firestore that a request is genuinely coming from
// this site (via an invisible reCAPTCHA Enterprise challenge run in the
// visitor's browser), not a script hitting the Firestore API directly with
// the config above copy-pasted out of view-source. This matters here
// specifically because `responses`, `submissionMeta`, `config`, and `months`
// all have to stay open to anyone (no login) so the public form and admin
// login page work — App Check is what keeps "open to anyone" from meaning
// "open to any script," without requiring a login for ordinary visitors.
//
// Using the Enterprise provider (not the older, simpler "v3" one) because
// that's what https://www.google.com/recaptcha/admin now issues by default
// for new keys. It needs the reCAPTCHA Enterprise API enabled on this
// project's Google Cloud console (usually a one-click prompt the first time
// you register the key in Firebase's App Check tab) — see SETUP.md.
//
// Leave Firestore's App Check enforcement as "Unenforced" in the Firebase
// console for a few days first (monitor traffic), then switch it to
// "Enforced" once it looks right.
// ---------------------------------------------------------------------------
const RECAPTCHA_ENTERPRISE_SITE_KEY = "6LfS0GQtAAAAAJZLB2_HTF3pqEJc7nVRk0DJEOX1";

initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
  isTokenAutoRefreshEnabled: true,
});
console.log("[app-check] Initialized (reCAPTCHA Enterprise)");

export const db = getFirestore(app);
