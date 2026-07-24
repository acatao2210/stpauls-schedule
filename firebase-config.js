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

const firebaseConfig = {
  apiKey: "REPLACE_WITH_YOUR_API_KEY",
  authDomain: "REPLACE_WITH_YOUR_PROJECT.firebaseapp.com",
  projectId: "REPLACE_WITH_YOUR_PROJECT_ID",
  storageBucket: "REPLACE_WITH_YOUR_PROJECT.appspot.com",
  messagingSenderId: "REPLACE_WITH_SENDER_ID",
  appId: "REPLACE_WITH_APP_ID",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
