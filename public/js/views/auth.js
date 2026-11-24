// Logowanie, pierwsza konfiguracja, zaproszenie / reset hasła.
import { api, html, render, $, md, loadMe } from '../lib.js';

function shell(el, title, body, aside = '') {
  render(el, html`
    <div class="auth">
      <div class="auth-card card">
        <div class="auth-brand"><img src="/img/logo.svg" alt="" width="40" height="40"><span id="auth-school">Wolne Korki</span></div>
        <h1>${title}</h1>
        ${body}
      </div>
      ${aside}
    </div>`);
  api('/status').then((s) => { const n = $('#auth-school'); if (n && s.school_name) n.textContent = s.school_name; }).catch(() => {});
}

function bindForm(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    const err = $('.form-error', form);
    btn.disabled = true; err.hidden = true;
    try { await handler(new FormData(form)); } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { btn.disabled = false; }
  });
}

export async function login(el) {
  const st = await api('/status').catch(() => ({}));
  if (st.setup_needed) { location.hash = '#/konfiguracja'; return; }
  shell(el, 'Zaloguj się', html`
    <form class="stack">
      <label>E-mail<input class="input" type="email" name="email" autocomplete="username" required></label>
      <label>Hasło<input class="input" type="password" name="password" autocomplete="current-password" required></label>
      <p class="form-error" hidden></p>
      <button class="btn primary wide" type="submit">Zaloguj</button>
      <p class="muted small">Nie masz konta albo nie pamiętasz hasła? Poproś korepetytora o nowy link.</p>
    </form>`);
  bindForm($('form', el), async (fd) => {
    await api('/login', { method: 'POST', body: Object.fromEntries(fd) });
    await loadMe();
    location.hash = '#/';
  });
}

export async function setup(el) {
  const st = await api('/status').catch(() => ({}));
  if (!st.setup_needed) { location.hash = '#/logowanie'; return; }
  shell(el, 'Pierwsze uruchomienie', html`
    <p class="muted">Załóż konto korepetytora. Kod konfiguracji wyświetlił się w terminalu (albo w logach kontenera) przy starcie serwera.</p>
    <form class="stack">
      <label>Kod konfiguracji<input class="input mono" name="code" autocomplete="off" required></label>
      <label>Nazwa (widzą ją rodzice)<input class="input" name="school_name" placeholder="np. Matematyka z Olą" required></label>
      <label>Twoje imię<input class="input" name="name" autocomplete="name" required></label>
      <label>E-mail<input class="input" type="email" name="email" autocomplete="username" required></label>
      <label>Hasło (min. 10 znaków)<input class="input" type="password" name="password" minlength="10" autocomplete="new-password" required></label>
      <p class="form-error" hidden></p>
      <button class="btn primary wide" type="submit">Utwórz konto</button>
    </form>`);
  bindForm($('form', el), async (fd) => {
    await api('/setup', { method: 'POST', body: Object.fromEntries(fd) });
    await loadMe();
    location.hash = '#/dostepnosc';
  });
}

export async function invite(el, { token }) {
  let info;
  try { info = await api(`/invite/${encodeURIComponent(token)}`); } catch (e) {
    shell(el, 'Link nie działa', html`<p>${e.message}</p><a class="btn" href="#/logowanie">Przejdź do logowania</a>`);
    return;
  }
  shell(el, info.is_reset ? 'Ustaw nowe hasło' : `Witaj, ${info.name}!`, html`
    <p class="muted">${info.is_reset ? 'Wpisz nowe hasło do swojego konta.' : html`Załóż konto w <strong>${info.school_name}</strong>, żeby rezerwować lekcje, wchodzić na lekcje online i widzieć materiały.`}</p>
    <form class="stack">
      <label>E-mail<input class="input" type="email" name="email" value="${info.email || ''}" autocomplete="username" required></label>
      <label>Hasło (min. 10 znaków)<input class="input" type="password" name="password" minlength="10" autocomplete="new-password" required></label>
      ${info.is_reset ? '' : html`
        <details class="rules"><summary>Zasady lekcji</summary>${md(info.rules_text)}</details>
        <label class="check"><input type="checkbox" required> Znam zasady lekcji</label>`}
      <p class="form-error" hidden></p>
      <button class="btn primary wide" type="submit">${info.is_reset ? 'Zapisz hasło' : 'Załóż konto'}</button>
    </form>`);
  bindForm($('form', el), async (fd) => {
    await api(`/invite/${encodeURIComponent(token)}`, { method: 'POST', body: Object.fromEntries(fd) });
    await loadMe();
    location.hash = '#/';
  });
}
