// Router i układ strony.
import { api, state, html, render, $, isTutor, fail, loadMe } from './lib.js';
import * as auth from './views/auth.js';
import * as tutor from './views/tutor.js';
import * as client from './views/client.js';
import * as shared from './views/shared.js';

const routes = [
  ['/logowanie', auth.login, { public: true, bare: true }],
  ['/konfiguracja', auth.setup, { public: true, bare: true }],
  ['/zaproszenie/:token', auth.invite, { public: true, bare: true }],
  ['/', () => (isTutor() ? tutor.dashboard : client.dashboard), { resolve: true }],
  ['/kalendarz', tutor.calendar, { tutor: true }],
  ['/dostepnosc', tutor.availability, { tutor: true }],
  ['/uczniowie', tutor.clients, { tutor: true }],
  ['/uczniowie/:id', tutor.clientDetail, { tutor: true }],
  ['/raporty', tutor.reports, { tutor: true }],
  ['/ustawienia', tutor.settings, { tutor: true }],
  ['/rezerwuj', client.book],
  ['/lekcje', client.lessons],
  ['/lekcja/:id', shared.lesson],
  ['/materialy', shared.materials],
  ['/konto', shared.account],
  ['/pokoj/:id', (...a) => import('./room.js').then((m) => m.room(...a)), { bare: true, direct: true }],
];

function match(path) {
  for (const [pattern, view, opts = {}] of routes) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    const m = re.exec(path);
    if (m) return { view, opts, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

const NAV_TUTOR = [['/', 'Pulpit'], ['/kalendarz', 'Kalendarz'], ['/uczniowie', 'Uczniowie'], ['/dostepnosc', 'Dostępność'], ['/materialy', 'Materiały'], ['/raporty', 'Raporty'], ['/ustawienia', 'Ustawienia']];
const NAV_CLIENT = [['/', 'Pulpit'], ['/rezerwuj', 'Zarezerwuj'], ['/lekcje', 'Lekcje'], ['/materialy', 'Materiały']];

let cleanup = null;


function layout(path) {
  const nav = isTutor() ? NAV_TUTOR : NAV_CLIENT;
  const current = '/' + (path.split('/')[1] || '');
  const root = $('#root');
  render(root, html`
    <header class="topbar">
      <a class="brand" href="#/"><img src="/img/logo.svg" alt="" width="30" height="30"><span>${state.settings?.school_name || 'Wolne Korki'}</span></a>
      <nav class="nav" aria-label="Główna">
        ${nav.map(([href, label]) => html`<a href="#${href}" class="${current === href || (href === '/uczniowie' && current === '/uczniowie') ? 'active' : ''}" ${current === href ? html`aria-current="page"` : ''}>${label}</a>`)}
      </nav>
      <div class="userbox">
        <a href="#/konto" class="${current === '/konto' ? 'active' : ''}" title="Konto">${state.me.name}</a>
        <button class="btn ghost sm" id="logout">Wyloguj</button>
      </div>
    </header>
    <main id="main" class="container" tabindex="-1"></main>
    <footer class="foot">Wolne Korki · otwarte oprogramowanie na licencji MIT · dane zostają na Twoim serwerze</footer>`);
  $('#logout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    state.me = null;
    location.hash = '#/logowanie';
  });
  return $('#main');
}

async function route() {
  if (cleanup) { try { cleanup(); } catch { /* ignoruj */ } cleanup = null; }
  const path = location.hash.replace(/^#/, '') || '/';
  const m = match(path);
  if (!m) { location.hash = '#/'; return; }

  if (!m.opts.public && !state.me) {
    await loadMe().catch(fail);
    if (!state.me) {
      const st = await api('/status').catch(() => ({}));
      location.hash = st.setup_needed ? '#/konfiguracja' : '#/logowanie';
      return;
    }
  }
  if (m.opts.tutor && !isTutor()) { location.hash = '#/'; return; }

  document.body.className = m.opts.bare ? 'bare' : '';
  let target;
  if (m.opts.bare) { target = $('#root'); target.innerHTML = ''; } else target = layout(path);
  const view = m.opts.resolve ? m.view() : m.view;
  try {
    const out = await view(target, m.params);
    if (typeof out === 'function') cleanup = out;
  } catch (e) {
    console.error(e);
    render(target, html`<div class="card empty"><h2>Nie udało się wczytać strony</h2><p>${e.message}</p><a class="btn" href="#/">Wróć na pulpit</a></div>`);
  }
  if (!m.opts.bare) { window.scrollTo(0, 0); $('#main')?.focus({ preventScroll: true }); }
}

window.addEventListener('hashchange', route);
route();

// Linki z data-href (np. całe karty lekcji) działają jak zwykłe odnośniki.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-href]');
  if (el && !e.target.closest('a, button, input, select, textarea, label')) location.hash = el.dataset.href;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches?.('[data-href]')) location.hash = e.target.dataset.href;
});
