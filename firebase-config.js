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
export const db = getFirestore(app);
export const auth = getAuth(app);
