// Wolne terminy liczone z dostępności, urlopów i istniejących lekcji.
import { addDays, isoWeekday, zonedToUtc, zonedParts, dateKey, parseDate } from './time.js';

const DAY = 86400000;

/**
 * Zwraca wolne terminy [{start, end}] (ms UTC) dla dni od fromDate do toDate włącznie
 * (daty lokalne 'YYYY-MM-DD' w strefie korepetytora).
 */
export function freeSlots(db, settings, { fromDate, toDate, minutes, now = Date.now(), ignoreNotice = false }) {
  const tz = settings.timezone;
  const step = Math.max(5, settings.slot_step | 0);
  const buffer = Math.max(0, settings.buffer_min | 0) * 60000;
  const len = minutes * 60000;

  const from = parseDate(fromDate);
  const to = parseDate(toDate);
  const rangeStart = zonedToUtc(from.y, from.m, from.d, 0, tz) - DAY;
  const rangeEnd = zonedToUtc(to.y, to.m, to.d, 1440, tz) + DAY;

  const rules = db.prepare('SELECT weekday, start_min, end_min FROM availability ORDER BY weekday, start_min').all();
  const busy = db.prepare(
    "SELECT start_at, end_at FROM lessons WHERE status = 'scheduled' AND end_at > ? AND start_at < ?"
  ).all(rangeStart, rangeEnd);
  const off = db.prepare('SELECT start_at, end_at FROM time_off WHERE end_at > ? AND start_at < ?').all(rangeStart, rangeEnd);

  const earliest = ignoreNotice ? now : now + settings.min_notice_hours * 3600000;
  const latest = now + settings.horizon_days * DAY;

  const out = new Map();
  let day = from;
  for (let guard = 0; guard < 400 && dateKey(day) <= dateKey(to); guard++, day = addDays(day, 1)) {
    const wd = isoWeekday(day);
    for (const r of rules) {
      if (r.weekday !== wd) continue;
      for (let t = r.start_min; t + minutes <= r.end_min; t += step) {
        const start = zonedToUtc(day.y, day.m, day.d, t, tz);
        const end = start + len;
        if (start < earliest || start > latest) continue;
        if (busy.some((b) => b.start_at < end + buffer && b.end_at + buffer > start)) continue;
        if (off.some((o) => o.start_at < end && o.end_at > start)) continue;
        out.set(start, { start, end });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}

/** Czy dany początek lekcji jest wolnym terminem według dostępności? */
export function isFreeSlot(db, settings, start, minutes, now = Date.now()) {
  const z = zonedParts(start, settings.timezone);
  const key = dateKey(z);
  return freeSlots(db, settings, { fromDate: key, toDate: key, minutes, now }).some((s) => s.start === start);
}
