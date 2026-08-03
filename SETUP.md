# Setup guide

## Performance notes

All three pages use the Firestore **Lite** SDK (`firebase-firestore-lite.js`), not the regular one. The regular Firestore SDK opens a persistent connection (a "WebChannel") meant for realtime `onSnapshot` listeners and offline caching — neither of which this site uses anywhere; every read here is a one-off `getDoc`/`getDocs`, every write a one-off `setDoc`/`updateDoc`/`deleteDoc`. Lite skips the persistent-connection setup entirely and just makes plain HTTPS requests, which noticeably shortens the time before the first real data shows up, especially on `schedule.html` and `index.html` where a first-time visitor is waiting on that. If a future feature genuinely needs a live listener (e.g. the admin page auto-refreshing when a second admin edits the schedule at the same time), that specific file would need to import from `firebase-firestore.js` instead — Lite doesn't support `onSnapshot` at all.

Similarly, `firebase-config.js` doesn't import or initialize Firebase Auth — only `admin.js` needs sign-in, so it builds its own `auth` from the shared `app` Firebase exports. `index.html` and `schedule.html` never load the Auth SDK at all, since neither needs it.

## How the pieces fit together

- **`liturgical.js`** — works out the proper title of any Sunday ("Fifteenth Sunday in Ordinary Time", "Palm Sunday of the Passion of the Lord") by calculating the Church calendar from the date of Easter. No network call, no API key, nothing to break. Used by the admin page when you create a month's weeks.
- **`index.html` / `app.js`** — the public form. Anyone can submit; no login. Reads which month is open from Firestore and shows that month's Sundays with their liturgical titles. Writes to Firestore's `responses` collection (readable text ID, no PII) and `submissionMeta` (device/browser/IP, linked by matching ID).
- **`admin.html` / `admin.js`** — password-protected (real Firebase Authentication, not a cosmetic gate) page for you to open a month to the parish, review submissions, link each one to a roster identity, and build the schedule. The month picker defaults to whichever month is currently live.
- **`config/site`** and **`months/{YYYY-MM}`** collections — Firestore-only. `config/site.activeMonth` is the single month the public form is asking about; `months/{YYYY-MM}` holds that month's Sundays, their liturgical titles, and admin notes like a `preCana` flag. Both are publicly readable (the form needs them before anyone signs in) and admin-only to write. The public form only ever displays a week's `date`/`label`/`title` — it just never reads or shows anything else, including `preCana`. That's "not displayed," not "hidden": since `months/{YYYY-MM}` is a publicly readable document, every field on it (including `preCana`) is technically fetchable by anyone who queries Firestore directly rather than going through the site. If a field ever needs to be a hard secret rather than just absent from the page, it would need its own admin-only document instead.
- **`private-roster-data.json`** — private, lives only on your computer, never committed. Full roster: name, email, phone, roles. Uploaded into Firestore via the admin page's "Import roster" button (no Node/CLI needed).
- **`deviceLinks`** collection — Firestore-only (no local file), built automatically as you link submissions. Maps a device key to the roster name it was last linked to, so future submissions from that same browser can be auto-linked.
- **`email.html` / `email.js` / `email.css`** — admin-only tool for drafting the weekly ministry email. Same sign-in as the admin page. Pulls the date list and liturgical titles from `months/{YYYY-MM}` and the assigned readers/EMs/ushers from `schedules/{YYYY-MM}`, shows a live preview, and copies the finished HTML to the clipboard. See **Writing the weekly email** below.
- **`checklist.html` / `checklist.js` / `checklist.css`** — a pre-Mass run-through to tick off on a phone in the sacristy. Public but unlisted (`noindex`, not linked from the availability form), since it holds nothing beyond the first names already on the schedule. See **The Sunday checklist** below.
- **`names.js`** — the one place that decides how a person's name is shortened for public display: first name only ("Amy"), a last initial where that would be ambiguous ("John S"), the full name if even that collides. Shared by the schedule page and the email generator so the two can't drift apart. What counts as ambiguous depends on the pool of names each page can see — the email generator includes the roster, the public schedule can only see the published schedule (the roster is admin-only), which is the right pool for it anyway.
- **`schedules`** collection — Firestore-only, one doc per month (doc ID = `"YYYY-MM"`). Holds the actual Mass role assignments (`{ date: { role: [name, name, ...] } }`), built by the admin page's "Auto-assign" button from linked availability, and editable by hand afterward. Every change (auto or manual) writes straight to Firestore, so nothing is lost on refresh.

## 1. Firebase project basics

1. https://console.firebase.google.com -> your project (or **Add project** if starting fresh).
2. **Build > Firestore Database** -> create it if you haven't, production mode.
3. **Firestore Database > Rules** -> paste in `firestore.rules` from this project, **Publish**.

`firestore.rules` is gitignored, so it never gets deployed automatically — any time it changes in this project you have to re-paste and re-publish it here by hand. It currently covers `config`, `months`, `responses`, `submissionMeta`, `roster`, `deviceLinks`, and `schedules` (the last one is now publicly readable, not admin-only — see **Publishing the schedule** below — so make sure you've re-pasted the latest version if `schedule.html` shows nothing but the admin page shows assignments fine).

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

For a single addition or edit, there's also an **Add roster member** card at the very bottom of the admin page — a plain form (name, email, phone, roles) for when it's not worth updating and re-uploading the whole JSON file for one person. Same overwrite-by-name behavior as the file import.

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
2. In the **Availability month** card, click **Reset schedule**. Every Sunday in that month appears with its liturgical title already filled in — "Twenty-third Sunday in Ordinary Time", "First Sunday of Advent", and so on. (This button only fills in that month's data in Firestore — it doesn't make anything live yet. If the month already has weeks, it asks first, since it overwrites any titles you'd hand-edited back to the computed defaults; Pre-Cana flags and any custom days you've added are preserved either way.)
3. Skim the titles. Each row has a **USCCB ↗** link straight to that date's page on bible.usccb.org, so you can check any that look off in one click. To change one, just type over it — it saves as soon as you click away.
4. Click **Open to the parish**. That sets `config/site.activeMonth`, and the public form switches to the new month immediately for everyone. The old month's submissions stay exactly where they are; you can still pull them up any time with the month picker.

The card always tells you which month is currently live, so there's no ambiguity about what the parish is seeing.

Each row also has a **Pre-Cana** checkbox — a note-to-self that a given Sunday is a Pre-Cana weekend. It saves the moment you click it, has nothing to do with opening the month, and the public form never reads or displays it (see the caveat above about what "not displayed" does and doesn't guarantee).

### Adding a special day (Christmas, Holy Week, etc.)

The month card only auto-fills Sundays, since those follow a predictable calendar pattern — but plenty of ministry days aren't Sundays: Christmas Eve, Holy Thursday, Good Friday, an Easter Vigil, and so on. Use **Add a day** at the bottom of the card for these:

1. Make sure the **Month** picker above is set to the month the day falls in.
2. Pick the date and type a title (there's no calendar formula for these, so it's free text — e.g. "Christmas Eve Vigil (4pm)").
3. Click **Add day**. It's saved immediately and shows up everywhere a Sunday does — the public form, the weekly roster summary, and the schedule — with a small **Custom** badge in this table so it's easy to tell apart from a regular Sunday.

Custom days survive clicking **Reset schedule** (that button only touches the computed Sundays). To remove one, use the **Remove** link on its row — that option is only available for custom days, since the regular Sundays are meant to be regenerated by Reset schedule rather than deleted one at a time.

## Publishing the schedule

`schedule.html` is a separate, public, read-only page — no sign-in — that shows who's serving, grouped by month. It only shows a date once you explicitly publish it:

1. In the admin page's **Schedule** card, each date's column header has a **Publish** button under its title. It's a plain outline until you click it, then turns solid gold and reads **Published**.
2. Publishing saves instantly (same `published` flag on that date's entry in `months/{month}.weeks` that Pre-Cana uses) and takes effect on `schedule.html` immediately — no separate "go live" step.
3. Click it again to unpublish. There's no bulk "publish the whole month" button by design — the idea is you publish a date once its assignments are actually settled, not the moment the month is created.
4. `schedule.html` groups whatever's published across every month into sections with a divider between each, so it's fine to have this month's later Sundays still unpublished while next month's Christmas schedule is already out, or similar.

Link to it from the parish-facing footer on the availability form, or send people the URL directly (`schedule.html` off this site's root, same as `index.html`).

Same caveat as Pre-Cana: `published` controls what the page *displays*, not what's fetchable by someone querying Firestore directly — the whole `schedules/{month}` document (every date, published or not) is readable by anyone once the rules change above is live, since Firestore rules apply per-document, not per-field. If that's ever a real concern, unpublished assignments would need to move to a separate admin-only document.

## The Sunday checklist

`checklist.html` is a pre-Mass run-through meant to be opened on a phone in the sacristy. It opens on today's date automatically if today is a scheduled day, otherwise the next one coming up, so on a Sunday morning it needs no interaction.

Two kinds of item. **Who's here** is built from that day's actual assignments, so it lists real people by name rather than asking a vague "is everyone here" — lectors stay numbered 1 and 2 since reading order matters, and an unassigned lector slot shows in red as a gap to cover rather than quietly not appearing. **Everything else** is a fixed list: readings, intentions, intercessions, mic batteries and a mic test, hosts and wine, ciborium count, chalice, cruets, linens, candles, offertory baskets, gift bearers. To change that list, edit `FIXED_SECTIONS` at the top of `checklist.js`.

Ticks are saved in the browser's local storage, keyed by date — a refresh mid-morning keeps them, and next Sunday starts clean. They're deliberately *not* written to Firestore: it's a personal working list, not a record anyone else needs, and this way it costs nothing and works even if the connection drops after the page has loaded. The flip side is that ticks don't follow you to another device, and **Clear ticks** only clears the date you're looking at.

It's unlisted rather than admin-gated — no sign-in on a phone in a sacristy — and carries `noindex`. It's reachable from the schedule page's corner link, and the checklist links back the same way.

## Writing the weekly email

`email.html` drafts the Sunday ministry email. It's behind the same sign-in as the admin page (reachable from the **Email generator** button in the admin header), and it reads from the same data you're already maintaining rather than a separate list.

1. Pick a **Month** and **Date**. Both default to the next upcoming Sunday, so most weeks it opens on the right one.
2. **Sunday name** pre-fills with the liturgical title from the Availability month table, and the reader / EM / usher fields pre-fill from that date's assignments in the Schedule table. If nobody's assigned yet, those come up blank and a note says so.
3. Type the parts the schedule doesn't know: intro message, gospel, the two reading citations, and a reflection title/link if there is one. These **save automatically** (about a second after you stop typing — watch for "Saved" next to Live Preview), so a half-finished draft survives a refresh or picking it back up on another computer.
4. **Copy HTML** puts the finished email on your clipboard, ready to paste into your mail client's HTML/source view.

**Prewritten drafts (`email-seed.json`).** Covers all 26 Sundays of July–December 2026. The **Import saved drafts** button at the bottom of the sidebar writes them into Firestore; it only fills weeks that have nothing written yet, so it's safe to click twice and can't overwrite anything newer. The months have to exist in the Availability month table first — create them on the admin page if the import reports nothing to do.

⚠️ The two halves have different provenance. **July–September** was recovered from the standalone generator file this replaced, so those citations were in use already. **October–December** was drafted afterwards and its reading citations have *not* been verified against bible.usccb.org — that site returns an empty body to automated requests, which is the same reason `liturgical.js` computes titles rather than scraping them. Check each against the USCCB link in the email before sending. Two specific things to look at:

- **Dec 27 (Holy Family)** has more than one permitted set of readings; the seed uses the Year B set (Genesis / Hebrews), but the Sirach / Colossians set is also allowed in any year and may be what your parish uses.
- **Advent begins Nov 29, 2026**, which starts a new liturgical year — the gospels switch from Matthew (Year A) to Mark (Year B). If a December gospel reads as Matthew, something is wrong.

The liturgical *titles* in the seed are independently cross-checked against `liturgical.js`, so those can be trusted; it's the chapter-and-verse citations that want a second pair of eyes.

Names in the email are shortened to first names ("Amy"). If two people share a first name they get a last initial instead ("John S", "John B"), and if even that would be ambiguous — two John S's — both fall back to their full names. That's judged against the whole roster rather than just who's serving that Sunday, so a given person always reads the same way week to week.

Two things worth knowing. The role fields are editable but *not* saved — they're refreshed from the schedule every time you change dates, so if you type a name there by hand it's for that session only; the fix for a wrong name is the Schedule table. And the generated email is deliberately old-fashioned HTML (nested tables, inline styles) because that's what renders correctly in Outlook and Gmail — it looks dated in a code editor for good reason.

### Where the titles come from

`liturgical.js` calculates the whole Church calendar from the date of Easter — Ash Wednesday, the Sundays of Lent and Easter, Pentecost, the Ordinary Time numbering (counted forward from the Baptism of the Lord and backward from Christ the King), Advent, the Christmas season, and the fixed solemnities that displace a Sunday, like the Assumption and All Saints.

It's calculated rather than scraped because bible.usccb.org doesn't send the CORS headers a browser needs to let another website read its pages, and this site is just static files on GitHub Pages with no server to fetch on its behalf. Calculating avoids depending on a third-party proxy that could quietly stop working some Saturday night. The titles were checked against USCCB for 2026 and verified internally for consistency across 2024–2045, and every one is editable by hand anyway.

Two settings at the top of `liturgical.js` are worth knowing about:

- `ASCENSION_TRANSFERRED_TO_SUNDAY` is `false`, because the Diocese of Paterson is in the Province of Newark, which keeps Ascension on Thursday. Most of the US moves it to the Sunday. If this is ever reused by a parish elsewhere, flip that to `true`. (Note that bible.usccb.org shows the transferred version, so that one Sunday in May may look like a mismatch when you check the link — it isn't.)
- `EPIPHANY_ON_SUNDAY` is `true`, matching US practice.
