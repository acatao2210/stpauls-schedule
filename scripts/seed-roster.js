// ---------------------------------------------------------------------------
// One-time (or whenever the roster changes) script to upload the private
// roster data (name, email, phone, roles) into Firestore's "roster"
// collection, using the Firebase Admin SDK. Admin SDK access bypasses
// firestore.rules, so this works even though public read/write on the
// "roster" collection is denied and admin read requires being signed in.
//
// This script runs on YOUR machine, never in the browser, so the PII in
// private-roster-data.json never reaches the published site.
//
// Usage:
//   1. npm install firebase-admin
//   2. Download a service account key: Firebase console -> Project settings
//      -> Service accounts -> Generate new private key. Save it as
//      service-account-key.json in this scripts/ folder (or point
//      GOOGLE_APPLICATION_CREDENTIALS at it).
//   3. node scripts/seed-roster.js
//
// IMPORTANT: never commit service-account-key.json or
// private-roster-data.json to a public repo. Both are listed in .gitignore.
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import admin from "firebase-admin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  : path.join(__dirname, "service-account-key.json");

const serviceAccount = JSON.parse(await readFile(keyPath, "utf-8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

async function main() {
  const dataPath = path.join(__dirname, "..", "private-roster-data.json");
  const people = JSON.parse(await readFile(dataPath, "utf-8"));

  const batch = db.batch();
  for (const person of people) {
    // Doc ID = the exact roster name, so it's a direct lookup for whatever
    // shows up as `linkedRosterName` on a response — no slugging/mental
    // math needed when cross-referencing.
    const ref = db.collection("roster").doc(person.name.trim());
    batch.set(ref, person, { merge: true });
  }
  await batch.commit();

  console.log(`Seeded ${people.length} roster entries into Firestore.`);
}

main().catch((err) => {
  console.error("Failed to seed roster:", err);
  process.exit(1);
});
