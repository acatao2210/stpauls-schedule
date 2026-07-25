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

const app = initializeApp(firebaseConfig);

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
const RECAPTCHA_ENTERPRISE_SITE_KEY = "6Le14GQtAAAAAH0dIGKykv8wHPfPTYJSpo6aNrl8";

initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
  isTokenAutoRefreshEnabled: true,
});
console.log("[app-check] Initialized (reCAPTCHA Enterprise)");

export const db = getFirestore(app);
export const auth = getAuth(app);
