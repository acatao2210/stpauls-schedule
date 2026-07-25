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

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
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

const app = initializeApp(firebaseConfig);

// ---------------------------------------------------------------------------
// App Check — proves to Firestore that a request is genuinely coming from
// this site (via an invisible reCAPTCHA v3 challenge run in the visitor's
// browser), not a script hitting the Firestore API directly with the config
// above copy-pasted out of view-source. This matters here specifically
// because `responses`, `submissionMeta`, `config`, and `months` all have to
// stay open to anyone (no login) so the public form and admin login page
// work — App Check is what keeps "open to anyone" from meaning "open to any
// script," without requiring a login for ordinary visitors.
//
// Setup (see SETUP.md for the full walkthrough):
//   1. Create a reCAPTCHA v3 key at https://www.google.com/recaptcha/admin,
//      registered to your github.io domain.
//   2. Firebase console -> Build -> App Check -> Apps -> register this web
//      app with that same site key.
//   3. Paste the site key below.
//   4. Leave Firestore's enforcement as "Unenforced" in the App Check
//      console for a few days first (monitor traffic), then switch it to
//      "Enforced" once it looks right.
//
// Until a real key is pasted in, this quietly does nothing — Firestore
// keeps working exactly as before, just without the extra verification.
// ---------------------------------------------------------------------------
const RECAPTCHA_V3_SITE_KEY = "REPLACE_WITH_YOUR_RECAPTCHA_V3_SITE_KEY";

if (RECAPTCHA_V3_SITE_KEY && !RECAPTCHA_V3_SITE_KEY.startsWith("REPLACE_")) {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(RECAPTCHA_V3_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
  console.log("[app-check] Initialized");
} else {
  console.warn(
    "[app-check] Not configured yet — set RECAPTCHA_V3_SITE_KEY in firebase-config.js. See SETUP.md."
  );
}

export const db = getFirestore(app);
export const auth = getAuth(app);
