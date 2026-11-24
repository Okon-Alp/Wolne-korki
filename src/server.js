// Punkt startowy serwera.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb } from './db.js';
import { createApi } from './api.js';
import { csrfGuard, randomToken } from './auth.js';
import { attachRooms } from './room.js';
import { icalHandler } from './ical.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createServer(opts = {}) {
  const dataDir = path.resolve(opts.dataDir ?? process.env.DATA_DIR ?? path.join(root, 'data'));
  const db = opts.db ?? openDb(path.join(dataDir, 'wolne-korki.db'));
  const env = process.env;
  const inCodespace = env.CODESPACES === 'true' && env.CODESPACE_NAME;
  // W GitHub Codespaces publiczny adres znamy z góry: https://<nazwa>-<port>.app.github.dev
  const codespaceUrl = inCodespace
    ? `https://${env.CODESPACE_NAME}-${env.PORT || 3000}.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'}`
    : '';
  const publicUrl = (opts.publicUrl ?? (env.PUBLIC_URL || codespaceUrl)).replace(/\/$/, '');

  // Jednorazowy kod do pierwszej konfiguracji: nikt obcy nie przejmie świeżo postawionej instancji.
  let code = opts.setupCode ?? process.env.SETUP_CODE ?? null;
  const setupCode = () => {
    if (!code) code = randomToken(12).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
    return code;
  };

  const app = express();
  app.disable('x-powered-by');
  const trust = opts.trustProxy ?? env.TRUST_PROXY ?? (inCodespace ? '1' : undefined);
  if (trust) app.set('trust proxy', trust === 'true' ? true : /^\d+$/.test(trust) ? +trust : trust);

  // Licznik ruchu do logu aktywności (patrz niżej).
  let requests = 0;
  app.use((req, res, next) => { requests += 1; next(); });

  app.use((req, res, next) => {
    // WebSocket tylko do własnego serwera (bez ogólnego ws:/wss:, które pozwalałoby wysłać dane gdziekolwiek).
    const host = /^[a-z0-9.-]+(:\d+)?$/i.test(req.host || '') ? req.host : null;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",   // KaTeX ustawia style w atrybutach
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self'",
      `connect-src 'self'${host ? ` wss://${host} ws://${host}` : ''}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '));
    next();
  });

  const { api, lessonFor } = createApi({
    db, dataDir, setupCode, publicUrl,
    maxUploadMb: +(opts.maxUploadMb ?? process.env.MAX_UPLOAD_MB ?? 25),
    clientStorageMb: +(opts.clientStorageMb ?? process.env.MAX_CLIENT_STORAGE_MB ?? 100),
  });
  app.use('/api', csrfGuard, express.json({ limit: '2mb' }), api);
  app.get('/ical/:token', icalHandler(db, publicUrl));
  app.use('/vendor/katex', express.static(path.join(root, 'node_modules/katex/dist'), { maxAge: '30d' }));
  app.use(express.static(path.join(root, 'public'), { index: 'index.html', maxAge: 0 }));

  const server = http.createServer(app);
  const rooms = attachRooms(server, { db, lessonFor, trustProxy: !!trust });

  // Log aktywności: co minutę, jeśli ktoś korzysta z aplikacji. W Codespaces wypisywanie do terminala
  // liczy się jako aktywność, więc środowisko nie usypia w trakcie lekcji.
  let activityTimer = null;
  if (opts.activityLog ?? (env.ACTIVITY_LOG === '1' || inCodespace)) {
    activityTimer = setInterval(() => {
      const people = rooms.activePeople();
      if (requests || people) {
        const t = new Date().toLocaleTimeString('pl-PL', { timeZone: env.TZ || 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' });
        const n10 = requests % 10, n100 = requests % 100;
        const word = requests === 1 ? 'żądanie' : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? 'żądania' : 'żądań';
        console.log(`[${t}] aktywność: ${requests} ${word}${people ? `, na lekcji: ${people} os.` : ''}`);
      }
      requests = 0;
    }, 60000);
    activityTimer.unref();
  }

  return {
    app, server, db, setupCode, publicUrl,
    close() { clearInterval(activityTimer); rooms.close(); server.close(); },
  };
}

// Uruchomienie z linii poleceń.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = +(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const s = createServer();
  s.server.listen(port, host, () => {
    console.log(`Wolne Korki działa: http://localhost:${port}`);
    if (s.publicUrl) console.log(`Adres publiczny: ${s.publicUrl}`);
    const tutor = s.db.prepare("SELECT 1 FROM users WHERE role = 'tutor'").get();
    if (!tutor) {
      console.log('');
      console.log('  Pierwsze uruchomienie. Otwórz stronę i wpisz kod konfiguracji:');
      console.log(`  KOD: ${s.setupCode()}`);
      console.log('');
    }
  });
  s.server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`Port ${port} jest zajęty, czyli Wolne Korki prawdopodobnie już działają. Nic nie robię.`);
      process.exit(0);
    }
    throw e;
  });
  const stop = () => { s.close(); s.db.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
