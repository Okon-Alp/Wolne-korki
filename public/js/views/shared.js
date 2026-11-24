// Widoki wspólne: szczegóły lekcji, materiały, konto, karty lekcji.
import {
  api, html, render, $, $$, state, isTutor, md, zl, parseZl, zlInput, fmtRange, fmtDateFull, fmtTime, fmtDateTime,
  minutesOf, keyOf, hhmm, zonedParts, toast, fail, dialog, confirmDialog, copy, loadMe, typeset,
} from '../lib.js';

export function lessonStatus(l, now = Date.now()) {
  if (l.status === 'cancelled') return l.late_cancel ? ['Odwołana późno', 'warn'] : ['Odwołana', 'muted'];
  if (l.end_at <= now) return ['Odbyta', 'done'];
  if (l.start_at <= now) return ['Trwa teraz', 'live'];
  return ['Zaplanowana', 'plan'];
}

export const canJoin = (l, now = Date.now()) =>
  l.status === 'scheduled' && l.mode === 'online' && now >= l.start_at - 30 * 60000 && now <= l.end_at + 30 * 60000;

export function lessonCard(l, { showClient = isTutor(), showPaid = false } = {}) {
  const [label, kind] = lessonStatus(l);
  const due = (l.status === 'scheduled' && l.end_at <= Date.now()) || l.late_cancel;
  return html`
    <article class="lesson-card ${l.status === 'cancelled' ? 'is-cancelled' : ''}" data-href="#/lekcja/${l.id}" tabindex="0">
      <div class="lc-time"><strong>${fmtTime(l.start_at)}</strong><span>${dayLabel(l.start_at)}</span></div>
      <div class="lc-main">
        <div class="lc-title">${l.student_name}${showClient && l.client_name !== l.student_name ? html` <span class="muted">· ${l.client_name}</span>` : ''}</div>
        <div class="lc-sub">${l.topic ? html`${l.topic} · ` : ''}${minutesOf(l)} min · ${l.mode === 'online' ? 'online' : l.location || 'stacjonarnie'}</div>
      </div>
      <div class="lc-side">
        ${canJoin(l) ? html`<a class="btn primary sm" href="#/pokoj/${l.id}">Wejdź</a>` : html`<span class="badge ${kind}">${label}</span>`}
        ${showPaid && due && l.price > 0 ? html`<span class="badge ${l.paid ? 'done' : 'warn'}">${l.paid ? 'opłacona' : zl(l.price)}</span>` : ''}
      </div>
    </article>`;
}

function dayLabel(ms) {
  const k = keyOf(ms);
  const today = keyOf(Date.now());
  const tomorrow = keyOf(Date.now() + 86400000);
  if (k === today) return 'dziś';
  if (k === tomorrow) return 'jutro';
  return new Intl.DateTimeFormat('pl-PL', { timeZone: state.settings.timezone, weekday: 'short', day: 'numeric', month: 'short' }).format(ms);
}

export function countdowns() {
  const list = (state.settings?.countdowns || [])
    .map((c) => ({ ...c, days: Math.ceil((Date.parse(c.date + 'T00:00:00') - Date.now()) / 86400000) }))
    .filter((c) => c.days >= 0);
  if (!list.length) return '';
  return html`<div class="countdowns">${list.map((c) => html`
    <div class="countdown"><strong>${c.days}</strong><span>${c.days === 1 ? 'dzień' : 'dni'} do: ${c.label}</span></div>`)}</div>`;
}

// ---------- materiały ----------

const icon = (mime) => (mime?.startsWith('image/') ? '🖼' : mime === 'application/pdf' ? '📄' : '📎');
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

export function materialItem(m, { showStudent = false } = {}) {
  const mine = m.uploaded_by === state.me.id;
  const canDelete = isTutor() || mine;
  return html`
    <li class="material" data-id="${m.id}">
      <div class="material-head">
        <div>
          <strong>${m.title}</strong>
          <div class="muted small">${fmtDateTime(m.created_at)}${showStudent ? html` · ${m.student_name}` : ''}${isTutor() && !mine ? ' · od ucznia/rodzica' : !isTutor() && mine ? ' · dodane przez Ciebie' : ''}${m.lesson_id && showStudent && m.lesson_start ? html` · <a href="#/lekcja/${m.lesson_id}">lekcja ${fmtDateFull(m.lesson_start)}</a>` : ''}</div>
        </div>
        ${canDelete ? html`<button class="icon-btn" data-del="${m.id}" title="Usuń" aria-label="Usuń materiał">🗑</button>` : ''}
      </div>
      ${m.body ? md(m.body) : ''}
      ${m.file_name ? html`
        ${m.mime?.startsWith('image/') ? html`<a href="/api/materials/${m.id}/file" target="_blank" rel="noopener"><img class="thumb" src="/api/materials/${m.id}/file" alt="${m.title}" loading="lazy"></a>` : ''}
        <div class="file"><span>${icon(m.mime)}</span><a href="/api/materials/${m.id}/file" target="_blank" rel="noopener">${m.file_name}</a><span class="muted small">${kb(m.size)}</span><a class="small" href="/api/materials/${m.id}/file?download">pobierz</a></div>` : ''}
    </li>`;
}

export function bindMaterialDeletes(root, onChange) {
  $$('[data-del]', root).forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Usunąć materiał?', 'Tej operacji nie da się cofnąć.', { submit: 'Usuń' }))) return;
    try { await api(`/materials/${b.dataset.del}`, { method: 'DELETE' }); toast('Usunięto.'); onChange(); } catch (e) { fail(e); }
  }));
}

export async function uploadFiles(files, target) {
  for (const f of files) {
    await api('/materials/upload', { method: 'POST', file: f, query: { ...target, name: f.name, mime: f.type || 'application/octet-stream' } });
  }
}

function addMaterialDialog(target, onDone, { students } = {}) {
  dialog('Dodaj materiał', html`
    <div class="stack">
      ${students ? html`<label>Uczeń<select class="input" name="student_id" required>${students.map((s) => html`<option value="${s.id}">${s.name}${s.client_name ? html` (${s.client_name})` : ''}</option>`)}</select></label>` : ''}
      <label>Tytuł<input class="input" name="title" placeholder="np. Zadania na wtorek"></label>
      <label>Treść <span class="muted small">(opcjonalnie; wzory w $…$, np. $x^2+1$)</span><textarea class="input" name="body" rows="6"></textarea></label>
      <label>Pliki <span class="muted small">(opcjonalnie: zdjęcia, PDF, dokumenty)</span><input class="input" type="file" name="files" multiple></label>
    </div>`, {
    submit: 'Dodaj',
    onSubmit: async (fd) => {
      const t = { ...target };
      if (fd.get('student_id')) t.student_id = fd.get('student_id');
      const files = fd.getAll('files').filter((f) => f && f.size);
      const title = String(fd.get('title') || '').trim();
      const body = String(fd.get('body') || '').trim();
      if (!files.length && !body) throw new Error('Dodaj treść albo plik.');
      if (body || !files.length) await api('/materials', { method: 'POST', body: { ...t, title: title || 'Notatka', body } });
      if (files.length) await uploadFiles(files, { ...t, title: files.length === 1 && title && !body ? title : '' });
      toast('Dodano materiał.');
      onDone();
    },
  });
}

export async function materials(el) {
  const tutorMode = isTutor();
  let students = state.students;
  if (tutorMode) {
    const { clients } = await api('/clients');
    students = clients.flatMap((c) => c.students.map((s) => ({ ...s, client_name: c.name })));
  }
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  let current = params.get('uczen') || '';

  async function draw() {
    const { materials: list } = await api('/materials', { query: { student_id: current } });
    render(el, html`
      <div class="page-head">
        <h1>Materiały</h1>
        <div class="row">
          ${students.length > 1 ? html`<select class="input" id="filter" aria-label="Uczeń"><option value="">Wszyscy uczniowie</option>${students.map((s) => html`<option value="${s.id}" ${String(s.id) === current ? 'selected' : ''}>${s.name}</option>`)}</select>` : ''}
          ${students.length ? html`<button class="btn primary" id="add">Dodaj</button>` : ''}
        </div>
      </div>
      ${list.length ? html`<ul class="materials">${list.map((m) => materialItem(m, { showStudent: true }))}</ul>`
        : html`<div class="card empty"><p>${tutorMode ? 'Tu pojawią się notatki, zadania i pliki dla uczniów. Zapisane tablice z lekcji też tu trafiają.' : 'Tu pojawią się notatki i materiały od korepetytora. Możesz też dodać zdjęcie pracy domowej.'}</p></div>`}`);
    $('#filter')?.addEventListener('change', (e) => { current = e.target.value; draw().catch(fail); });
    $('#add')?.addEventListener('click', () => addMaterialDialog(
      current ? { student_id: current } : students.length === 1 ? { student_id: students[0].id } : {},
      () => draw().catch(fail),
      { students: !current && students.length > 1 ? students : null },
    ));
    bindMaterialDeletes(el, () => draw().catch(fail));
  }
  await draw();
}

// ---------- szczegóły lekcji ----------

export async function lesson(el, { id }) {
  const tutorMode = isTutor();

  async function draw() {
    const { lesson: l, materials: mats, cancel } = await api(`/lessons/${id}`);
    const [label, kind] = lessonStatus(l);
    const past = l.end_at <= Date.now();
    render(el, html`
      <a class="back" href="${tutorMode ? '#/kalendarz' : '#/lekcje'}">← ${tutorMode ? 'Kalendarz' : 'Lekcje'}</a>
      <div class="page-head">
        <div>
          <h1>${l.student_name}${l.topic ? html`: <span class="thin">${l.topic}</span>` : ''}</h1>
          <p class="lead">${fmtRange(l.start_at, l.end_at)} · ${minutesOf(l)} min · ${l.mode === 'online' ? 'online' : l.location || 'stacjonarnie'}</p>
        </div>
        <span class="badge lg ${kind}">${label}</span>
      </div>

      <div class="grid-2">
        <section class="card">
          ${l.status === 'scheduled' && l.mode === 'online' && !past ? html`
            <a class="btn primary big wide" href="#/pokoj/${l.id}">Wejdź na lekcję</a>
            <p class="muted small center">Kamera, mikrofon, tablica i czat działają w przeglądarce.${state.settings.external_meeting_url ? html` Zapasowo: <a href="${state.settings.external_meeting_url}" target="_blank" rel="noopener">zewnętrzne wideo</a>.` : ''}</p>` : ''}
          ${l.status === 'scheduled' && l.mode === 'online' && past ? html`<a class="btn wide" href="#/pokoj/${l.id}">Otwórz tablicę z lekcji</a>` : ''}
          <dl class="facts">
            ${tutorMode ? html`<dt>Klient</dt><dd><a href="#/uczniowie/${l.client_id}">${l.client_name}</a></dd>` : ''}
            <dt>Cena</dt><dd>${zl(l.price)}${l.late_cancel ? ' (opłata za późne odwołanie)' : ''}</dd>
            <dt>Płatność</dt><dd>${l.paid ? html`<span class="badge done">opłacona</span>` : l.status === 'cancelled' && !l.late_cancel ? 'nie dotyczy' : html`<span class="badge warn">nieopłacona</span>`}</dd>
          </dl>
          <div class="row wrap">
            ${tutorMode ? html`
              <button class="btn" id="edit">Zmień termin / szczegóły</button>
              ${l.status === 'scheduled' || l.late_cancel ? html`<button class="btn" id="paid">${l.paid ? 'Oznacz jako nieopłaconą' : 'Oznacz jako opłaconą'}</button>` : ''}
              ${l.status === 'cancelled' ? html`<button class="btn" id="restore">Przywróć lekcję</button>` : ''}` : ''}
            ${cancel.allowed ? html`<button class="btn danger-ghost" id="cancel">Odwołaj lekcję</button>` : ''}
            ${tutorMode ? html`<button class="btn danger-ghost" id="delete">Usuń</button>` : ''}
          </div>
        </section>

        <section class="card">
          <h2>Po lekcji</h2>
          ${tutorMode ? html`
            <form id="notes" class="stack">
              <label>Notatka dla ucznia i rodzica<textarea class="input" name="summary" rows="4" placeholder="Co przerobiliśmy, na co uważać… Wzory: $\\frac{a}{b}$">${l.summary || ''}</textarea></label>
              <label>Praca domowa<textarea class="input" name="homework" rows="3">${l.homework || ''}</textarea></label>
              <label>Prywatne notatki <span class="muted small">(widzisz tylko Ty)</span><textarea class="input" name="tutor_notes" rows="2">${l.tutor_notes || ''}</textarea></label>
              <button class="btn primary" type="submit">Zapisz notatki</button>
            </form>`
            : html`
              ${l.summary ? html`<h3>Notatka</h3>${md(l.summary)}` : ''}
              ${l.homework ? html`<h3>Praca domowa</h3>${md(l.homework)}` : ''}
              ${!l.summary && !l.homework ? html`<p class="muted">Notatka pojawi się tu po lekcji.</p>` : ''}`}
        </section>
      </div>

      <section class="card">
        <div class="section-head"><h2>Materiały do tej lekcji</h2><button class="btn sm" id="add-mat">Dodaj</button></div>
        ${mats.length ? html`<ul class="materials">${mats.map((m) => materialItem({ ...m, student_name: l.student_name }))}</ul>` : html`<p class="muted">Brak materiałów. ${tutorMode ? 'Zapisana tablica z lekcji też trafi tutaj.' : 'Możesz dodać zdjęcie pracy domowej.'}</p>`}
      </section>

      <details class="card" id="chat-box"><summary><h2 class="inline">Czat z lekcji</h2></summary><div id="chat-log" class="chat-log"><p class="muted">Ładowanie…</p></div></details>`);

    $('#add-mat').addEventListener('click', () => addMaterialDialog({ lesson_id: l.id }, () => draw().catch(fail)));
    bindMaterialDeletes(el, () => draw().catch(fail));
    $('#chat-box').addEventListener('toggle', async (e) => {
      if (!e.target.open) return;
      const { messages } = await api(`/lessons/${l.id}/chat`);
      render($('#chat-log'), messages.length
        ? html`${messages.map((m) => html`<div class="msg"><span class="muted small">${fmtTime(m.at)} ${m.name || '—'}:</span> ${m.body}</div>`)}`
        : html`<p class="muted">Na tej lekcji nikt nic nie napisał.</p>`);
    }, { once: true });

    $('#cancel')?.addEventListener('click', () => {
      const text = tutorMode
        ? 'Lekcja zostanie odwołana bez opłaty. Termin zwolni się w kalendarzu.'
        : cancel.late
          ? `Do lekcji zostało mniej niż ${state.settings.cancel_hours} h, więc według zasad odwołanie kosztuje ${zl(cancel.fee)}.`
          : 'Odwołanie jest bezpłatne. Termin zwolni się dla innych.';
      confirmDialog('Odwołać lekcję?', text, { submit: 'Odwołaj' }).then(async (ok) => {
        if (!ok) return;
        try { await api(`/lessons/${l.id}/cancel`, { method: 'POST' }); toast('Lekcja odwołana.'); if (!tutorMode) await loadMe(); draw().catch(fail); } catch (e) { fail(e); }
      });
    });

    if (!tutorMode) return;
    $('#notes').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api(`/lessons/${l.id}`, { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) }); toast('Zapisano notatki.'); } catch (ex) { fail(ex); }
    });
    $('#paid')?.addEventListener('click', async () => {
      try { await api(`/lessons/${l.id}`, { method: 'PATCH', body: { paid: !l.paid } }); draw().catch(fail); } catch (e) { fail(e); }
    });
    $('#restore')?.addEventListener('click', async () => {
      try { await api(`/lessons/${l.id}`, { method: 'PATCH', body: { restore: true } }); toast('Przywrócono.'); draw().catch(fail); } catch (e) { fail(e); }
    });
    $('#delete').addEventListener('click', async () => {
      if (!(await confirmDialog('Usunąć lekcję?', 'Lekcja zniknie z historii i raportów razem z materiałami. Jeśli lekcja się nie odbyła, lepiej ją odwołać.', { submit: 'Usuń na zawsze' }))) return;
      try { await api(`/lessons/${l.id}`, { method: 'DELETE' }); toast('Usunięto.'); location.hash = '#/kalendarz'; } catch (e) { fail(e); }
    });
    $('#edit').addEventListener('click', () => {
      const z = zonedParts(l.start_at);
      dialog('Szczegóły lekcji', html`
        <div class="stack">
          <div class="row"><label class="grow">Data<input class="input" type="date" name="date" value="${keyOf(l.start_at)}" required></label>
            <label>Godzina<input class="input" type="time" name="time" value="${hhmm(z.minutes)}" step="300" required></label>
            <label>Minuty<input class="input" type="number" name="minutes" value="${minutesOf(l)}" min="15" max="600" step="5" required></label></div>
          <label>Temat<input class="input" name="topic" value="${l.topic || ''}"></label>
          <div class="row"><label class="grow">Forma<select class="input" name="mode"><option value="online" ${l.mode === 'online' ? 'selected' : ''}>online</option><option value="onsite" ${l.mode === 'onsite' ? 'selected' : ''}>stacjonarnie</option></select></label>
            <label class="grow">Miejsce<input class="input" name="location" value="${l.location || ''}" placeholder="dla lekcji stacjonarnych"></label></div>
          <label>Cena (zł)<input class="input" name="price" inputmode="decimal" value="${zlInput(l.price)}"></label>
        </div>`, {
        onSubmit: async (fd) => {
          const body = Object.fromEntries(fd);
          body.price = parseZl(body.price) ?? 0;
          body.minutes = +body.minutes;
          await api(`/lessons/${l.id}`, { method: 'PATCH', body });
          toast('Zapisano.');
          draw().catch(fail);
        },
      });
    });
  }
  await draw();
}

// ---------- konto ----------

export async function account(el) {
  render(el, html`
    <h1>Konto</h1>
    <div class="grid-2">
      <section class="card">
        <h2>${state.me.name}</h2>
        <p class="muted">${state.me.email}</p>
        <form id="pw" class="stack">
          <h3>Zmień hasło</h3>
          <label>Obecne hasło<input class="input" type="password" name="current" autocomplete="current-password" required></label>
          <label>Nowe hasło (min. 10 znaków)<input class="input" type="password" name="next" minlength="10" autocomplete="new-password" required></label>
          <button class="btn" type="submit">Zmień hasło</button>
        </form>
      </section>
      <section class="card">
        <h2>Kalendarz w telefonie</h2>
        <p>Dodaj ten adres jako subskrypcję w Kalendarzu Google, iPhone albo Thunderbirdzie, a lekcje będą się same pojawiać.</p>
        <div class="copyline"><input class="input mono" readonly value="${state.icalUrl}" id="ical"><button class="btn" id="copy-ical">Kopiuj</button></div>
        <p class="muted small">Adres działa bez logowania, więc nie udostępniaj go nikomu. Jeśli wyciekł, <button class="linklike" id="reset-ical">wygeneruj nowy</button>.</p>
        ${isTutor() ? '' : html`
          <h3>Twoje dane</h3>
          <p class="small">Dane trzyma korepetytor na swoim serwerze: imię, e-mail, lekcje, notatki i materiały. Nie ma tu reklam ani śledzenia. Jeśli chcesz, żeby wszystko zostało usunięte, napisz do korepetytora. Usunięcie konta kasuje też lekcje i materiały.</p>`}
      </section>
    </div>`);
  $('#copy-ical').addEventListener('click', () => copy(state.icalUrl));
  $('#reset-ical').addEventListener('click', async () => {
    if (!(await confirmDialog('Nowy adres kalendarza?', 'Stary adres przestanie działać. Trzeba będzie dodać subskrypcję od nowa.', { submit: 'Wygeneruj', danger: false }))) return;
    const r = await api('/me/ical-reset', { method: 'POST' });
    state.icalUrl = r.ical_url;
    $('#ical').value = r.ical_url;
    toast('Nowy adres gotowy.');
  });
  $('#pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/me/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast('Hasło zmienione.'); } catch (ex) { fail(ex); }
  });
}

