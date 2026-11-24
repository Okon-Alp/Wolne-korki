// REST API aplikacji.
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, saveSettings, tx, DEFAULT_SETTINGS } from './db.js';
import {
  hashPassword, verifyPassword, validatePassword, randomToken, createSession, destroySession,
  userFromRequest, makeRateLimiter, needsRehash, DUMMY_HASH,
} from './auth.js';
import { freeSlots, isFreeSlot } from './slots.js';
import { zonedToUtc, zonedParts, parseDate, parseTime, addDays } from './time.js';

const INVITE_DAYS = 14;
const SAFE_INLINE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Tekst jednowierszowy: znaki sterujące (w tym CR/LF) zamieniamy na spacje. Chroni m.in. kalendarz .ics i nagłówki.
const str = (v, max = 500) => (v == null ? null : String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) || null);
// Tekst wielowierszowy: zostają tylko \n i tabulatory.
const text = (v, max = 20000) => (v == null ? null : String(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) || null);
const int = (v) => (v === '' || v == null ? null : Number.isFinite(+v) ? Math.round(+v) : null);
const money = (v) => { const n = int(v); return n == null ? null : Math.max(0, n); };

/** Parametr z adresu tylko jako napis (?a=1&a=2 daje tablicę, którą odrzucamy). */
const qs = (req, key) => (typeof req.query[key] === 'string' ? req.query[key] : undefined);

/** E-mail: limit długości przed wyrażeniem regularnym, a samo wyrażenie bez kosztownego cofania się. */
const isEmail = (v) => typeof v === 'string' && v.length <= 200 && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(v);

/** Limity zapytań (na adres IP). */
const limiter = (windowMs, limit, error, extra = {}) => rateLimit({
  windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error }, ...extra,
});

export function createApi({ db, dataDir, setupCode, publicUrl, maxUploadMb = 25, clientStorageMb = 100 }) {
  const api = express.Router();
  const loginLimiter = makeRateLimiter(10, 15 * 60000);   // nieudane logowania na parę IP + e-mail
  const ipLimiter = makeRateLimiter(30, 15 * 60000);      // nieudane logowania na samo IP
  const apiLimit = limiter(60000, 300, 'Za dużo zapytań. Odczekaj chwilę.');
  const authLimit = limiter(15 * 60000, 30, 'Za dużo nieudanych prób. Spróbuj ponownie za kwadrans.', { skipSuccessfulRequests: true });
  const uploadLimit = limiter(60000, 30, 'Za dużo wgrywanych plików naraz. Odczekaj chwilę.');
  const fileLimit = limiter(60000, 120, 'Za dużo pobrań naraz. Odczekaj chwilę.');
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const secure = (req) => req.secure;
  const baseUrl = (req) => publicUrl || `${req.protocol}://${req.host}`;

  // ---------- dostęp ----------

  api.use(apiLimit);
  // Odpowiedzi API zawierają dane osobowe: żadnego zapisywania w pamięci podręcznej po drodze.
  api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use((req, res, next) => {
    req.user = userFromRequest(db, req);
    next();
  });
  const auth = (req, res, next) => (req.user ? next() : next(httpError(401, 'Zaloguj się.')));
  const tutor = (req, res, next) =>
    req.user?.role === 'tutor' ? next() : next(httpError(req.user ? 403 : 401, 'Tylko dla korepetytora.'));

  function studentFor(user, id) {
    const st = db.prepare('SELECT * FROM students WHERE id = ?').get(int(id));
    if (!st || (user.role !== 'tutor' && st.client_id !== user.id)) throw httpError(404, 'Nie znaleziono ucznia.');
    return st;
  }

  function lessonFor(user, id) {
    const l = db.prepare(
      `SELECT l.*, s.name AS student_name, s.client_id, u.name AS client_name
       FROM lessons l JOIN students s ON s.id = l.student_id JOIN users u ON u.id = s.client_id
       WHERE l.id = ?`
    ).get(int(id));
    if (!l || (user.role !== 'tutor' && l.client_id !== user.id)) throw httpError(404, 'Nie znaleziono lekcji.');
    return l;
  }

  function publicLesson(l, user) {
    const out = { ...l };
    delete out.whiteboard;
    if (user.role !== 'tutor') delete out.tutor_notes;
    out.paid = !!out.paid;
    out.late_cancel = !!out.late_cancel;
    return out;
  }

  function priceFor(student, minutes, settings) {
    if (student.hourly_price != null) return Math.round((student.hourly_price * minutes) / 60);
    const d = settings.durations.find((x) => x.minutes === minutes);
    if (d) return d.price;
    const base = settings.durations[0] || { minutes: 60, price: 0 };
    return Math.round((base.price * minutes) / base.minutes);
  }

  function clientSettings(s) {
    const keys = ['school_name', 'timezone', 'durations', 'cancel_hours', 'late_cancel_fee_pct',
      'allow_client_booking', 'allow_client_cancel', 'payment_info', 'rules_text', 'countdowns',
      'external_meeting_url', 'min_notice_hours', 'horizon_days'];
    return Object.fromEntries(keys.map((k) => [k, s[k]]));
  }

  /** Należności klienta: do zapłaty (odbyte + późno odwołane), zaplanowane nieopłacone, nadpłaty. */
  function dues(clientId, now = Date.now()) {
    const rows = db.prepare(
      `SELECT l.status, l.end_at, l.price, l.paid, l.late_cancel FROM lessons l
       JOIN students s ON s.id = l.student_id WHERE s.client_id = ?`
    ).all(clientId);
    let due = 0, dueCount = 0, upcoming = 0, credit = 0;
    for (const l of rows) {
      const counts = (l.status === 'scheduled' && l.end_at <= now) || (l.status === 'cancelled' && l.late_cancel);
      if (counts && !l.paid) { due += l.price; dueCount++; }
      if (l.status === 'scheduled' && l.end_at > now && !l.paid) upcoming += l.price;
      if (l.status === 'cancelled' && !l.late_cancel && l.paid) credit += l.price;
    }
    return { due, due_count: dueCount, upcoming_unpaid: upcoming, credit };
  }

  // ---------- konfiguracja i logowanie ----------

  const tutorExists = () => !!db.prepare("SELECT 1 FROM users WHERE role = 'tutor'").get();

  api.get('/status', (req, res) => {
    res.json({ setup_needed: !tutorExists(), school_name: getSettings(db).school_name });
  });

  api.post('/setup', authLimit, (req, res) => {
    if (tutorExists()) throw httpError(409, 'Aplikacja jest już skonfigurowana.');
    const { code, name, email, password, school_name } = req.body || {};
    if (String(code || '').trim() !== setupCode()) throw httpError(403, 'Zły kod konfiguracji. Znajdziesz go w logach serwera.');
    const err = validatePassword(password);
    if (err) throw httpError(400, err);
    if (!str(name) || !isEmail(email)) throw httpError(400, 'Podaj imię i poprawny e-mail.');
    const passHash = hashPassword(password);
    const r = tx(db, () => {
      if (tutorExists()) throw httpError(409, 'Aplikacja jest już skonfigurowana.');
      return db.prepare(
        "INSERT INTO users (role, name, email, pass_hash, ical_token, created_at) VALUES ('tutor', ?, ?, ?, ?, ?)"
      ).run(str(name, 100), str(email, 200), passHash, randomToken(24), Date.now());
    });
    if (str(school_name)) saveSettings(db, { school_name: str(school_name, 100) });
    createSession(db, res, r.lastInsertRowid, secure(req));
    res.json({ ok: true });
  });

  api.post('/login', authLimit, (req, res) => {
    const { email, password } = req.body || {};
    const key = `${req.ip}|${String(email || '').toLowerCase()}`;
    if (loginLimiter.blocked(key) || ipLimiter.blocked(req.ip)) {
      throw httpError(429, 'Za dużo nieudanych prób. Spróbuj ponownie za kwadrans.');
    }
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().slice(0, 200));
    // Hasło sprawdzamy zawsze (gdy konta nie ma: na losowym hashu), żeby czas odpowiedzi był taki sam.
    const passOk = verifyPassword(password || '', u?.pass_hash || DUMMY_HASH);
    if (!u || !u.pass_hash || !passOk) {
      loginLimiter.fail(key);
      ipLimiter.fail(req.ip);
      throw httpError(401, 'Zły e-mail albo hasło.');
    }
    loginLimiter.clear(key);
    if (needsRehash(u.pass_hash)) db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
    createSession(db, res, u.id, secure(req));
    res.json({ ok: true });
  });

  api.post('/logout', (req, res) => {
    destroySession(db, req, res, secure(req));
    res.json({ ok: true });
  });

  function inviteUser(token) {
    const u = db.prepare('SELECT * FROM users WHERE invite_token = ?').get(String(token || ''));
    if (!u || u.invite_expires < Date.now()) throw httpError(404, 'Link wygasł albo jest nieprawidłowy. Poproś o nowy.');
    return u;
  }

  api.get('/invite/:token', (req, res) => {
    const u = inviteUser(req.params.token);
    const s = getSettings(db);
    res.json({ name: u.name, email: u.email, is_reset: !!u.pass_hash, school_name: s.school_name, rules_text: s.rules_text });
  });

  api.post('/invite/:token', authLimit, (req, res) => {
    const u = inviteUser(req.params.token);
    const { email, password } = req.body || {};
    const err = validatePassword(password);
    if (err) throw httpError(400, err);
    const mail = str(email, 200) || u.email;
    if (!isEmail(mail)) throw httpError(400, 'Podaj poprawny e-mail.');
    const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(mail, u.id);
    if (taken) throw httpError(409, 'Ten e-mail jest już używany.');
    db.prepare(
      'UPDATE users SET email = ?, pass_hash = ?, invite_token = NULL, invite_expires = NULL, ical_token = COALESCE(ical_token, ?) WHERE id = ?'
    ).run(mail, hashPassword(password), randomToken(24), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    createSession(db, res, u.id, secure(req));
    res.json({ ok: true });
  });

  // ---------- konto ----------

  api.get('/me', (req, res) => {
    if (!req.user) return res.json({ user: null });
    const s = getSettings(db);
    const me = db.prepare('SELECT id, role, name, email, phone, ical_token FROM users WHERE id = ?').get(req.user.id);
    const out = { user: { ...me }, settings: req.user.role === 'tutor' ? s : clientSettings(s), ical_url: `${baseUrl(req)}/ical/${me.ical_token}.ics` };
    if (req.user.role === 'client') {
      out.students = db.prepare('SELECT id, name, level, subject, hourly_price FROM students WHERE client_id = ? AND active = 1 ORDER BY name').all(req.user.id)
        .map((st) => ({ ...st, prices: s.durations.map((d) => ({ minutes: d.minutes, price: priceFor(st, d.minutes, s) })) }));
      out.dues = dues(req.user.id);
    }
    res.json(out);
  });

  api.post('/me/password', authLimit, auth, (req, res) => {
    const { current, next: pw } = req.body || {};
    const u = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(current || '', u.pass_hash)) throw httpError(400, 'Obecne hasło się nie zgadza.');
    const err = validatePassword(pw);
    if (err) throw httpError(400, err);
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(pw), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
    createSession(db, res, req.user.id, secure(req));
    res.json({ ok: true });
  });

  api.post('/me/ical-reset', auth, (req, res) => {
    const t = randomToken(24);
    db.prepare('UPDATE users SET ical_token = ? WHERE id = ?').run(t, req.user.id);
    res.json({ ical_url: `${baseUrl(req)}/ical/${t}.ics` });
  });

  // ---------- terminy i lekcje ----------

  api.get('/slots', auth, (req, res) => {
    const s = getSettings(db);
    if (req.user.role !== 'tutor' && !s.allow_client_booking) throw httpError(403, 'Rezerwacje są wyłączone.');
    const minutes = int(qs(req, 'minutes')) || s.durations[0]?.minutes || 60;
    if (minutes < 15 || minutes > 600) throw httpError(400, 'Zła długość lekcji.');
    const from = parseDate(qs(req, 'from'));
    const to = parseDate(qs(req, 'to') || qs(req, 'from'));
    if (Date.UTC(to.y, to.m - 1, to.d) - Date.UTC(from.y, from.m - 1, from.d) > 42 * 86400000) throw httpError(400, 'Za długi zakres.');
    res.json({ slots: freeSlots(db, s, { fromDate: qs(req, 'from'), toDate: qs(req, 'to') || qs(req, 'from'), minutes }) });
  });

  api.get('/lessons', auth, (req, res) => {
    const from = int(qs(req, 'from')) ?? Date.now() - 30 * 86400000;
    const to = int(qs(req, 'to')) ?? Date.now() + 90 * 86400000;
    const params = [from, to];
    let where = 'l.end_at > ? AND l.start_at < ?';
    if (req.user.role !== 'tutor') { where += ' AND s.client_id = ?'; params.push(req.user.id); }
    if (qs(req, 'student_id')) { where += ' AND l.student_id = ?'; params.push(int(qs(req, 'student_id'))); }
    if (qs(req, 'client_id') && req.user.role === 'tutor') { where += ' AND s.client_id = ?'; params.push(int(qs(req, 'client_id'))); }
    if (qs(req, 'status')) { where += ' AND l.status = ?'; params.push(qs(req, 'status')); }
    const rows = db.prepare(
      `SELECT l.*, s.name AS student_name, s.client_id, u.name AS client_name
       FROM lessons l JOIN students s ON s.id = l.student_id JOIN users u ON u.id = s.client_id
       WHERE ${where} ORDER BY l.start_at ${qs(req, 'order') === 'desc' ? 'DESC' : 'ASC'} LIMIT 500`
    ).all(...params);
    res.json({ lessons: rows.map((l) => publicLesson(l, req.user)) });
  });

  api.get('/lessons/:id', auth, (req, res) => {
    const l = lessonFor(req.user, req.params.id);
    const materials = db.prepare('SELECT id, title, body, file_name, mime, size, uploaded_by, created_at FROM materials WHERE lesson_id = ? ORDER BY created_at').all(l.id);
    const s = getSettings(db);
    res.json({
      lesson: publicLesson(l, req.user),
      materials,
      cancel: cancelInfo(l, req.user, s),
    });
  });

  function cancelInfo(l, user, s, now = Date.now()) {
    if (l.status !== 'scheduled') return { allowed: false };
    if (user.role === 'tutor') return { allowed: true, late: false, fee: 0 };
    if (!s.allow_client_cancel || l.start_at <= now) return { allowed: false };
    const late = l.start_at - now < s.cancel_hours * 3600000;
    return { allowed: true, late, fee: late ? Math.round((l.price * s.late_cancel_fee_pct) / 100) : 0 };
  }

  api.post('/lessons', auth, (req, res) => {
    const s = getSettings(db);
    const b = req.body || {};
    const student = studentFor(req.user, b.student_id);
    if (!student.active) throw httpError(400, 'Ten uczeń jest nieaktywny.');

    if (req.user.role !== 'tutor') {
      // Rezerwacja przez rodzica/ucznia: tylko wolne terminy z dostępności.
      if (!s.allow_client_booking) throw httpError(403, 'Rezerwacje są wyłączone.');
      const minutes = int(b.minutes);
      if (!s.durations.some((d) => d.minutes === minutes)) throw httpError(400, 'Niedostępna długość lekcji.');
      const start = int(b.start);
      const id = tx(db, () => {
        if (s.max_client_bookings) {
          const n = db.prepare(
            `SELECT COUNT(*) AS n FROM lessons l JOIN students st ON st.id = l.student_id
             WHERE st.client_id = ? AND l.created_by = ? AND l.status = 'scheduled' AND l.start_at > ?`
          ).get(req.user.id, req.user.id, Date.now()).n;
          if (n >= s.max_client_bookings) throw httpError(409, `Masz już ${n} zaplanowanych rezerwacji. Kolejne zarezerwujesz po odbyciu którejś z nich albo przez korepetytora.`);
        }
        if (!isFreeSlot(db, s, start, minutes)) throw httpError(409, 'Ten termin jest już zajęty. Wybierz inny.');
        return db.prepare(
          `INSERT INTO lessons (student_id, start_at, end_at, topic, price, mode, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, 'online', ?, ?)`
        ).run(student.id, start, start + minutes * 60000, str(b.topic, 300), priceFor(student, minutes, s), req.user.id, Date.now()).lastInsertRowid;
      });
      return res.status(201).json({ created: [id], conflicts: [] });
    }

    // Korepetytor: dowolny termin (poza kolizjami), opcjonalnie co tydzień.
    const minutes = int(b.minutes) || 60;
    if (minutes < 15 || minutes > 600) throw httpError(400, 'Zła długość lekcji.');
    const date = parseDate(b.date);
    const t = parseTime(b.time);
    const weeks = Math.min(52, Math.max(1, int(b.repeat_weeks) || 1));
    const price = b.price != null && b.price !== '' ? Math.max(0, int(b.price)) : priceFor(student, minutes, s);
    const mode = b.mode === 'onsite' ? 'onsite' : 'online';
    const created = [];
    const conflicts = [];
    for (let i = 0; i < weeks; i++) {
      const d = addDays(date, 7 * i);
      const start = zonedToUtc(d.y, d.m, d.d, t, s.timezone);
      try {
        created.push(db.prepare(
          `INSERT INTO lessons (student_id, start_at, end_at, topic, price, mode, location, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(student.id, start, start + minutes * 60000, str(b.topic, 300), price, mode, str(b.location, 300), req.user.id, Date.now()).lastInsertRowid);
      } catch (e) {
        if (/SLOT_TAKEN/.test(e.message)) conflicts.push(start); else throw e;
      }
    }
    if (!created.length) throw httpError(409, 'Ten termin koliduje z inną lekcją.');
    res.status(201).json({ created, conflicts });
  });

  api.post('/lessons/:id/cancel', auth, (req, res) => {
    const s = getSettings(db);
    const result = tx(db, () => {
      const l = lessonFor(req.user, req.params.id);
      const info = cancelInfo(l, req.user, s);
      if (!info.allowed) throw httpError(400, 'Tej lekcji nie można już odwołać.');
      const price = info.late ? info.fee : l.price;
      db.prepare(
        `UPDATE lessons SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, late_cancel = ?, price = ? WHERE id = ?`
      ).run(Date.now(), req.user.id, info.late ? 1 : 0, price, l.id);
      return info;
    });
    res.json({ ok: true, late: result.late, fee: result.fee });
  });

  api.patch('/lessons/:id', tutor, (req, res) => {
    const l = lessonFor(req.user, req.params.id);
    const b = req.body || {};
    const s = getSettings(db);
    const sets = [];
    const vals = [];
    const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
    for (const k of ['topic', 'location']) if (k in b) set(k, str(b[k], 300));
    for (const k of ['summary', 'homework', 'tutor_notes']) if (k in b) set(k, text(b[k], 20000));
    if ('mode' in b) set('mode', b.mode === 'onsite' ? 'onsite' : 'online');
    if ('price' in b) set('price', Math.max(0, int(b.price) || 0));
    if ('paid' in b) { set('paid', b.paid ? 1 : 0); set('paid_at', b.paid ? Date.now() : null); }
    if ('date' in b || 'time' in b || 'minutes' in b) {
      const cur = zonedParts(l.start_at, s.timezone);
      const d = 'date' in b ? parseDate(b.date) : cur;
      const t = 'time' in b ? parseTime(b.time) : cur.minutes;
      const minutes = int(b.minutes) || Math.round((l.end_at - l.start_at) / 60000);
      const start = zonedToUtc(d.y, d.m, d.d, t, s.timezone);
      set('start_at', start);
      set('end_at', start + minutes * 60000);
    }
    if ('restore' in b && b.restore && l.status === 'cancelled') { set('status', 'scheduled'); set('late_cancel', 0); }
    if (!sets.length) return res.json({ ok: true });
    db.prepare(`UPDATE lessons SET ${sets.join(', ')} WHERE id = ?`).run(...vals, l.id);
    res.json({ ok: true });
  });

  api.delete('/lessons/:id', tutor, (req, res) => {
    const l = lessonFor(req.user, req.params.id);
    removeMaterialFiles(db.prepare('SELECT file_path FROM materials WHERE lesson_id = ?').all(l.id));
    db.prepare('DELETE FROM materials WHERE lesson_id = ?').run(l.id);
    db.prepare('DELETE FROM lessons WHERE id = ?').run(l.id);
    res.json({ ok: true });
  });

  api.get('/lessons/:id/chat', auth, (req, res) => {
    const l = lessonFor(req.user, req.params.id);
    res.json({
      messages: db.prepare(
        'SELECT c.id, c.body, c.at, c.user_id, u.name FROM chat c LEFT JOIN users u ON u.id = c.user_id WHERE lesson_id = ? ORDER BY c.id'
      ).all(l.id),
    });
  });

  // ---------- materiały ----------

  api.get('/materials', auth, (req, res) => {
    const params = [];
    let where = '1 = 1';
    if (req.user.role !== 'tutor') { where += ' AND s.client_id = ?'; params.push(req.user.id); }
    if (qs(req, 'student_id')) { where += ' AND m.student_id = ?'; params.push(int(qs(req, 'student_id'))); }
    const rows = db.prepare(
      `SELECT m.id, m.student_id, m.lesson_id, m.title, m.body, m.file_name, m.mime, m.size, m.uploaded_by, m.created_at,
              s.name AS student_name, l.start_at AS lesson_start
       FROM materials m JOIN students s ON s.id = m.student_id LEFT JOIN lessons l ON l.id = m.lesson_id
       WHERE ${where} ORDER BY m.created_at DESC LIMIT 300`
    ).all(...params);
    res.json({ materials: rows });
  });

  function materialTarget(req, b) {
    let studentId = int(b.student_id);
    let lessonId = int(b.lesson_id);
    if (lessonId) {
      const l = lessonFor(req.user, lessonId);
      studentId = l.student_id;
    } else {
      studentFor(req.user, studentId);
    }
    return { studentId, lessonId: lessonId || null };
  }

  api.post('/materials', auth, (req, res) => {
    const b = req.body || {};
    const { studentId, lessonId } = materialTarget(req, b);
    const title = str(b.title, 200);
    if (!title) throw httpError(400, 'Podaj tytuł.');
    const r = db.prepare(
      'INSERT INTO materials (student_id, lesson_id, title, body, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(studentId, lessonId, title, text(b.body, 50000), req.user.id, Date.now());
    res.status(201).json({ id: r.lastInsertRowid });
  });

  api.post('/materials/upload', uploadLimit, auth, express.raw({ type: () => true, limit: `${maxUploadMb}mb` }), (req, res) => {
    const { studentId, lessonId } = materialTarget(req, { student_id: qs(req, 'student_id'), lesson_id: qs(req, 'lesson_id') });
    // Treść musi być surowym plikiem (Buffer), nie np. sparsowanym JSON-em. Rozmiar liczymy przez
    // Buffer.byteLength, a nie .length na danych z zapytania (które mogłyby być tablicą lub obiektem).
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const size = Buffer.byteLength(data);
    if (size === 0) throw httpError(400, 'Pusty plik.');
    if (req.user.role !== 'tutor') {
      const used = db.prepare(
        'SELECT COALESCE(SUM(m.size), 0) AS n FROM materials m JOIN students s ON s.id = m.student_id WHERE s.client_id = ? AND m.uploaded_by = ?'
      ).get(req.user.id, req.user.id).n;
      if (used + size > clientStorageMb * 1048576) {
        throw httpError(413, `Brak miejsca: Twoje pliki zajmują już ${Math.round(used / 1048576)} z ${clientStorageMb} MB. Usuń starsze pliki albo poproś korepetytora.`);
      }
    }
    const fileName = (str(qs(req, 'name'), 200) || 'plik').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
    // Typ pliku przychodzi w parametrze (treść zawsze jako application/octet-stream).
    const mime = (str(qs(req, 'mime'), 100) || 'application/octet-stream').toLowerCase();
    const stored = `${Date.now()}-${randomToken(9)}`;
    fs.writeFileSync(path.join(uploadsDir, stored), data);
    const r = db.prepare(
      `INSERT INTO materials (student_id, lesson_id, title, file_name, file_path, mime, size, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(studentId, lessonId, str(qs(req, 'title'), 200) || fileName, fileName, stored, mime, size, req.user.id, Date.now());
    res.status(201).json({ id: r.lastInsertRowid });
  });

  function materialFor(user, id) {
    const m = db.prepare('SELECT m.*, s.client_id FROM materials m JOIN students s ON s.id = m.student_id WHERE m.id = ?').get(int(id));
    if (!m || (user.role !== 'tutor' && m.client_id !== user.id)) throw httpError(404, 'Nie znaleziono materiału.');
    return m;
  }

  api.get('/materials/:id/file', fileLimit, auth, (req, res) => {
    const m = materialFor(req.user, req.params.id);
    if (!m.file_path) throw httpError(404, 'Ten materiał nie ma pliku.');
    const inline = SAFE_INLINE.has(m.mime) && !('download' in req.query);
    res.setHeader('Content-Type', SAFE_INLINE.has(m.mime) ? m.mime : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(m.file_name)}`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.sendFile(path.join(uploadsDir, path.basename(m.file_path)));
  });

  api.delete('/materials/:id', auth, (req, res) => {
    const m = materialFor(req.user, req.params.id);
    if (req.user.role !== 'tutor' && m.uploaded_by !== req.user.id) throw httpError(403, 'Możesz usuwać tylko swoje pliki.');
    removeMaterialFiles([m]);
    db.prepare('DELETE FROM materials WHERE id = ?').run(m.id);
    res.json({ ok: true });
  });

  function removeMaterialFiles(rows) {
    for (const r of rows) {
      if (r.file_path) fs.rm(path.join(uploadsDir, path.basename(r.file_path)), { force: true }, () => {});
    }
  }

  // ---------- korepetytor: klienci i uczniowie ----------

  function newInvite(userId, req) {
    const token = randomToken(24);
    db.prepare('UPDATE users SET invite_token = ?, invite_expires = ? WHERE id = ?').run(token, Date.now() + INVITE_DAYS * 86400000, userId);
    return `${baseUrl(req)}/#/zaproszenie/${token}`;
  }

  api.get('/clients', tutor, (req, res) => {
    const clients = db.prepare(
      "SELECT id, name, email, phone, pass_hash IS NOT NULL AS active, invite_expires, created_at FROM users WHERE role = 'client' ORDER BY name"
    ).all();
    const students = db.prepare('SELECT * FROM students ORDER BY name').all();
    res.json({
      clients: clients.map((c) => ({
        ...c,
        active: !!c.active,
        invite_pending: !!c.invite_expires && c.invite_expires > Date.now(),
        students: students.filter((s) => s.client_id === c.id),
        dues: dues(c.id),
      })),
    });
  });

  api.post('/clients', tutor, (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 100);
    if (!name) throw httpError(400, 'Podaj imię i nazwisko (albo samo imię).');
    const email = str(b.email, 200);
    if (email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw httpError(409, 'Ten e-mail jest już używany.');
    const out = tx(db, () => {
      const id = db.prepare("INSERT INTO users (role, name, email, phone, created_at) VALUES ('client', ?, ?, ?, ?)")
        .run(name, email, str(b.phone, 40), Date.now()).lastInsertRowid;
      const list = Array.isArray(b.students) && b.students.length ? b.students : [{ name }];
      for (const st of list) {
        if (!str(st.name)) continue;
        db.prepare('INSERT INTO students (client_id, name, level, subject, hourly_price, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, str(st.name, 100), str(st.level, 100), str(st.subject, 100), money(st.hourly_price), Date.now());
      }
      return id;
    });
    res.status(201).json({ id: out, invite_url: newInvite(out, req) });
  });

  api.post('/clients/:id/invite', tutor, (req, res) => {
    const c = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'client'").get(int(req.params.id));
    if (!c) throw httpError(404, 'Nie znaleziono klienta.');
    res.json({ invite_url: newInvite(c.id, req) });
  });

  api.patch('/clients/:id', tutor, (req, res) => {
    const c = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'client'").get(int(req.params.id));
    if (!c) throw httpError(404, 'Nie znaleziono klienta.');
    const b = req.body || {};
    const email = 'email' in b ? str(b.email, 200) : c.email;
    if (email && db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, c.id)) throw httpError(409, 'Ten e-mail jest już używany.');
    db.prepare('UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?')
      .run(str(b.name, 100) || c.name, email, 'phone' in b ? str(b.phone, 40) : c.phone, c.id);
    res.json({ ok: true });
  });

  // Usunięcie klienta kasuje też jego uczniów, lekcje, materiały i czat (prawo do usunięcia danych).
  api.delete('/clients/:id', tutor, (req, res) => {
    const c = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'client'").get(int(req.params.id));
    if (!c) throw httpError(404, 'Nie znaleziono klienta.');
    removeMaterialFiles(db.prepare('SELECT m.file_path FROM materials m JOIN students s ON s.id = m.student_id WHERE s.client_id = ?').all(c.id));
    db.prepare('DELETE FROM users WHERE id = ?').run(c.id);
    res.json({ ok: true });
  });

  api.post('/clients/:id/mark-paid', tutor, (req, res) => {
    const now = Date.now();
    const r = db.prepare(
      `UPDATE lessons SET paid = 1, paid_at = ? WHERE paid = 0 AND student_id IN (SELECT id FROM students WHERE client_id = ?)
       AND ((status = 'scheduled' AND end_at <= ?) OR (status = 'cancelled' AND late_cancel = 1))`
    ).run(now, int(req.params.id), now);
    res.json({ ok: true, updated: r.changes });
  });

  api.post('/students', tutor, (req, res) => {
    const b = req.body || {};
    const c = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'client'").get(int(b.client_id));
    if (!c || !str(b.name)) throw httpError(400, 'Podaj klienta i imię ucznia.');
    const r = db.prepare('INSERT INTO students (client_id, name, level, subject, hourly_price, tutor_notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, str(b.name, 100), str(b.level, 100), str(b.subject, 100), money(b.hourly_price), text(b.tutor_notes, 5000), Date.now());
    res.status(201).json({ id: r.lastInsertRowid });
  });

  api.patch('/students/:id', tutor, (req, res) => {
    const st = studentFor(req.user, req.params.id);
    const b = req.body || {};
    const pick = (k, max) => (k in b ? (k === 'tutor_notes' ? text(b[k], max) : str(b[k], max)) : st[k]);
    db.prepare('UPDATE students SET name = ?, level = ?, subject = ?, hourly_price = ?, tutor_notes = ?, active = ? WHERE id = ?').run(
      pick('name', 100) || st.name, pick('level', 100), pick('subject', 100),
      'hourly_price' in b ? money(b.hourly_price) : st.hourly_price,
      pick('tutor_notes', 5000), 'active' in b ? (b.active ? 1 : 0) : st.active, st.id
    );
    res.json({ ok: true });
  });

  // ---------- korepetytor: dostępność ----------

  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  api.get('/availability', tutor, (req, res) => {
    const rules = db.prepare('SELECT * FROM availability ORDER BY weekday, start_min').all()
      .map((r) => ({ weekday: r.weekday, start: hhmm(r.start_min), end: hhmm(r.end_min) }));
    const s = getSettings(db);
    const timeOff = db.prepare('SELECT * FROM time_off WHERE end_at > ? ORDER BY start_at').all(Date.now() - 7 * 86400000);
    res.json({ rules, time_off: timeOff, timezone: s.timezone });
  });

  api.put('/availability', tutor, (req, res) => {
    const rules = Array.isArray(req.body?.rules) ? req.body.rules : [];
    const parsed = rules.map((r) => {
      const wd = int(r.weekday);
      const a = parseTime(r.start);
      const b = parseTime(r.end);
      if (!(wd >= 1 && wd <= 7) || b <= a) throw httpError(400, 'Sprawdź godziny: koniec musi być po początku.');
      return [wd, a, b];
    });
    tx(db, () => {
      db.exec('DELETE FROM availability');
      const ins = db.prepare('INSERT INTO availability (weekday, start_min, end_min) VALUES (?, ?, ?)');
      for (const p of parsed) ins.run(...p);
    });
    res.json({ ok: true });
  });

  api.post('/time-off', tutor, (req, res) => {
    const s = getSettings(db);
    const b = req.body || {};
    const from = parseDate(b.from);
    const to = parseDate(b.to || b.from);
    const start = zonedToUtc(from.y, from.m, from.d, b.from_time ? parseTime(b.from_time) : 0, s.timezone);
    const end = zonedToUtc(to.y, to.m, to.d, b.to_time ? parseTime(b.to_time) : 1440, s.timezone);
    if (end <= start) throw httpError(400, 'Koniec musi być po początku.');
    const r = db.prepare('INSERT INTO time_off (start_at, end_at, note) VALUES (?, ?, ?)').run(start, end, str(b.note, 200));
    res.status(201).json({ id: r.lastInsertRowid });
  });

  api.delete('/time-off/:id', tutor, (req, res) => {
    db.prepare('DELETE FROM time_off WHERE id = ?').run(int(req.params.id));
    res.json({ ok: true });
  });

  // ---------- korepetytor: ustawienia ----------

  api.get('/settings', tutor, (req, res) => res.json({ settings: getSettings(db), defaults: DEFAULT_SETTINGS }));

  api.put('/settings', tutor, (req, res) => {
    const b = req.body || {};
    const patch = {};
    for (const [k, max] of Object.entries({ school_name: 100, external_meeting_url: 500, timezone: 60 })) if (k in b) patch[k] = str(b[k], max) || '';
    for (const [k, max] of Object.entries({ payment_info: 2000, rules_text: 10000 })) if (k in b) patch[k] = text(b[k], max) || '';
    if ('timezone' in patch) {
      try { new Intl.DateTimeFormat('pl', { timeZone: patch.timezone }); } catch { throw httpError(400, 'Nieznana strefa czasowa.'); }
    }
    if (patch.external_meeting_url && !/^https:\/\//.test(patch.external_meeting_url)) throw httpError(400, 'Link do spotkania musi zaczynać się od https://');
    const numKeys = { slot_step: [5, 240], buffer_min: [0, 120], min_notice_hours: [0, 720], horizon_days: [1, 365], cancel_hours: [0, 720], late_cancel_fee_pct: [0, 100], quarterly_limit: [0, 1e10], max_client_bookings: [0, 200] };
    for (const [k, [lo, hi]] of Object.entries(numKeys)) {
      if (k in b) {
        const v = int(b[k]);
        if (v == null || v < lo || v > hi) throw httpError(400, `Zła wartość: ${k}`);
        patch[k] = v;
      }
    }
    for (const k of ['allow_client_booking', 'allow_client_cancel']) if (k in b) patch[k] = !!b[k];
    if ('durations' in b) {
      const d = (Array.isArray(b.durations) ? b.durations : []).map((x) => ({ minutes: int(x.minutes), price: int(x.price) }))
        .filter((x) => x.minutes >= 15 && x.minutes <= 600 && x.price >= 0);
      if (!d.length) throw httpError(400, 'Dodaj co najmniej jedną długość lekcji.');
      patch.durations = d.sort((a, z) => a.minutes - z.minutes);
    }
    if ('countdowns' in b) {
      patch.countdowns = (Array.isArray(b.countdowns) ? b.countdowns : [])
        .filter((c) => str(c.label) && /^\d{4}-\d{2}-\d{2}$/.test(c.date)).slice(0, 10)
        .map((c) => ({ label: str(c.label, 100), date: c.date }));
    }
    if ('ice_servers' in b) {
      const ice = b.ice_servers;
      if (!Array.isArray(ice) || !ice.every((x) => x && (typeof x.urls === 'string' || Array.isArray(x.urls)))) {
        throw httpError(400, 'Serwery ICE: lista obiektów z polem "urls".');
      }
      patch.ice_servers = ice.slice(0, 10);
    }
    saveSettings(db, patch);
    res.json({ settings: getSettings(db) });
  });

  // ---------- korepetytor: pulpit i raporty ----------

  api.get('/dashboard', tutor, (req, res) => {
    const now = Date.now();
    const upcoming = db.prepare(
      `SELECT l.*, s.name AS student_name, s.client_id, u.name AS client_name FROM lessons l
       JOIN students s ON s.id = l.student_id JOIN users u ON u.id = s.client_id
       WHERE l.status = 'scheduled' AND l.end_at > ? AND l.start_at < ? ORDER BY l.start_at`
    ).all(now, now + 7 * 86400000).map((l) => publicLesson(l, req.user));
    const toSettle = db.prepare(
      `SELECT l.*, s.name AS student_name, s.client_id, u.name AS client_name FROM lessons l
       JOIN students s ON s.id = l.student_id JOIN users u ON u.id = s.client_id
       WHERE l.paid = 0 AND ((l.status = 'scheduled' AND l.end_at <= ?) OR (l.status = 'cancelled' AND l.late_cancel = 1))
       ORDER BY l.start_at DESC LIMIT 50`
    ).all(now).map((l) => publicLesson(l, req.user));
    const needsSummary = db.prepare(
      `SELECT l.id, l.start_at, s.name AS student_name FROM lessons l JOIN students s ON s.id = l.student_id
       WHERE l.status = 'scheduled' AND l.end_at <= ? AND l.end_at > ? AND (l.summary IS NULL OR l.summary = '') ORDER BY l.start_at DESC LIMIT 10`
    ).all(now, now - 14 * 86400000);
    const hasAvailability = !!db.prepare('SELECT 1 FROM availability').get();
    const clientCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'client'").get().n;
    res.json({ upcoming, to_settle: toSettle, needs_summary: needsSummary, has_availability: hasAvailability, client_count: clientCount, quarter: quarterSummary(now) });
  });

  /** Przychód należny: odbyte lekcje + opłaty za późne odwołania, liczone wg daty lekcji. */
  function revenueRows(from, to, now = Date.now()) {
    return db.prepare(
      `SELECT l.*, s.name AS student_name, u.name AS client_name FROM lessons l
       JOIN students s ON s.id = l.student_id JOIN users u ON u.id = s.client_id
       WHERE l.start_at >= ? AND l.start_at < ?
         AND ((l.status = 'scheduled' AND l.start_at < ?) OR (l.status = 'cancelled' AND l.late_cancel = 1 AND l.price > 0))
       ORDER BY l.start_at`
    ).all(from, to, now);
  }

  function quarterSummary(now) {
    const s = getSettings(db);
    const z = zonedParts(now, s.timezone);
    const q = Math.floor((z.m - 1) / 3);
    const from = zonedToUtc(z.y, q * 3 + 1, 1, 0, s.timezone);
    const to = q === 3 ? zonedToUtc(z.y + 1, 1, 1, 0, s.timezone) : zonedToUtc(z.y, q * 3 + 4, 1, 0, s.timezone);
    const revenue = revenueRows(from, to, now).reduce((a, l) => a + l.price, 0);
    return { year: z.y, quarter: q + 1, revenue, limit: s.quarterly_limit };
  }

  api.get('/reports', tutor, (req, res) => {
    const s = getSettings(db);
    const year = int(qs(req, 'year')) || zonedParts(Date.now(), s.timezone).y;
    const monthStart = (m) => (m === 13 ? zonedToUtc(year + 1, 1, 1, 0, s.timezone) : zonedToUtc(year, m, 1, 0, s.timezone));
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const from = monthStart(m);
      const to = monthStart(m + 1);
      const rows = revenueRows(from, to);
      const paid = db.prepare('SELECT COALESCE(SUM(price), 0) AS v FROM lessons WHERE paid = 1 AND paid_at >= ? AND paid_at < ?').get(from, to).v;
      months.push({
        month: m,
        lessons: rows.filter((r) => r.status === 'scheduled').length,
        late_cancels: rows.filter((r) => r.status === 'cancelled').length,
        hours: rows.filter((r) => r.status === 'scheduled').reduce((a, r) => a + (r.end_at - r.start_at) / 3600000, 0),
        revenue: rows.reduce((a, r) => a + r.price, 0),
        received: paid,
      });
    }
    const quarters = [0, 1, 2, 3].map((q) => ({
      quarter: q + 1,
      revenue: months.slice(q * 3, q * 3 + 3).reduce((a, m) => a + m.revenue, 0),
    }));
    res.json({ year, months, quarters, limit: s.quarterly_limit });
  });

  api.get('/reports/csv', tutor, (req, res) => {
    const s = getSettings(db);
    const year = int(qs(req, 'year')) || zonedParts(Date.now(), s.timezone).y;
    const rows = revenueRows(zonedToUtc(year, 1, 1, 0, s.timezone), zonedToUtc(year + 1, 1, 1, 0, s.timezone));
    const dt = new Intl.DateTimeFormat('pl-PL', { timeZone: s.timezone, dateStyle: 'short', timeStyle: 'short' });
    const money = (g) => (g / 100).toFixed(2).replace('.', ',');
    // Komórki zaczynające się od = + - @ arkusz potraktowałby jako formułę (CSV injection): poprzedzamy je apostrofem.
    const q = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [['Lp.', 'Data lekcji', 'Uczeń', 'Klient', 'Temat', 'Minuty', 'Status', 'Kwota (zł)', 'Opłacona', 'Data wpłaty'].map(q).join(';')];
    let sum = 0;
    rows.forEach((r, i) => {
      sum += r.price;
      lines.push([
        i + 1, dt.format(r.start_at), r.student_name, r.client_name, r.topic || '',
        Math.round((r.end_at - r.start_at) / 60000), r.status === 'scheduled' ? 'odbyta' : 'późne odwołanie',
        money(r.price), r.paid ? 'tak' : 'nie', r.paid_at ? dt.format(r.paid_at) : '',
      ].map(q).join(';'));
    });
    lines.push(['', '', '', '', '', '', 'Razem', money(sum), '', ''].map(q).join(';'));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="przychody-${year}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  });

  // ---------- błędy ----------

  api.use((req, res, next) => next(httpError(404, 'Nie ma takiego adresu API.')));

  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (/SLOT_TAKEN/.test(err.message)) return res.status(409).json({ error: 'Ten termin jest już zajęty.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: `Plik jest za duży (max ${maxUploadMb} MB).` });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Nieprawidłowe dane.' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Błąd serwera.' : err.message });
  });

  return { api, lessonFor };
}
