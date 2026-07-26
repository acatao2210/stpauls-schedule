// ---------------------------------------------------------------------------
// liturgical.js — works out the proper title of a Sunday ("Fifteenth Sunday
// in Ordinary Time", "Palm Sunday of the Passion of the Lord", etc.) purely
// by calculation, with no network call.
//
// Why calculated instead of scraped from USCCB: the admin page is a static
// file on GitHub Pages, and bible.usccb.org doesn't send the CORS headers a
// browser needs to let another site read its pages. Rather than depend on a
// third-party proxy that can disappear, the whole liturgical calendar is
// derived here from the date of Easter. Every title the admin page generates
// is still hand-editable before it's saved, and the admin page shows the
// matching USCCB link next to each week so you can eyeball it in one click.
//
// Scope note: this follows the General Roman Calendar as used in the dioceses
// of the United States. Two US-specific choices are configurable below, since
// they genuinely vary by ecclesiastical province.
// ---------------------------------------------------------------------------

// St. Paul's Inside the Walls is in the Diocese of Paterson, which is in the
// Ecclesiastical Province of Newark — one of the provinces that keeps
// Ascension on Thursday rather than moving it to the following Sunday. If
// this ever gets reused by a parish in a province that transfers it (most of
// the US), flip this to true and the Seventh Sunday of Easter becomes "The
// Ascension of the Lord".
const ASCENSION_TRANSFERRED_TO_SUNDAY = false;

// Epiphany and Corpus Christi are transferred to Sunday throughout the US.
const EPIPHANY_ON_SUNDAY = true;

const ORDINAL_WORDS = [
  "", "First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh",
  "Eighth", "Ninth", "Tenth", "Eleventh", "Twelfth", "Thirteenth",
  "Fourteenth", "Fifteenth", "Sixteenth", "Seventeenth", "Eighteenth",
  "Nineteenth", "Twentieth", "Twenty-first", "Twenty-second",
  "Twenty-third", "Twenty-fourth", "Twenty-fifth", "Twenty-sixth",
  "Twenty-seventh", "Twenty-eighth", "Twenty-ninth", "Thirtieth",
  "Thirty-first", "Thirty-second", "Thirty-third", "Thirty-fourth",
];

function ordinalWord(n) {
  return ORDINAL_WORDS[n] || `${n}th`;
}

// --- date helpers (all local-time, no UTC drift) ---------------------------

const MS_PER_DAY = 86400000;

export function isoDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseIsoDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, days) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function daysBetween(a, b) {
  // Whole days from a to b. Built from midnight-normalised copies so a DST
  // change in between can't shift the result by an hour and round wrong.
  const aa = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const bb = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bb - aa) / MS_PER_DAY);
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Every Sunday in a "YYYY-MM" month, in order. */
export function getSundaysInMonth(yearMonth) {
  const [year, month] = yearMonth.split("-").map(Number); // month is 1-12
  const dates = [];
  const d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) {
    if (d.getDay() === 0) dates.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

/** The USCCB daily-readings URL for a date — their IDs are MMDDYY. */
export function usccbUrl(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const code = `${pad(date.getMonth() + 1)}${pad(date.getDate())}${String(
    date.getFullYear()
  ).slice(2)}`;
  return `https://bible.usccb.org/bible/readings/${code}.cfm`;
}

// --- the liturgical year ---------------------------------------------------

/**
 * Gregorian Easter (Meeus/Jones/Butcher algorithm). Everything else in the
 * moveable calendar — Ash Wednesday, Pentecost, the length of Ordinary
 * Time — is measured from this one date.
 */
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

/**
 * First Sunday of Advent for the Advent that *begins* the liturgical year
 * ending in `year`+1 — i.e. the Advent falling in calendar `year`. It's the
 * fourth Sunday before Christmas.
 */
function firstSundayOfAdvent(year) {
  const christmas = new Date(year, 11, 25);
  // The Sunday *strictly* before Christmas is the Fourth Sunday of Advent;
  // step back three more weeks for the First. The `|| 7` matters in years
  // when Christmas itself falls on a Sunday (2033, 2039, …): that Sunday is
  // Christmas, not the Fourth Sunday of Advent, so we have to go back a full
  // week rather than zero days.
  const fourthSundayOfAdvent = addDays(christmas, -(christmas.getDay() || 7));
  return addDays(fourthSundayOfAdvent, -21);
}

/**
 * Epiphany in the US: the Sunday falling between Jan 2 and Jan 8.
 * (Where it isn't transferred, it's simply Jan 6.)
 */
function epiphany(year) {
  if (!EPIPHANY_ON_SUNDAY) return new Date(year, 0, 6);
  const jan2 = new Date(year, 0, 2);
  const offset = (7 - jan2.getDay()) % 7; // days forward to the next Sunday
  return addDays(jan2, offset);
}

/**
 * Baptism of the Lord — the Sunday after Epiphany, which closes the Christmas
 * season. Special case: when Epiphany lands on Jan 7 or Jan 8 there's no room
 * for a following Sunday, so it's kept on the Monday immediately after (and
 * therefore never falls on a Sunday that year).
 */
function baptismOfTheLord(year) {
  const epi = epiphany(year);
  if (epi.getDate() >= 7) return addDays(epi, 1); // the Monday
  return addDays(epi, 7 - epi.getDay() || 7);
}

/**
 * Solemnities and feasts on fixed dates that take precedence over a Sunday
 * in Ordinary Time when they land on one. Only ones that actually can
 * out-rank a Sunday are listed — e.g. the Immaculate Conception falls in
 * Advent and is transferred to Monday instead, so it never displaces a
 * Sunday and isn't here.
 */
const FIXED_SOLEMNITIES = {
  "01-01": "The Blessed Virgin Mary, the Mother of God",
  "02-02": "The Presentation of the Lord",
  "06-24": "The Nativity of Saint John the Baptist",
  "06-29": "Saints Peter and Paul, Apostles",
  "08-06": "The Transfiguration of the Lord",
  "08-15": "The Assumption of the Blessed Virgin Mary",
  "09-14": "The Exaltation of the Holy Cross",
  "11-01": "All Saints",
  "11-02": "The Commemoration of All the Faithful Departed (All Souls' Day)",
  "11-09": "The Dedication of the Lateran Basilica",
  "12-25": "The Nativity of the Lord (Christmas)",
};

function fixedSolemnityFor(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return FIXED_SOLEMNITIES[`${pad(date.getMonth() + 1)}-${pad(date.getDate())}`] || null;
}

// Liturgical color for each fixed-date solemnity above (see FIXED_SOLEMNITIES).
// White is the default festive color; the two martyrs' days are red, and All
// Souls' Day is purple (its historical color, alongside black — white is also
// permitted in the US but purple reads as the more traditional "day of the
// dead" choice for a simple four-color scheme).
const FIXED_SOLEMNITY_COLORS = {
  "01-01": "white",
  "02-02": "white",
  "06-24": "white",
  "06-29": "red",
  "08-06": "white",
  "08-15": "white",
  "09-14": "red",
  "11-01": "white",
  "11-02": "purple",
  "11-09": "white",
  "12-25": "white",
};

function fixedSolemnityColorFor(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return FIXED_SOLEMNITY_COLORS[`${pad(date.getMonth() + 1)}-${pad(date.getDate())}`] || null;
}

/**
 * The liturgical color for a given date, following the same season logic as
 * liturgicalTitle() above (kept as a separate function rather than folded
 * into it so existing stored titles/behavior can't change; the two should
 * stay in sync if this file's season logic ever changes).
 *
 * Simplified to the four colors that matter for a weekly schedule display —
 * no rose (Gaudete/Laetare Sundays are shown as purple, their season's
 * primary color) and no black (All Souls' Day is shown as purple).
 *
 * @param {Date} date - any date; only meaningful for Sundays and the fixed
 *   solemnities/custom days this site tracks.
 * @returns {"green"|"purple"|"white"|"red"}
 */
export function liturgicalColor(date) {
  const year = date.getFullYear();
  const easter = easterSunday(year);
  const fromEaster = daysBetween(easter, date);

  // --- Lent, Holy Week, Easter season (mirrors liturgicalTitle) -----------
  if (fromEaster === 0) return "white"; // Easter Sunday
  if (fromEaster === -7) return "red"; // Palm Sunday

  if (fromEaster >= -42 && fromEaster <= -14) {
    const week = (fromEaster + 49) / 7;
    if (Number.isInteger(week) && week >= 1 && week <= 5) return "purple"; // Lent
  }

  if (fromEaster === 7) return "white"; // Second Sunday of Easter
  if (fromEaster >= 14 && fromEaster <= 42) {
    const week = fromEaster / 7 + 1;
    if (Number.isInteger(week) && week >= 3 && week <= 7) return "white"; // Easter season
  }

  if (fromEaster === 49) return "red"; // Pentecost
  if (fromEaster === 56) return "white"; // Trinity Sunday
  if (fromEaster === 63) return "white"; // Corpus Christi

  // --- Advent ---------------------------------------------------------------
  const advent1 = firstSundayOfAdvent(year);
  if (date >= advent1 && date < new Date(year, 11, 25)) {
    const week = daysBetween(advent1, date) / 7 + 1;
    if (Number.isInteger(week) && week >= 1 && week <= 4) return "purple";
  }

  // --- Christmas season -------------------------------------------------------
  if (date.getMonth() === 11 && date.getDate() >= 25) return "white"; // Christmas Day, Holy Family
  if (date.getMonth() === 0 && date.getDate() === 1) return "white"; // Mary, Mother of God
  const epi = epiphany(year);
  if (sameDay(date, epi)) return "white";
  const baptism = baptismOfTheLord(year);
  if (sameDay(date, baptism)) return "white";
  if (date.getMonth() === 0 && date < epi) return "white"; // Second Sunday after the Nativity

  // --- Fixed solemnities ------------------------------------------------------
  const fixedColor = fixedSolemnityColorFor(date);
  if (fixedColor) return fixedColor;

  // --- Everything else is Ordinary Time ---------------------------------------
  return "green";
}

/**
 * The proper title of a given Sunday.
 *
 * Order of precedence, highest first: the Paschal Triduum and Easter/Christmas
 * seasons (which are never displaced), then Lent and Advent, then fixed
 * solemnities, then the ordinary Sunday-in-Ordinary-Time count.
 *
 * @param {Date} date - any date; only meaningful for Sundays.
 * @returns {string} e.g. "Fifteenth Sunday in Ordinary Time"
 */
export function liturgicalTitle(date) {
  const year = date.getFullYear();
  const easter = easterSunday(year);
  const fromEaster = daysBetween(easter, date); // negative = before Easter

  // --- Lent, Holy Week, Easter season (all measured off Easter) -----------
  if (fromEaster === 0) return "Easter Sunday of the Resurrection of the Lord";
  if (fromEaster === -7) return "Palm Sunday of the Passion of the Lord";

  if (fromEaster >= -42 && fromEaster <= -14) {
    // -42 = First Sunday of Lent, stepping forward a week at a time.
    const week = (fromEaster + 49) / 7;
    if (Number.isInteger(week) && week >= 1 && week <= 5) {
      return `${ordinalWord(week)} Sunday of Lent`;
    }
  }

  if (fromEaster === 7) return "Second Sunday of Easter (or Sunday of Divine Mercy)";
  if (fromEaster >= 14 && fromEaster <= 42) {
    const week = fromEaster / 7 + 1;
    if (Number.isInteger(week) && week >= 3 && week <= 7) {
      if (week === 7 && ASCENSION_TRANSFERRED_TO_SUNDAY) {
        return "The Ascension of the Lord";
      }
      return `${ordinalWord(week)} Sunday of Easter`;
    }
  }

  if (fromEaster === 49) return "Pentecost Sunday";
  if (fromEaster === 56) return "The Most Holy Trinity";
  if (fromEaster === 63) return "The Most Holy Body and Blood of Christ (Corpus Christi)";

  // --- Advent -------------------------------------------------------------
  const advent1 = firstSundayOfAdvent(year);
  if (date >= advent1 && date < new Date(year, 11, 25)) {
    const week = daysBetween(advent1, date) / 7 + 1;
    if (Number.isInteger(week) && week >= 1 && week <= 4) {
      return `${ordinalWord(week)} Sunday of Advent`;
    }
  }

  // --- Christmas season ---------------------------------------------------
  // Dec 26-31: the Sunday in the Octave is the Holy Family.
  if (date.getMonth() === 11 && date.getDate() >= 26) {
    return "The Holy Family of Jesus, Mary and Joseph";
  }
  // Jan 1 is Mary, Mother of God (caught by the fixed table below, but it
  // has to beat the Christmas-season checks, so handle it first).
  if (date.getMonth() === 0 && date.getDate() === 1) {
    return FIXED_SOLEMNITIES["01-01"];
  }
  const epi = epiphany(year);
  if (sameDay(date, epi)) return "The Epiphany of the Lord";
  const baptism = baptismOfTheLord(year);
  if (sameDay(date, baptism)) return "The Baptism of the Lord";
  // A Sunday in early January that is neither Epiphany nor the Baptism
  // (possible when Epiphany falls on Jan 2) is the Second Sunday after
  // the Nativity.
  if (date.getMonth() === 0 && date < epi) {
    return "The Second Sunday after the Nativity";
  }

  // --- Fixed solemnities that outrank a Sunday in Ordinary Time -----------
  const fixed = fixedSolemnityFor(date);
  if (fixed) return fixed;

  // --- Ordinary Time ------------------------------------------------------
  // Two stretches. The first runs from the day after the Baptism of the Lord
  // to Ash Wednesday: the Sunday after the Baptism is the Second Sunday in
  // Ordinary Time, and it counts up from there.
  //
  // The count is anchored to a Sunday. Usually that's the Baptism itself,
  // but when Epiphany lands on Jan 7 or 8 the Baptism is pushed to the
  // following Monday — in that case the anchor is the Epiphany Sunday just
  // before it, so the next Sunday still comes out as the Second Sunday in
  // Ordinary Time.
  const otAnchorSunday = baptism.getDay() === 0 ? baptism : addDays(baptism, -1);
  if (date > otAnchorSunday && date < addDays(easter, -46)) {
    const week = daysBetween(otAnchorSunday, date) / 7 + 1;
    if (Number.isInteger(week)) return `${ordinalWord(week)} Sunday in Ordinary Time`;
  }

  // The second stretch runs from after Pentecost to the Saturday before
  // Advent. Rather than counting forward (the stretch's length varies with
  // Easter), count *backward* from the last Sunday of the year — Christ the
  // King, always the Thirty-fourth Sunday, always the Sunday before Advent.
  const christTheKing = addDays(advent1, -7);
  if (date > addDays(easter, 49) && date <= christTheKing) {
    const weeksBack = daysBetween(date, christTheKing) / 7;
    const week = 34 - weeksBack;
    if (Number.isInteger(week) && week >= 1 && week <= 34) {
      if (week === 34) return "Our Lord Jesus Christ, King of the Universe";
      return `${ordinalWord(week)} Sunday in Ordinary Time`;
    }
  }

  // Shouldn't be reachable for a Sunday, but never return nothing — the
  // admin can always type over whatever lands in the field.
  return "";
}

/**
 * Build the week rows for a month: every Sunday, with its computed title and
 * the USCCB link to check it against.
 */
export function buildWeeksForMonth(yearMonth) {
  return getSundaysInMonth(yearMonth).map((d) => ({
    date: isoDate(d),
    label: d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
    title: liturgicalTitle(d),
    usccbUrl: usccbUrl(d),
  }));
}
