// Testy end-to-end API i pokoju lekcji. Uruchom: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';
import { openDb } from '../src/db.js';
import { zonedParts, dateKey } from '../src/time.js';

let srv, base, dataDir;
const TZ = 'Europe/Warsaw';

function agent() {
  let cookie = '';
  const call = async (method, url, body, extra = {}) => {
    const headers = { 'x-requested-with': 'wolne-korki', ...(extra.headers || {}) };
    if (cookie) headers.cookie = cookie;
    let payload;
    if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    if (extra.raw) { headers['content-type'] = 'application/octet-stream'; payload = extra.raw; }
    if (extra.noCsrf) delete headers['x-requested-with'];
    const r = await fetch(base + url, { method, headers, body: payload });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    return { status: r.status, data };
  };
  return { call, get cookie() { return cookie; } };
}

const tutorA = agent();
const parent1 = agent();
const parent2 = agent();
let student1, student2, client1Id;

/** Lokalna data i godzina w strefie korepetytora dla chwili ms. */
function local(ms) {
  const z = zonedParts(ms, TZ);
  return { date: dateKey(z), time: `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}` };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-test-'));
  srv = createServer({ dataDir, db: openDb(':memory:'), setupCode: 'TESTCODE' });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});

after(() => {
  srv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('pierwsza konfiguracja wymaga kodu z logów', async () => {
  assert.equal((await tutorA.call('GET', '/api/status')).data.setup_needed, true);
  const bad = await tutorA.call('POST', '/api/setup', { code: 'ZLY', name: 'Ola', email: 't@example.com', password: 'bardzo-dlugie-haslo' });
  assert.equal(bad.status, 403);
  const ok = await tutorA.call('POST', '/api/setup', { code: 'TESTCODE', name: 'Ola', email: 't@example.com', password: 'bardzo-dlugie-haslo', school_name: 'Korki u Oli' });
  assert.equal(ok.status, 200);
  const again = await agent().call('POST', '/api/setup', { code: 'TESTCODE', name: 'X', email: 'x@example.com', password: 'bardzo-dlugie-haslo' });
  assert.equal(again.status, 409);
  const me = await tutorA.call('GET', '/api/me');
  assert.equal(me.data.user.role, 'tutor');
  assert.equal(me.data.settings.school_name, 'Korki u Oli');
});

test('CSRF: zmiana stanu bez nagłówka jest odrzucana', async () => {
  const r = await tutorA.call('PUT', '/api/settings', { min_notice_hours: 0 }, { noCsrf: true });
  assert.equal(r.status, 403);
  const r2 = await tutorA.call('PUT', '/api/settings', { min_notice_hours: 0 }, { headers: { origin: 'https://zla-strona.example' } });
  assert.equal(r2.status, 403);
});

test('korepetytor ustawia dostępność i zaprasza rodziców', async () => {
  // Codziennie 8:00–22:00, żeby test działał o każdej porze.
  const rules = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '08:00', end: '22:00' }));
  assert.equal((await tutorA.call('PUT', '/api/availability', { rules })).status, 200);
  assert.equal((await tutorA.call('PUT', '/api/settings', { min_notice_hours: 0, horizon_days: 60 })).status, 200);

  const c1 = await tutorA.call('POST', '/api/clients', { name: 'Anna Kowalska', students: [{ name: 'Kuba', level: '8 klasa' }, { name: 'Zosia', level: 'liceum', hourly_price: 12000 }] });
  assert.equal(c1.status, 201);
  client1Id = c1.data.id;
  const token1 = c1.data.invite_url.split('/zaproszenie/')[1];
  const info = await parent1.call('GET', `/api/invite/${token1}`);
  assert.equal(info.data.name, 'Anna Kowalska');
  assert.equal((await parent1.call('POST', `/api/invite/${token1}`, { email: 'p1@example.com', password: 'krotkie' })).status, 400);
  assert.equal((await parent1.call('POST', `/api/invite/${token1}`, { email: 'p1@example.com', password: 'haslo-rodzica-1' })).status, 200);
  assert.equal((await agent().call('GET', `/api/invite/${token1}`)).status, 404, 'link jednorazowy');

  const c2 = await tutorA.call('POST', '/api/clients', { name: 'Piotr Nowak' });
  const token2 = c2.data.invite_url.split('/zaproszenie/')[1];
  assert.equal((await parent2.call('POST', `/api/invite/${token2}`, { email: 'p2@example.com', password: 'haslo-rodzica-2' })).status, 200);

  const me1 = await parent1.call('GET', '/api/me');
  assert.equal(me1.data.students.length, 2);
  student1 = me1.data.students.find((s) => s.name === 'Kuba').id;
  const zosia = me1.data.students.find((s) => s.name === 'Zosia');
  assert.equal(zosia.prices.find((p) => p.minutes === 90).price, 18000, 'stawka indywidualna 120 zł/h');
  assert.equal(me1.data.settings.tutor_notes, undefined);
  student2 = (await parent2.call('GET', '/api/me')).data.students[0].id;
});

test('nie da się zarezerwować tej samej godziny dwa razy, nawet równocześnie', async () => {
  const day = local(Date.now() + 3 * 86400000).date;
  const slots = (await parent1.call('GET', `/api/slots?from=${day}&to=${day}&minutes=60`)).data.slots;
  assert.ok(slots.length > 5);
  const slot = slots[2];
  const attempts = await Promise.all([
    parent1.call('POST', '/api/lessons', { student_id: student1, start: slot.start, minutes: 60 }),
    parent2.call('POST', '/api/lessons', { student_id: student2, start: slot.start, minutes: 60 }),
    parent1.call('POST', '/api/lessons', { student_id: student1, start: slot.start, minutes: 60 }),
    parent2.call('POST', '/api/lessons', { student_id: student2, start: slot.start + 30 * 60000, minutes: 60 }),
  ]);
  const ok = attempts.filter((a) => a.status === 201);
  assert.equal(ok.length, 1, 'dokładnie jedna rezerwacja przechodzi');
  assert.ok(attempts.filter((a) => a.status === 409).length === 3);

  const after = (await parent2.call('GET', `/api/slots?from=${day}&to=${day}&minutes=60`)).data.slots;
  assert.ok(!after.some((s) => s.start < slot.end && s.end > slot.start), 'zajęty termin znika z listy');

  // Korepetytor też nie wpisze kolidującej lekcji.
  const { date, time } = local(slot.start + 15 * 60000);
  const clash = await tutorA.call('POST', '/api/lessons', { student_id: student2, date, time, minutes: 45 });
  assert.equal(clash.status, 409);
});

test('baza danych sama blokuje nakładające się lekcje (wyzwalacz)', () => {
  const db = srv.db;
  const l = db.prepare("SELECT * FROM lessons WHERE status = 'scheduled' LIMIT 1").get();
  assert.throws(
    () => db.prepare('INSERT INTO lessons (student_id, start_at, end_at, created_at) VALUES (?, ?, ?, ?)').run(l.student_id, l.start_at + 1, l.end_at + 1, Date.now()),
    /SLOT_TAKEN/
  );
});

test('rodzic nie widzi cudzych lekcji ani uczniów', async () => {
  const lessons1 = (await parent1.call('GET', '/api/lessons')).data.lessons;
  const lessons2 = (await parent2.call('GET', '/api/lessons')).data.lessons;
  const foreign = [...lessons1, ...lessons2].find(Boolean);
  const other = lessons1.includes(foreign) ? parent2 : parent1;
  assert.equal((await other.call('GET', `/api/lessons/${foreign.id}`)).status, 404);
  assert.equal((await parent2.call('POST', '/api/lessons', { student_id: student1, start: Date.now() + 5 * 86400000, minutes: 60 })).status, 404);
  assert.equal((await parent1.call('GET', '/api/clients')).status, 403);
});

test('lekcje cykliczne pomijają kolizje', async () => {
  const start = local(Date.now() + 20 * 86400000);
  const r = await tutorA.call('POST', '/api/lessons', { student_id: student2, date: start.date, time: '09:00', minutes: 60, repeat_weeks: 3, topic: 'Funkcje' });
  assert.equal(r.status, 201);
  assert.equal(r.data.created.length, 3);
  const r2 = await tutorA.call('POST', '/api/lessons', { student_id: student1, date: start.date, time: '09:30', minutes: 60, repeat_weeks: 2 });
  assert.equal(r2.status, 409);
});

test('odwołanie: wcześnie za darmo, późno płatne', async () => {
  // Wczesne odwołanie (za 10 dni).
  const early = local(Date.now() + 10 * 86400000);
  const e = await tutorA.call('POST', '/api/lessons', { student_id: student1, date: early.date, time: '12:00', minutes: 60 });
  const ec = await parent1.call('POST', `/api/lessons/${e.data.created[0]}/cancel`);
  assert.equal(ec.status, 200);
  assert.equal(ec.data.late, false);

  // Późne odwołanie (za 2 godziny).
  const soon = local(Date.now() + 2 * 3600000);
  const s = await tutorA.call('POST', '/api/lessons', { student_id: student1, date: soon.date, time: soon.time, minutes: 60, price: 9000 });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  const sc = await parent1.call('POST', `/api/lessons/${s.data.created[0]}/cancel`);
  assert.equal(sc.data.late, true);
  assert.equal(sc.data.fee, 9000);
  assert.equal((await parent1.call('POST', `/api/lessons/${s.data.created[0]}/cancel`)).status, 400, 'nie da się odwołać dwa razy');
});

test('należności, oznaczanie wpłat, raport i CSV', async () => {
  const past = local(Date.now() - 2 * 86400000);
  const r = await tutorA.call('POST', '/api/lessons', { student_id: student1, date: past.date, time: '07:00', minutes: 60, price: 10000 });
  assert.equal(r.status, 201);
  let me = (await parent1.call('GET', '/api/me')).data;
  assert.equal(me.dues.due, 19000, 'odbyta lekcja 100 zł + późne odwołanie 90 zł');
  assert.equal(me.dues.due_count, 2);
  await tutorA.call('POST', `/api/clients/${client1Id}/mark-paid`);
  me = (await parent1.call('GET', '/api/me')).data;
  assert.equal(me.dues.due, 0);

  const year = +past.date.slice(0, 4);
  const rep = (await tutorA.call('GET', `/api/reports?year=${year}`)).data;
  assert.ok(rep.months.reduce((a, m) => a + m.revenue, 0) >= 19000);
  const csv = await tutorA.call('GET', `/api/reports/csv?year=${year}`);
  assert.match(csv.data, /późne odwołanie/);
  assert.match(csv.data, /Kuba/);
});

test('materiały: notatka, plik, dostęp tylko dla właściciela', async () => {
  const n = await tutorA.call('POST', '/api/materials', { student_id: student1, title: 'Wzory skróconego mnożenia', body: '$(a+b)^2 = a^2 + 2ab + b^2$' });
  assert.equal(n.status, 201);
  const up = await parent1.call('POST', `/api/materials/upload?student_id=${student1}&name=zadanie.html&mime=text/html`, undefined, { raw: Buffer.from('<script>alert(1)</script>') });
  assert.equal(up.status, 201);
  const dl = await fetch(`${base}/api/materials/${up.data.id}/file`, { headers: { cookie: parent1.cookie } });
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream', 'HTML nie jest serwowany jako strona');
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal((await parent2.call('GET', `/api/materials/${up.data.id}/file`)).status, 404);
  const list = (await parent2.call('GET', '/api/materials')).data.materials;
  assert.equal(list.length, 0);
});

test('kalendarz .ics', async () => {
  const me = (await parent1.call('GET', '/api/me')).data;
  const r = await fetch(me.ical_url.replace(/^https?:\/\/[^/]+/, base));
  const body = await r.text();
  assert.match(body, /BEGIN:VCALENDAR/);
  assert.match(body, /BEGIN:VEVENT/);
  assert.equal((await fetch(`${base}/ical/zly-token.ics`)).status, 404);
});

test('pokój lekcji: dostęp, czat i tablica przez WebSocket', async () => {
  const lessons = (await parent1.call('GET', '/api/lessons')).data.lessons.filter((l) => l.status === 'scheduled');
  const lesson = lessons[0];
  const wsUrl = base.replace('http', 'ws') + `/ws?lesson=${lesson.id}`;
  const open = (cookie) => new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { cookie } });
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d)));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('unexpected-response', (req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
  });
  const wait = (inbox, pred) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = inbox.find(pred);
      if (m) { clearInterval(iv); resolve(m); } else if (Date.now() - t0 > 3000) { clearInterval(iv); reject(new Error('timeout')); }
    }, 20);
  });

  await assert.rejects(open(parent2.cookie), /403/, 'obcy rodzic nie wejdzie');
  const t = await open(tutorA.cookie);
  const p = await open(parent1.cookie);
  await wait(t.inbox, (m) => m.t === 'peer-join');
  const init = await wait(p.inbox, (m) => m.t === 'init');
  assert.equal(init.peers.length, 1);

  p.ws.send(JSON.stringify({ t: 'chat', body: 'Dzień dobry!' }));
  const chat = await wait(t.inbox, (m) => m.t === 'chat');
  assert.equal(chat.msg.body, 'Dzień dobry!');

  const rect = (version, versionNonce, extra = {}) => ({ id: 'r1', type: 'rectangle', x: 10, y: 20, width: 100, height: 50, version, versionNonce, isDeleted: false, ...extra });
  t.ws.send(JSON.stringify({ t: 'xd', op: 'elements', elements: [rect(3, 100), { id: 'zly' }] }));
  const got = await wait(p.inbox, (m) => m.t === 'xd' && m.op === 'elements');
  assert.equal(got.elements.length, 1, 'niepoprawny element odrzucony');
  assert.equal(got.uid, init.peers[0].id);
  // Starsza wersja od rodzica nie nadpisuje nowszej; remis wersji wygrywa niższe versionNonce.
  p.ws.send(JSON.stringify({ t: 'xd', op: 'elements', elements: [rect(2, 1, { x: 999 })] }));
  p.ws.send(JSON.stringify({ t: 'xd', op: 'elements', elements: [rect(3, 50, { width: 300 })] }));
  await wait(t.inbox, (m) => m.t === 'xd' && m.op === 'elements');
  const png = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');
  p.ws.send(JSON.stringify({ t: 'xd', op: 'files', files: [{ id: 'f1', mimeType: 'image/png', dataURL: png, created: 1 }, { id: 'f2', dataURL: 'data:text/html;base64,PHNjcmlwdD4=' }] }));
  const files = await wait(t.inbox, (m) => m.t === 'xd' && m.op === 'files');
  assert.deepEqual(files.files.map((f) => f.id), ['f1'], 'tylko obrazki');
  p.ws.send(JSON.stringify({ t: 'xd', op: 'pointer', x: 5, y: 6, tool: 'laser', button: 'down' }));
  const ptr = await wait(t.inbox, (m) => m.t === 'xd' && m.op === 'pointer');
  assert.equal(ptr.tool, 'laser');
  t.ws.send(JSON.stringify({ t: 'signal', data: { description: { type: 'offer', sdp: 'x' } } }));
  await wait(p.inbox, (m) => m.t === 'signal');

  t.ws.close();
  p.ws.close();
  await new Promise((r) => setTimeout(r, 100));
  const saved = JSON.parse(srv.db.prepare('SELECT whiteboard FROM lessons WHERE id = ?').get(lesson.id).whiteboard);
  assert.equal(saved.format, 'excalidraw');
  assert.equal(saved.elements.length, 1);
  assert.equal(saved.elements[0].width, 300, 'remis wersji: wygrywa niższe versionNonce');
  assert.equal(saved.elements[0].x, 10, 'starsza wersja zignorowana');
  assert.ok(saved.files.f1);

  // Po ponownym wejściu tablica wraca z bazy.
  const again = await open(tutorA.cookie);
  const init2 = await wait(again.inbox, (m) => m.t === 'init');
  assert.equal(init2.board.elements[0].width, 300);
  again.ws.close();
});

test('usunięcie klienta kasuje jego dane', async () => {
  const before = srv.db.prepare('SELECT COUNT(*) n FROM lessons l JOIN students s ON s.id = l.student_id WHERE s.client_id = ?').get(client1Id).n;
  assert.ok(before > 0);
  assert.equal((await tutorA.call('DELETE', `/api/clients/${client1Id}`)).status, 200);
  assert.equal(srv.db.prepare('SELECT COUNT(*) n FROM students WHERE client_id = ?').get(client1Id).n, 0);
  assert.equal(srv.db.prepare('SELECT COUNT(*) n FROM materials WHERE student_id = ?').get(student1).n, 0);
  assert.equal((await parent1.call('GET', '/api/me')).data.user, null, 'sesja usunięta razem z kontem');
  assert.equal((await parent1.call('GET', '/api/lessons')).status, 401);
});

test('limit logowań liczy tylko nieudane próby', async () => {
  for (let i = 0; i < 15; i++) {
    assert.equal((await agent().call('POST', '/api/login', { email: 't@example.com', password: 'bardzo-dlugie-haslo' })).status, 200, 'udane logowania nie blokują');
  }
  for (let i = 0; i < 10; i++) {
    assert.equal((await agent().call('POST', '/api/login', { email: 't@example.com', password: 'zle-haslo' })).status, 401);
  }
  const blocked = await agent().call('POST', '/api/login', { email: 't@example.com', password: 'bardzo-dlugie-haslo' });
  assert.equal(blocked.status, 429, 'po 10 porażkach blokada także dla dobrego hasła');
});

test('za proxy (Codespaces, Railway): Origin z publicznym adresem przechodzi tylko przy TRUST_PROXY', async () => {
  const mk = async (trustProxy) => {
    const s = createServer({ dataDir, db: openDb(':memory:'), setupCode: 'X', trustProxy, activityLog: false });
    await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
    return s;
  };
  const headers = { 'content-type': 'application/json', 'x-requested-with': 'wolne-korki', origin: 'https://abc-3000.app.github.dev', 'x-forwarded-host': 'abc-3000.app.github.dev', 'x-forwarded-proto': 'https' };
  const body = JSON.stringify({ email: 'x@example.com', password: 'zzzzzzzzzzzz' });
  for (const [trust, expected] of [[undefined, 403], ['1', 401]]) {
    const s = await mk(trust);
    const r = await fetch(`http://127.0.0.1:${s.server.address().port}/api/login`, { method: 'POST', headers, body });
    assert.equal(r.status, expected, `trustProxy=${trust}`);
    s.close();
  }
});

test('poprawki z CodeQL: e-mail bez ReDoS, parametry tylko jako napisy, limity zapytań', async () => {
  const c = await tutorA.call('POST', '/api/clients', { name: 'Test ReDoS' });
  const token = c.data.invite_url.split('/zaproszenie/')[1];
  // Złośliwy „e-mail” (stary regex /^\S+@\S+\.\S+$/ liczyłby to kwadratowo długo).
  const evil = 'a@' + '.'.repeat(100000) + '!';
  const t0 = performance.now();
  const r = await agent().call('POST', `/api/invite/${token}`, { email: evil, password: 'bardzo-dlugie-haslo' });
  assert.equal(r.status, 400);
  assert.ok(performance.now() - t0 < 500, 'odpowiedź natychmiastowa');
  assert.equal((await agent().call('POST', `/api/invite/${token}`, { email: 'jan.kowalski@poczta.example.pl', password: 'bardzo-dlugie-haslo' })).status, 200, 'normalny e-mail z kropkami przechodzi');

  const st = srv.db.prepare('SELECT id FROM students WHERE client_id = ?').get(c.data.id).id;
  // Zdublowany parametr (?name=a&name=b) nie przechodzi jako tablica: nazwa wraca do domyślnej.
  const up = await tutorA.call('POST', `/api/materials/upload?student_id=${st}&name=a.txt&name=b.txt`, undefined, { raw: Buffer.from('abc') });
  assert.equal(up.status, 201);
  assert.equal(srv.db.prepare('SELECT file_name FROM materials WHERE id = ?').get(up.data.id).file_name, 'plik');
  // JSON zamiast pliku jest odrzucany (treść musi być Bufferem).
  const js = await tutorA.call('POST', `/api/materials/upload?student_id=${st}&name=x.txt`, { length: 5 });
  assert.equal(js.status, 400);

  const res = await fetch(`${base}/api/status`);
  assert.ok(res.headers.get('ratelimit-policy') || res.headers.get('ratelimit'), 'nagłówki limitów zapytań');
});

test('pentest: regresje naprawionych luk', async () => {
  const crypto = await import('node:crypto');
  const { verifyPassword } = await import('../src/auth.js');
  // Konto rodzica do testów
  const c = await tutorA.call('POST', '/api/clients', { name: 'Pentest' });
  const tok = c.data.invite_url.split('/zaproszenie/')[1];
  const pt = agent();
  assert.equal((await pt.call('POST', `/api/invite/${tok}`, { email: 'pt@example.com', password: 'Pentest-haslo-1' })).status, 200);
  const st = (await pt.call('GET', '/api/me')).data.students[0].id;

  // .ics: samotny CR w temacie nie tworzy nowych pól
  const day = local(Date.now() + 9 * 86400000).date;
  const slot = (await pt.call('GET', `/api/slots?from=${day}&to=${day}&minutes=60`)).data.slots[1];
  const b = await pt.call('POST', '/api/lessons', { student_id: st, start: slot.start, minutes: 60, topic: 'Matma\rATTENDEE:mailto:x@example.com' });
  assert.equal(b.status, 201);
  const me = (await pt.call('GET', '/api/me')).data;
  const ics = await (await fetch(me.ical_url.replace(/^https?:\/\/[^/]+/, base))).text();
  assert.ok(!ics.split(/\r\n|\r|\n/).some((l) => l.startsWith('ATTENDEE')), 'brak wstrzykniętego pola');

  // CSV: formuła z tematu jest neutralizowana apostrofem
  const past = local(Date.now() - 3 * 86400000);
  await tutorA.call('POST', '/api/lessons', { student_id: st, date: past.date, time: '06:00', minutes: 30, topic: '=HYPERLINK("https://x.example")' });
  const csv = (await tutorA.call('GET', `/api/reports/csv?year=${past.date.slice(0, 4)}`)).data;
  assert.match(csv, /"'=HYPERLINK/);
  assert.doesNotMatch(csv, /;"=/);

  // Limit miejsca na pliki rodziny (w teście 1 MB) i limit rezerwacji
  const small = createServer({ dataDir, db: openDb(':memory:'), setupCode: 'Q', clientStorageMb: 1, activityLog: false });
  await new Promise((r) => small.server.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${small.server.address().port}`;
  const h = { 'x-requested-with': 'wolne-korki', 'content-type': 'application/json' };
  let r = await fetch(`${b2}/api/setup`, { method: 'POST', headers: h, body: JSON.stringify({ code: 'Q', name: 'T', email: 't2@example.com', password: 'Tutor-haslo-12' }) });
  const tc = r.headers.get('set-cookie').split(';')[0];
  r = await fetch(`${b2}/api/clients`, { method: 'POST', headers: { ...h, cookie: tc }, body: JSON.stringify({ name: 'R' }) });
  const t2 = (await r.json()).invite_url.split('/zaproszenie/')[1];
  r = await fetch(`${b2}/api/invite/${t2}`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'r2@example.com', password: 'Rodzic-haslo-12' }) });
  const pc = r.headers.get('set-cookie').split(';')[0];
  const st2 = (await (await fetch(`${b2}/api/me`, { headers: { cookie: pc } })).json()).students[0].id;
  const up = (n) => fetch(`${b2}/api/materials/upload?student_id=${st2}&name=f${n}.bin`, { method: 'POST', headers: { 'x-requested-with': 'wolne-korki', 'content-type': 'application/octet-stream', cookie: pc }, body: Buffer.alloc(400 * 1024) });
  assert.equal((await up(1)).status, 201);
  assert.equal((await up(2)).status, 201);
  assert.equal((await up(3)).status, 413, 'trzeci plik przekracza 1 MB');
  await fetch(`${b2}/api/settings`, { method: 'PUT', headers: { ...h, cookie: tc }, body: JSON.stringify({ max_client_bookings: 2, min_notice_hours: 0 }) });
  await fetch(`${b2}/api/availability`, { method: 'PUT', headers: { ...h, cookie: tc }, body: JSON.stringify({ rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '08:00', end: '20:00' })) }) });
  const d2 = local(Date.now() + 4 * 86400000).date;
  const sl = (await (await fetch(`${b2}/api/slots?from=${d2}&to=${d2}&minutes=60`, { headers: { cookie: pc } })).json()).slots;
  const book = (s) => fetch(`${b2}/api/lessons`, { method: 'POST', headers: { ...h, cookie: pc }, body: JSON.stringify({ student_id: st2, start: s.start, minutes: 60 }) });
  assert.equal((await book(sl[0])).status, 201);
  assert.equal((await book(sl[8])).status, 201);
  assert.equal((await book(sl[16])).status, 409, 'trzecia rezerwacja ponad limit');
  small.close();

  // Nagłówki
  const hd = await fetch(`${base}/`);
  assert.equal(hd.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.doesNotMatch(hd.headers.get('content-security-policy'), /connect-src 'self' ws: wss:/);
  assert.equal((await fetch(`${base}/api/status`)).headers.get('cache-control'), 'no-store');

  // Stary format hasha działa i jest przeliczany do nowych parametrów przy logowaniu
  const salt = crypto.randomBytes(16);
  const legacy = `scrypt$${salt.toString('base64')}$${crypto.scryptSync('Stare-haslo-123', salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
  srv.db.prepare("UPDATE users SET pass_hash = ? WHERE email = 'pt@example.com'").run(legacy);
  assert.ok(verifyPassword('Stare-haslo-123', legacy));
  assert.equal((await agent().call('POST', '/api/login', { email: 'pt@example.com', password: 'Stare-haslo-123' })).status, 200);
  assert.match(srv.db.prepare("SELECT pass_hash FROM users WHERE email = 'pt@example.com'").get().pass_hash, /^scrypt\$16384\$8\$5\$/);
});

test('pentest: zalew pokoju lekcji (czat i rozmiar tablicy)', async () => {
  const day = local(Date.now() + 11 * 86400000);
  const st = srv.db.prepare("SELECT s.id FROM students s JOIN users u ON u.id = s.client_id WHERE u.email = 'p2@example.com'").get().id;
  const l = await tutorA.call('POST', '/api/lessons', { student_id: st, date: day.date, time: '18:00', minutes: 60 });
  const lessonId = l.data.created[0];
  const ws = new WebSocket(base.replace('http', 'ws') + `/ws?lesson=${lessonId}`, { headers: { cookie: parent2.cookie } });
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d)));
  await new Promise((r) => ws.on('open', r));
  for (let i = 0; i < 500; i++) ws.send(JSON.stringify({ t: 'chat', body: 'spam ' + i }));
  const big = (i) => ({ id: 'big' + i, type: 'freedraw', version: 1, versionNonce: 1, points: Array.from({ length: 150000 }, (_, k) => [k, k]) });
  for (let i = 0; i < 12; i++) ws.send(JSON.stringify({ t: 'xd', op: 'elements', elements: [big(i)] }));
  await new Promise((r) => setTimeout(r, 1500));
  ws.close();
  await new Promise((r) => setTimeout(r, 200));
  const chats = srv.db.prepare('SELECT COUNT(*) AS n FROM chat WHERE lesson_id = ?').get(lessonId).n;
  assert.ok(chats <= 15, `czat ograniczony (zapisano ${chats})`);
  const size = srv.db.prepare('SELECT length(whiteboard) AS n FROM lessons WHERE id = ?').get(lessonId).n;
  assert.ok(size <= 26 * 1024 * 1024, `tablica ograniczona (${(size / 1048576).toFixed(1)} MB)`);
  assert.ok(inbox.some((m) => m.t === 'notice'), 'użytkownik dostaje komunikat o pełnej tablicy');
});
