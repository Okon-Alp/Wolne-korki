// Strefy czasowe bez bibliotek: tylko Intl.
const fmtCache = new Map();

function partsFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    }));
  }
  return fmtCache.get(tz);
}

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Rozkłada chwilę (ms UTC) na lokalne pola w danej strefie. */
export function zonedParts(utcMs, tz) {
  const p = {};
  for (const { type, value } of partsFormatter(tz).formatToParts(new Date(utcMs))) p[type] = value;
  return {
    y: +p.year, m: +p.month, d: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second,
    weekday: WEEKDAYS[p.weekday],
    minutes: +p.hour * 60 + +p.minute,
  };
}

function offsetMin(utcMs, tz) {
  const z = zonedParts(utcMs, tz);
  const asUtc = Date.UTC(z.y, z.m - 1, z.d, z.hour, z.minute, z.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** Lokalna data (y, m 1-12, d) + minuty od północy w strefie tz -> ms UTC. */
export function zonedToUtc(y, m, d, minutes, tz) {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const off1 = offsetMin(guess - offsetMin(guess, tz) * 60000, tz);
  return guess - off1 * 60000;
}

/** 'YYYY-MM-DD' -> {y, m, d}; rzuca błąd przy złym formacie. */
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) throw Object.assign(new Error('Zła data'), { status: 400 });
  return { y: +m[1], m: +m[2], d: +m[3] };
}

/** 'HH:MM' -> minuty od północy. */
export function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m || +m[1] > 24 || +m[2] > 59) throw Object.assign(new Error('Zła godzina'), { status: 400 });
  return +m[1] * 60 + +m[2];
}

export function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function isoWeekday({ y, m, d }) {
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

export function dateKey({ y, m, d }) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
