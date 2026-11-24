// Wspólne narzędzia frontendu: bezpieczne szablony HTML, API, formatowanie, okna dialogowe.

// ---------- szablony z automatycznym escapowaniem ----------
export class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const val = (v) => (v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : esc(v));
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += val(v) + strings[i + 1]; });
  return new Raw(out);
}
export function render(el, tpl) { el.innerHTML = tpl instanceof Raw ? tpl.s : esc(tpl); typeset(el); return el; }
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- stan aplikacji ----------
export const state = { me: null, settings: null, students: [], dues: null, icalUrl: '' };
export const isTutor = () => state.me?.role === 'tutor';

/** Wczytuje zalogowanego użytkownika i ustawienia do `state`. */
export async function loadMe() {
  try {
    const me = await api('/me');
    state.me = me.user;
    if (!me.user) return;
    state.settings = me.settings;
    state.students = me.students || [];
    state.dues = me.dues || null;
    state.icalUrl = me.ical_url;
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    state.me = null;
  }
}

// ---------- API ----------
export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

export async function api(path, { method = 'GET', body, file, query } = {}) {
  const headers = { 'x-requested-with': 'wolne-korki' };
  let payload;
  if (file) { headers['content-type'] = 'application/octet-stream'; payload = file; }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')) : '';
  const r = await fetch('/api' + path + qs, { method, headers, body: payload, credentials: 'same-origin' });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    if (r.status === 401 && !path.startsWith('/login') && !path.startsWith('/me')) location.hash = '#/logowanie';
    throw new ApiError((data && data.error) || 'Coś poszło nie tak.', r.status);
  }
  return data;
}

// ---------- czas i strefy ----------
const tz = () => state.settings?.timezone || 'Europe/Warsaw';
const fmtCache = new Map();
function dtf(opts) {
  const key = tz() + JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat('pl-PL', { timeZone: tz(), ...opts }));
  return fmtCache.get(key);
}
export const fmtTime = (ms) => dtf({ hour: '2-digit', minute: '2-digit' }).format(ms);
export const fmtDate = (ms) => dtf({ weekday: 'short', day: 'numeric', month: 'short' }).format(ms);
export const fmtDateLong = (ms) => dtf({ weekday: 'long', day: 'numeric', month: 'long' }).format(ms);
export const fmtDateFull = (ms) => dtf({ day: 'numeric', month: 'long', year: 'numeric' }).format(ms);
export const fmtDateTime = (ms) => `${fmtDate(ms)}, ${fmtTime(ms)}`;
export const fmtRange = (a, b) => `${fmtDate(a)}, ${fmtTime(a)}–${fmtTime(b)}`;
export const minutesOf = (l) => Math.round((l.end_at - l.start_at) / 60000);

const partsFmt = new Map();
const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
export function zonedParts(ms, zone = tz()) {
  if (!partsFmt.has(zone)) {
    partsFmt.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }));
  }
  const p = {};
  for (const { type, value } of partsFmt.get(zone).formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, weekday: WD[p.weekday], minutes: +p.hour * 60 + +p.minute };
}
function offsetMin(ms, zone) {
  const z = zonedParts(ms, zone);
  return Math.round((Date.UTC(z.y, z.m - 1, z.d, z.hour, z.minute, z.second) - Math.floor(ms / 1000) * 1000) / 60000);
}
export function zonedToUtc(y, m, d, minutes = 0, zone = tz()) {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  return guess - offsetMin(guess - offsetMin(guess, zone) * 60000, zone) * 60000;
}
export const dayKey = (p) => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
export const keyOf = (ms) => dayKey(zonedParts(ms));
export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return dayKey({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}
export function weekStart(key) {
  const [y, m, d] = key.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return addDays(key, 1 - wd);
}
export const keyToUtc = (key, minutes = 0) => { const [y, m, d] = key.split('-').map(Number); return zonedToUtc(y, m, d, minutes); };
export const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const todayKey = () => keyOf(Date.now());

// ---------- pieniądze ----------
const money = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' });
export const zl = (grosze) => money.format((grosze || 0) / 100);
export function parseZl(s) {
  const v = parseFloat(String(s ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(v) ? Math.round(v * 100) : null;
}
export const zlInput = (grosze) => (grosze == null ? '' : (grosze / 100).toFixed(2).replace('.', ',').replace(/,00$/, ''));

// ---------- prosty markdown + wzory ----------
export function md(src) {
  if (!src) return raw('');
  const lines = esc(src).split(/\r?\n/);
  const out = [];
  let list = null;
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  for (const line of lines) {
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) { if (!list) { list = []; } list.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`);
    else if (line.trim() === '') out.push('<br>');
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return raw(`<div class="md">${out.join('').replace(/(<br>)+$/, '')}</div>`);
}

/** Renderuje wzory LaTeX ($...$, $$...$$, \(...\), \[...\]) w elemencie. */
export function typeset(el) {
  if (!window.renderMathInElement || !el) return;
  try {
    window.renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'input'],
    });
  } catch { /* wzór z błędem zostaje jako tekst */ }
}

// ---------- komunikaty i okna ----------
export function toast(msg, kind = 'ok') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3700);
}
export const fail = (e) => toast(e.message || String(e), 'err');

/** Okno dialogowe z formularzem. onSubmit(formData, dialog) -> zamknięcie, jeśli nie rzuci błędu. */
export function dialog(title, body, { submit = 'Zapisz', onSubmit, danger = false, wide = false } = {}) {
  const d = document.createElement('dialog');
  d.className = wide ? 'wide' : '';
  render(d, html`
    <form method="dialog" class="dlg">
      <header><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Zamknij">✕</button></header>
      <div class="dlg-body">${body}</div>
      <p class="form-error" hidden></p>
      ${onSubmit ? html`<footer><button type="button" class="btn ghost" data-close>Anuluj</button><button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${submit}</button></footer>` : ''}
    </form>`);
  document.body.append(d);
  const form = $('form', d);
  const close = () => { d.close(); d.remove(); };
  $$('[data-close]', d).forEach((b) => b.addEventListener('click', close));
  d.addEventListener('cancel', () => setTimeout(() => d.remove(), 0));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!onSubmit) return close();
    const btn = $('button[value=ok]', d);
    btn.disabled = true;
    try {
      await onSubmit(new FormData(form), d);
      close();
    } catch (e) {
      const p = $('.form-error', d);
      p.textContent = e.message; p.hidden = false;
    } finally { btn.disabled = false; }
  });
  d.showModal();
  const first = $('input:not([type=hidden]), select, textarea', d);
  if (first) first.focus();
  return d;
}

export function confirmDialog(title, text, { submit = 'Tak', danger = true } = {}) {
  return new Promise((resolve) => {
    const d = dialog(title, html`<p>${text}</p>`, { submit, danger, onSubmit: () => resolve(true) });
    d.addEventListener('close', () => resolve(false));
  });
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Skopiowano do schowka.'); }
  catch {
    const d = dialog('Skopiuj ręcznie', html`<input class="input" value="${text}" readonly>`);
    $('input', d).select();
  }
}

export function days(n) { return n === 1 ? 'dzień' : 'dni'; }
export function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n === 1) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}
