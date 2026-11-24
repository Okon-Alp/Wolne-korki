// Hasła (scrypt), sesje w ciasteczku httpOnly, ochrona CSRF i limit prób logowania.
import crypto from 'node:crypto';

// OWASP: scrypt N=2^14 (16 MiB), r=8, p=5. Parametry zapisujemy w hashu, stare hashe przeliczamy przy logowaniu.
const SCRYPT = { N: 16384, r: 8, p: 5 };
const PREFIX = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$`;
const SESSION_DAYS = 30;
export const COOKIE = 'wk_sid';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, SCRYPT);
  return `${PREFIX}${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  let params = { N: 16384, r: 8, p: 1 }; // format z pierwszej wersji: scrypt$sól$hash
  let saltB64, hashB64;
  if (parts.length === 3) [, saltB64, hashB64] = parts;
  else if (parts.length === 6) { params = { N: +parts[1], r: +parts[2], p: +parts[3] }; [, , , , saltB64, hashB64] = parts; }
  else return false;
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(saltB64, 'base64'), expected.length, { ...params, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(expected, got);
}

/** Czy hash jest w starym formacie / ze słabszymi parametrami (do przeliczenia po udanym logowaniu). */
export const needsRehash = (stored) => !String(stored || '').startsWith(PREFIX);

/** Hash losowego hasła: sprawdzamy go, gdy konta nie ma, żeby czas odpowiedzi nie zdradzał istnienia konta. */
export const DUMMY_HASH = hashPassword(crypto.randomBytes(24).toString('base64'));

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Hasło musi mieć co najmniej 10 znaków.';
  if (pw.length > 200) return 'Hasło jest za długie.';
  return null;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession(db, res, userId, secure) {
  const token = randomToken();
  const expires = Date.now() + SESSION_DAYS * 86400000;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
  res.setHeader('Set-Cookie', cookieString(token, SESSION_DAYS * 86400, secure));
}

export function destroySession(db, req, res, secure) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', cookieString('', 0, secure));
}

function cookieString(value, maxAge, secure) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/** Zwraca użytkownika z sesji (albo null). Używane też przy WebSockecie. */
export function userFromRequest(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.role, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).get(sha256(token), Date.now());
  return row ? { ...row } : null;
}

/**
 * CSRF: zmiany stanu wymagają własnego nagłówka (przeglądarka nie wyśle go z obcej strony
 * bez zgody CORS, której nie dajemy) oraz zgodnego nagłówka Origin, jeśli jest obecny.
 */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'wolne-korki') {
    return res.status(403).json({ error: 'Brak nagłówka zabezpieczającego.' });
  }
  const origin = req.get('origin');
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    // req.host w Express 5 uwzględnia X-Forwarded-Host, gdy włączone jest „trust proxy”.
    if (host !== req.host && host !== req.get('host')) return res.status(403).json({ error: 'Niedozwolone źródło żądania.' });
  }
  next();
}

/** Limit nieudanych prób w pamięci: po `limit` porażkach na klucz blokada do końca okna `windowMs`. */
export function makeRateLimiter(limit = 10, windowMs = 15 * 60000) {
  const fails = new Map();
  const live = (key, now = Date.now()) => {
    const f = fails.get(key);
    if (f && f.reset < now) { fails.delete(key); return null; }
    return f;
  };
  return {
    blocked(key) { return (live(key)?.n || 0) >= limit; },
    fail(key) {
      const now = Date.now();
      const f = live(key, now);
      if (f) f.n += 1; else fails.set(key, { n: 1, reset: now + windowMs });
      if (fails.size > 10000) for (const [k, v] of fails) if (v.reset < now) fails.delete(k);
    },
    clear(key) { fails.delete(key); },
  };
}
