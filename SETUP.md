# Setup guide

## How the pieces fit together

- **`index.html` / `app.js`** — the public form. Anyone can submit; no login. Asks about the Sundays in `TARGET_MONTH` (set at the top of `app.js` — update it by hand once a month). Writes to Firestore's `responses` collection (readable text ID, no PII) and `submissionMeta` (device/browser/IP, linked by matching ID).
- **`admin.html` / `admin.js`** — password-protected (real Firebase Authentication, not a cosmetic gate) page for you to review submissions by month and link each one to a roster identity.
- **`private-roster-data.json`** — private, lives only on your computer, never committed. Full roster: name, email, phone, roles. Uploaded into Firestore via the admin page's "Import roster" button (no Node/CLI needed).
- **`deviceLinks`** collection — Firestore-only (no local file), built automatically as you link submissions. Maps a device key to the roster name it was last linked to, so future submissions from that same browser can be auto-linked.

## 1. Firebase project basics

1. https://console.firebase.google.com -> your project (or **Add project** if starting fresh).
2. **Build > Firestore Database** -> create it if you haven't, production mode.
3. **Firestore Database > Rules** -> paste in `firestore.rules` from this project, **Publish**.

## 2. Enable admin sign-in (Firebase Authentication)

This is what makes "admin page password protection" real — Firestore's rules only let signed-in requests read/edit `responses`, `submissionMeta`, and `roster`, so the password isn't just cosmetic.

1. **Build > Authentication** -> **Get started**.
2. **Sign-in method** tab -> enable **Email/Password**.
3. **Users** tab -> **Add user** -> enter your email and choose a password. This is what you'll type into `admin.html`'s login form.

No billing plan needed for this — Email/Password auth is free on Firebase's Spark (free) plan.

## 3. Seed the private roster into Firestore

No terminal needed — this happens right on the admin page:

1. Sign in to `admin.html` (see step 2 above for creating that login first).
2. Under **Import roster (JSON)**, choose your `private-roster-data.json` file and click **Import**.
3. Confirm the count shown matches your roster, and check **Firestore Database > Data > roster** in the console if you want to double check.

Re-run this any time `private-roster-data.json` changes (someone joins/leaves, contact info changes) — it overwrites existing entries by name rather than duplicating them.

`private-roster-data.json` is `.gitignore`d — never commit it.

## 4. Publish on GitHub Pages

Push everything except the gitignored files: `index.html`, `style.css`, `app.js`, `admin.html`, `admin.css`, `admin.js`, `firebase-config.js`.

**Settings > Pages** -> **Source**: `Deploy from a branch`, branch `main`, folder `/ (root)`.

Your admin page will be at `https://<your-username>.github.io/<repo>/admin.html`. It's not linked from anywhere on the public site, but note it's still just a normal published file — treat the URL itself as something to keep off social media/bulletins, since the real protection is the login, not obscurity.

## 5. Using the admin page

1. Go to `admin.html`, sign in with the email/password from step 2.
2. Pick a month. You'll see every submission whose `month` field matches (i.e., people who answered about that month's Sundays), whether they submitted last week or last year.
3. Each row shows: when they submitted, what they typed as their name, a dropdown to link them to a roster identity, their per-Sunday answers (for that month), notes, and device/IP info.
4. **Auto-linking**: when you open a month, the page automatically tries to link any unlinked submission whose device matches one you've linked before *and* whose typed name is reasonably close to that person's roster name. These show an "Auto-linked" badge — glance over them, since they're applied automatically. Weaker device matches (same device, but the typed name doesn't look close enough) show up as "Suggested (unconfirmed)" — the dropdown is pre-filled with the guess, but nothing is saved until you confirm by re-selecting or leaving it and it registers a change.
5. **Manual linking**: just pick the right name from the dropdown for any unlinked or wrongly-linked row. This also teaches the system — that device gets remembered for that person, so next month's submission from the same device/browser is more likely to auto-link.
6. **Run auto-link** button re-runs the auto-link pass on demand (e.g., after you've manually linked a few people and want it to catch anyone else on the same devices).
7. **Delete** removes a submission (and its metadata) permanently — for spam or accidental duplicate entries.

### Caveats on auto-linking

- It only works if `submissionMeta` for that response actually has a `deviceKey` (it can be missing if the metadata write failed or was blocked, e.g. by an ad blocker).
- It's a same-browser signal, not identity verification. A device can be linked to more than one person over time (e.g. a shared family tablet) — each device remembers every name it's ever been linked to, and a new submission is compared against all of them, auto-linking only if the typed name is close to one of them. A weak match against every known name for that device stays unlinked with an informational hint instead of guessing.
- Matching is case/punctuation-insensitive and tolerates typos, but two people who type very similar names (e.g. "Mike Rallo" vs "Mary Rallo") on a shared device could still be mismatched. Manual override is one click, and the manual-link dropdown itself warns if the typed name doesn't look like the roster name you're picking.

## Changing which month the public form asks about

In `app.js`, change `TARGET_MONTH` (e.g. `"2026-09"`) a few days before the new month starts.
