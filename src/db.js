// Baza danych: wbudowany SQLite z Node.js (node:sqlite), bez natywnych zależności.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL              -- JSON
);

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  role           TEXT NOT NULL CHECK (role IN ('tutor', 'client')),
  name           TEXT NOT NULL,
  email          TEXT UNIQUE COLLATE NOCASE,
  phone          TEXT,
  pass_hash      TEXT,
  ical_token     TEXT UNIQUE,
  invite_token   TEXT UNIQUE,      -- link zaproszenia albo resetu hasła
  invite_expires INTEGER,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- Uczeń należy do konta klienta (rodzica albo dorosłego ucznia).
CREATE TABLE IF NOT EXISTS students (
  id          INTEGER PRIMARY KEY,
  client_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  level       TEXT,                -- np. "8 klasa", "matura rozszerzona"
  subject     TEXT,
  hourly_price INTEGER,            -- grosze za 60 min; NULL = cennik domyślny
  tutor_notes TEXT,                -- widoczne tylko dla korepetytora
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- Tygodniowa dostępność w czasie lokalnym korepetytora (minuty od północy).
CREATE TABLE IF NOT EXISTS availability (
  id        INTEGER PRIMARY KEY,
  weekday   INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- 1 = poniedziałek
  start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1440),
  end_min   INTEGER NOT NULL CHECK (end_min BETWEEN 0 AND 1440),
  CHECK (end_min > start_min)
);

CREATE TABLE IF NOT EXISTS time_off (
  id       INTEGER PRIMARY KEY,
  start_at INTEGER NOT NULL,
  end_at   INTEGER NOT NULL CHECK (end_at > start_at),
  note     TEXT
);

CREATE TABLE IF NOT EXISTS lessons (
  id           INTEGER PRIMARY KEY,
  student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  start_at     INTEGER NOT NULL,   -- ms od epoki, UTC
  end_at       INTEGER NOT NULL CHECK (end_at > start_at),
  status       TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  mode         TEXT NOT NULL DEFAULT 'online' CHECK (mode IN ('online', 'onsite')),
  location     TEXT,
  topic        TEXT,
  price        INTEGER NOT NULL DEFAULT 0,   -- grosze; po późnym odwołaniu = opłata za odwołanie
  paid         INTEGER NOT NULL DEFAULT 0,
  paid_at      INTEGER,
  summary      TEXT,               -- notatka po lekcji (widzi rodzic/uczeń)
  homework     TEXT,
  tutor_notes  TEXT,               -- prywatne
  whiteboard   TEXT,               -- JSON z kreskami tablicy
  created_by   INTEGER,
  created_at   INTEGER NOT NULL,
  cancelled_at INTEGER,
  cancelled_by INTEGER,
  late_cancel  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS lessons_time ON lessons(start_at, end_at);
CREATE INDEX IF NOT EXISTS lessons_student ON lessons(student_id);

-- Gwarancja na poziomie bazy: dwie zaplanowane lekcje nie mogą na siebie zachodzić.
-- Działa niezależnie od kodu aplikacji, także przy równoczesnych rezerwacjach.
CREATE TRIGGER IF NOT EXISTS lessons_no_overlap_insert
BEFORE INSERT ON lessons WHEN NEW.status = 'scheduled'
BEGIN
  SELECT RAISE(ABORT, 'SLOT_TAKEN') WHERE EXISTS (
    SELECT 1 FROM lessons
    WHERE status = 'scheduled' AND start_at < NEW.end_at AND end_at > NEW.start_at
  );
END;

CREATE TRIGGER IF NOT EXISTS lessons_no_overlap_update
BEFORE UPDATE OF start_at, end_at, status ON lessons WHEN NEW.status = 'scheduled'
BEGIN
  SELECT RAISE(ABORT, 'SLOT_TAKEN') WHERE EXISTS (
    SELECT 1 FROM lessons
    WHERE status = 'scheduled' AND id != NEW.id
      AND start_at < NEW.end_at AND end_at > NEW.start_at
  );
END;

CREATE TABLE IF NOT EXISTS materials (
  id          INTEGER PRIMARY KEY,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  lesson_id   INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  file_name   TEXT,
  file_path   TEXT,
  mime        TEXT,
  size        INTEGER,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat (
  id        INTEGER PRIMARY KEY,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body      TEXT NOT NULL,
  at        INTEGER NOT NULL
);
`;

export const DEFAULT_SETTINGS = {
  school_name: 'Moje korepetycje',
  timezone: 'Europe/Warsaw',
  // Długości lekcji i ceny (grosze). Indywidualna stawka ucznia ma pierwszeństwo.
  durations: [
    { minutes: 60, price: 10000 },
    { minutes: 90, price: 15000 },
  ],
  slot_step: 30,               // co ile minut pokazywać możliwe początki lekcji
  buffer_min: 0,               // przerwa między lekcjami
  min_notice_hours: 12,        // najpóźniej ile godzin przed lekcją można zarezerwować
  horizon_days: 28,            // jak daleko w przód można rezerwować
  cancel_hours: 24,            // bezpłatne odwołanie do tylu godzin przed lekcją
  late_cancel_fee_pct: 100,    // ile procent ceny przy późnym odwołaniu
  allow_client_booking: true,
  max_client_bookings: 12,     // ile przyszłych lekcji rodzic może mieć zarezerwowanych sam (0 = bez limitu)
  allow_client_cancel: true,
  payment_info: 'BLIK na telefon albo przelew. Numer podam na pierwszej lekcji.',
  rules_text: 'Lekcję można bezpłatnie odwołać najpóźniej 24 godziny przed jej rozpoczęciem. Później odwołana lekcja jest płatna.\nNa lekcję online potrzebna jest przeglądarka z kamerą i mikrofonem.',
  ice_servers: [{ urls: 'stun:stun.l.google.com:19302' }],
  external_meeting_url: '',    // opcjonalnie stały link do Jitsi / Meet jako zapas
  countdowns: [
    { label: 'Egzamin ósmoklasisty 2027', date: '2027-05-10' },
    { label: 'Matura 2027', date: '2027-05-04' },
  ],
  quarterly_limit: 1081350,    // limit działalności nierejestrowanej 2026 (grosze); 0 = wyłączony
};

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) {
    if (r.key in DEFAULT_SETTINGS) {
      try { s[r.key] = JSON.parse(r.value); } catch { /* zostaw domyślne */ }
    }
  }
  return s;
}

export function saveSettings(db, patch) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULT_SETTINGS) stmt.run(k, JSON.stringify(v));
  }
}

/** Uruchamia fn w transakcji z blokadą zapisu (BEGIN IMMEDIATE). */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
