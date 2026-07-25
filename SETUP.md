# Setup guide

## How the pieces fit together

- **`liturgical.js`** — works out the proper title of any Sunday ("Fifteenth Sunday in Ordinary Time", "Palm Sunday of the Passion of the Lord") by calculating the Church calendar from the date of Easter. No network call, no API key, nothing to break. Used by the admin page when you create a month's weeks.
- **`index.html` / `app.js`** — the public form. Anyone can submit; no login. Reads which month is open from Firestore and shows that month's Sundays with their liturgical titles. Writes to Firestore's `responses` collection (readable text ID, no PII) and `submissionMeta` (device/browser/IP, linked by matching ID).
- **`admin.html` / `admin.js`** — password-protected (real Firebase Authentication, not a cosmetic gate) page for you to open a month to the parish, review submissions, link each one to a roster identity, and build the schedule. The month picker defaults to whichever month is currently live.
- **`config/site`** and **`months/{YYYY-MM}`** collections — Firestore-only. `config/site.activeMonth` is the single month the public form is asking about; `months/{YYYY-MM}` holds that month's Sundays and their liturgical titles. Both are publicly readable (the form needs them before anyone signs in) and admin-only to write.
- **`monthsPrivate/{YYYY-MM}`** collection — Firestore-only, admin-only both to read and write. Holds notes about a month's Sundays that must never reach the public form, like which ones are Pre-Cana weekends. Kept as a separate document from `months/{YYYY-MM}` on purpose, since Firestore's rules grant or deny a whole document rather than individual fields — the only way to keep one field private on an otherwise-public document is to not put it in that document.
- **`private-roster-data.json`** — private, lives only on your computer, never committed. Full roster: name, email, phone, roles. Uploaded into Firestore via the admin page's "Import roster" button (no Node/CLI needed).
- **`deviceLinks`** collection — Firestore-only (no local file), built automatically as you link submissions. Maps a device key to the roster name it was last linked to, so future submissions from that same browser can be auto-linked.
- **`schedules`** collection — Firestore-only, one doc per month (doc ID = `"YYYY-MM"`). Holds the actual Mass role assignments (`{ date: { role: [name, name, ...] } }`), built by the admin page's "Auto-assign" button from linked availability, and editable by hand afterward. Every change (auto or manual) writes straight to Firestore, so nothing is lost on refresh.

## 1. Firebase project basics

1. https://console.firebase.google.com -> your project (or **Add project** if starting fresh).
2. **Build > Firestore Database** -> create it if you haven't, production mode.
3. **Firestore Database > Rules** -> paste in `firestore.rules` from this project, **Publish**.

`firestore.rules` is gitignored, so it never gets deployed automatically — any time it changes in this project you have to re-paste and re-publish it here by hand. It currently covers `config`, `months`, `monthsPrivate`, `responses`, `submissionMeta`, `roster`, `deviceLinks`, and `schedules`.

## 2. Enable admin sign-in (Firebase Authentication)

This is what makes "admin page password protection" real — Firestore's rules only let requests from an authorized admin read/edit `responses`, `submissionMeta`, `roster`, and `deviceLinks`, so the password isn't just cosmetic.

The admin page supports two sign-in methods; enable either or both:

**Email/Password:**
1. **Build > Authentication** -> **Get started**.
2. **Sign-in method** tab -> enable **Email/Password**.
3. **Users** tab -> **Add user** -> enter your email and choose a password. This is what you'll type into `admin.html`'s login form.

**Google Sign-In:**
1. **Sign-in method** tab -> enable **Google**.
2. That's it on the Firebase side — no user to manually create, since anyone with a Google account can attempt to sign in.

⚠️ **Important**: unlike Email/Password (where only accounts you explicitly create can log in), enabling Google Sign-In means *any* Google account could try to sign into `admin.html`. To prevent that, `firestore.rules` restricts real access to a specific allowlist of emails via the `isAdmin()` function at the top of the file — currently just `acatao2210@gmail.com`. `admin.js` has a matching `ALLOWED_ADMIN_EMAILS` list that signs out (with a message) anyone not on it, as a faster/friendlier check, but the rules file is what actually enforces it. **If you add someone else as an admin, update the email list in both `firestore.rules` and `admin.js`.**

No billing plan needed for any of this — both sign-in methods are free on Firebase's Spark (free) plan.

## 3. Seed the private roster into Firestore

No terminal needed — this happens right on the admin page:

1. Sign in to `admin.html` (see step 2 above for creating that login first).
2. Under **Import roster (JSON)**, choose your `private-roster-data.json` file and click **Import**.
3. Confirm the count shown matches your roster, and check **Firestore Database > Data > roster** in the console if you want to double check.

Re-run this any time `private-roster-data.json` changes (someone joins/leaves, contact info changes) — it overwrites existing entries by name rather than duplicating them.

`private-roster-data.json` is `.gitignore`d — never commit it.

## 4. Publish on GitHub Pages

Push everything except the gitignored files: `index.html`, `style.css`, `app.js`, `admin.html`, `admin.css`, `admin.js`, `liturgical.js`, `firebase-config.js`.

**Settings > Pages** -> **Source**: `Deploy from a branch`, branch `main`, folder `/ (root)`.

Your admin page will be at `https://<your-username>.github.io/<repo>/admin.html`. It's not linked from anywhere on the public site, but note it's still just a normal published file — treat the URL itself as something to keep off social media/bulletins, since the real protection is the login, not obscurity.

## 5. Using the admin page

**First time through, open a month** — until you do, the public form shows a "check back soon" message and nobody can submit. See [Opening a new month](#opening-a-new-month) below; it's three clicks.

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

## 6. Turning availability into a schedule

Below the weekly roster summary, the **Schedule** card builds and stores the actual Mass assignments for the selected month, in Firestore's `schedules/{month}` doc.

- **Slots per Sunday**: 2 Lectors, 2 Extraordinary Ministers, 1 Collector (set in `admin.js` via `ROLE_SLOTS` — change there if the parish's needs change).
- **Auto-assign**: fills only empty slots from people who answered "yes" or "maybe" and are linked to a roster identity. It never overwrites an assignment you already made (by hand or by a previous auto-assign run), so it's safe to click again after linking more submissions.
  - Nobody is double-booked into two roles on the same Sunday.
  - For Lector and Extraordinary Minister, it avoids repeating the same person on back-to-back Sundays (including across a month boundary, by checking the previous month's last Sunday). Collectors are exempt from this rule. If the "no repeat" rule would leave a slot empty, it's relaxed rather than leaving a gap.
  - Ties are broken by preferring "yes" over "maybe," then whoever has fewer assignments so far this month (for fairness), then alphabetically.
  - After running, the status line reports how many slots were filled, how many still need coverage (nobody available/linked yet — these show in red as "needs coverage" in the table), and how many needed the back-to-back rule relaxed.
- **Manual edits**: every cell in the schedule table is a dropdown (available people first, then the rest of the roster). Changing it saves to Firestore immediately — there's no separate "publish" step.
- **Clear schedule**: wipes every assignment for the selected month after a confirmation prompt. Can't be undone.

Remember: `schedules` is gitignored-adjacent in spirit (it's Firestore-only, not a local file), but it's still covered by the same `isAdmin()` rule as everything else — make sure the updated `firestore.rules` (with the `schedules/{month}` match block) is published in the Firebase console.

## 7. Enable App Check (bot/abuse protection)

`responses`, `submissionMeta`, `config`, and `months` have to stay readable/writable without a login — that's what lets the public form and the admin login page work. App Check closes the gap that leaves open: without it, anyone could copy the `firebaseConfig` object out of view-source and hit Firestore directly with a script, bypassing the site entirely (spamming fake availability responses, for instance). App Check verifies each request came from a real browser on your actual site, via an invisible reCAPTCHA check — no puzzle, no checkbox, visitors never see it.

1. **Create a reCAPTCHA key**: https://www.google.com/recaptcha/admin/create -> add the domain(s) your site is served from (e.g. `<your-username>.github.io`; add `localhost` too if you ever test locally). As of 2026, Google's admin console issues **reCAPTCHA Enterprise** keys by default rather than the older "v3" ones — that's expected, the site code here is already set up for Enterprise. Save, then copy the **Site key** (it's the ID in the script snippet Google shows you, e.g. `6Le1...`).
2. **Firebase console -> Build -> App Check -> Apps** -> find this web app -> **Register** -> provider **reCAPTCHA Enterprise** -> paste in the same site key. The console will prompt you to enable the **reCAPTCHA Enterprise API** on this project's Google Cloud console if it isn't already — accept that, it's a one-click, no-cost API enablement (not a new billing plan).
3. `firebase-config.js` already has the site key from the console output; if you ever regenerate the key, update `RECAPTCHA_ENTERPRISE_SITE_KEY` there to match.
4. Push the change and let it deploy.
5. Back in the App Check console, leave Firestore's enforcement as **Unenforced** for a few days first. This mode reports which requests are arriving with valid App Check tokens without blocking anything, so you can confirm real traffic (the public form, the admin page) is passing before anything is at risk of breaking.
6. Once the metrics look right — real submissions showing verified, nothing legitimate showing unverified — switch Firestore to **Enforced** in the App Check console. From that point, any request without a valid token is rejected before it reaches your `firestore.rules`.

⚠️ Don't switch Firestore to **Enforced** in the App Check console until step 2 is actually done (the app registered there with the same site key that's in `firebase-config.js`) — enforcing before that will reject every request from the real site too, not just abusive ones.

## Opening a new month

This used to mean editing `config.js` and pushing a commit. It's now three clicks on the admin page, and nothing is deployed:

1. Sign in to `admin.html` and set the **Month** picker to the new month (e.g. `2026-09`).
2. In the **Availability month** card, click **Create weeks**. Every Sunday in that month appears with its liturgical title already filled in — "Twenty-third Sunday in Ordinary Time", "First Sunday of Advent", and so on.
3. Skim the titles. Each row has a **USCCB ↗** link straight to that date's page on bible.usccb.org, so you can check any that look off in one click. To change one, just type over it — it saves as soon as you click away.
4. Click **Open to the parish**. That sets `config/site.activeMonth`, and the public form switches to the new month immediately for everyone. The old month's submissions stay exactly where they are; you can still pull them up any time with the month picker.

The card always tells you which month is currently live, so there's no ambiguity about what the parish is seeing.

Each row also has a **Pre-Cana** checkbox — a private note-to-self that a given Sunday is a Pre-Cana weekend. It saves the moment you click it, has nothing to do with opening the month, and never appears anywhere on the public form (it's stored in `monthsPrivate`, a separate admin-only document — see above).

### Where the titles come from

`liturgical.js` calculates the whole Church calendar from the date of Easter — Ash Wednesday, the Sundays of Lent and Easter, Pentecost, the Ordinary Time numbering (counted forward from the Baptism of the Lord and backward from Christ the King), Advent, the Christmas season, and the fixed solemnities that displace a Sunday, like the Assumption and All Saints.

It's calculated rather than scraped because bible.usccb.org doesn't send the CORS headers a browser needs to let another website read its pages, and this site is just static files on GitHub Pages with no server to fetch on its behalf. Calculating avoids depending on a third-party proxy that could quietly stop working some Saturday night. The titles were checked against USCCB for 2026 and verified internally for consistency across 2024–2045, and every one is editable by hand anyway.

Two settings at the top of `liturgical.js` are worth knowing about:

- `ASCENSION_TRANSFERRED_TO_SUNDAY` is `false`, because the Diocese of Paterson is in the Province of Newark, which keeps Ascension on Thursday. Most of the US moves it to the Sunday. If this is ever reused by a parish elsewhere, flip that to `true`. (Note that bible.usccb.org shows the transferred version, so that one Sunday in May may look like a mismatch when you check the link — it isn't.)
- `EPIPHANY_ON_SUNDAY` is `true`, matching US practice.
