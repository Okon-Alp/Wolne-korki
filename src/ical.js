// Kanał kalendarza .ics (subskrypcja w Google Calendar, Apple, Thunderbird).
import { getSettings } from './db.js';

const fmt = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// Znaki nowej linii (także samotne CR) i inne sterujące nie mogą rozbić wiersza .ics na nowe pola.
const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
  .replace(/\r\n|\r|\n/g, '\\n').replace(/[\u0000-\u001f\u007f]/g, '');

function fold(line) {
  // Linie .ics mają max 75 oktetów; dzielimy bezpiecznie po znakach.
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

export function icalHandler(db, publicUrl) {
  return (req, res) => {
    const token = String(req.params.token || '').replace(/\.ics$/, '');
    const user = token && db.prepare('SELECT id, role FROM users WHERE ical_token = ?').get(token);
    if (!user) return res.status(404).send('Nie znaleziono kalendarza.');
    const s = getSettings(db);
    const since = Date.now() - 60 * 86400000;
    const rows = user.role === 'tutor'
      ? db.prepare(
        `SELECT l.*, s.name AS student_name FROM lessons l JOIN students s ON s.id = l.student_id
         WHERE l.end_at > ? ORDER BY l.start_at`).all(since)
      : db.prepare(
        `SELECT l.*, s.name AS student_name FROM lessons l JOIN students s ON s.id = l.student_id
         WHERE s.client_id = ? AND l.end_at > ? ORDER BY l.start_at`).all(user.id, since);
    const base = publicUrl || `${req.protocol}://${req.host}`;
    const host = new URL(base).host;
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Wolne Korki//PL', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${esc(s.school_name)}`, 'X-PUBLISHED-TTL:PT1H',
    ];
    for (const l of rows) {
      const title = user.role === 'tutor' ? `Lekcja: ${l.student_name}` : `${s.school_name}: ${l.student_name}`;
      lines.push(
        'BEGIN:VEVENT',
        `UID:lesson-${l.id}@${host}`,
        `DTSTAMP:${fmt(Date.now())}`,
        `DTSTART:${fmt(l.start_at)}`,
        `DTEND:${fmt(l.end_at)}`,
        `SUMMARY:${esc(title + (l.topic ? ` (${l.topic})` : ''))}`,
        `STATUS:${l.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
        `URL:${base}/#/lekcja/${l.id}`,
        `LOCATION:${esc(l.mode === 'onsite' ? l.location || 'stacjonarnie' : 'online')}`,
        'END:VEVENT'
      );
    }
    lines.push('END:VCALENDAR');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(lines.map(fold).join('\r\n') + '\r\n');
  };
}
