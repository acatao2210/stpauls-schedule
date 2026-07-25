// ---------------------------------------------------------------------------
// Shared site config. Both the public form (app.js) and the admin page
// (admin.js) read TARGET_MONTH from here, so they always agree on which
// month is "current" — update it in this one place, not two.
// ---------------------------------------------------------------------------

// Which month's Sundays the public form asks about. Update this by hand
// once a month (e.g. when August starts, change it to "2026-09" a week or
// so before the switch). Format: "YYYY-MM".
export const TARGET_MONTH = "2026-08";
