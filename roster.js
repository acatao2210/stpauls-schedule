// Public roster — names ONLY.
//
// This file ships to every visitor's browser (it has to, for the free-text
// name matching to work client-side), so it intentionally contains nothing
// but names. Email, phone, and role data live in Firestore's private
// "roster" collection instead — see scripts/seed-roster.js and SETUP.md.
//
// Edit this list directly to add/remove people. Keep "First Last" format
// for best matching accuracy, and keep it in sync with the private roster
// data you seed into Firestore (same names, so matchedName can join them).

export const ROSTER_NAMES = [
  "Alli Gildea",
  "Amy Gonzalez",
  "Andre Catao",
  "Annamaria Garcia",
  "Bart Luczynski",
  "Connor Mccloskey",
  "Eric Van Eck",
  "Felaniaina Nomenjanahary",
  "Freddy Garcia",
  "Katlyn Twomey",
  "Kristyn Holc",
  "Mary Rallo",
  "Maura Rasmusson",
  "Mike Rallo",
  "Robin Dunn",
  "Ryan Barsa",
  "Sean Gallagher",
  "Stacy Nolan",
];
