// Panel rodzica / ucznia.
import {
  api, html, render, $, $$, state, md, zl, fmtTime, fmtDateLong, fmtRange, toast, fail, dialog, loadMe,
  weekStart, addDays, todayKey, keyToUtc, keyOf, plural,
} from '../lib.js';
import { lessonCard, countdowns, canJoin, materialItem } from './shared.js';

export async function dashboard(el) {
  await loadMe();
  const now = Date.now();
  const [{ lessons }, { materials }] = await Promise.all([
    api('/lessons', { query: { from: now - 3 * 3600000, to: now + 60 * 86400000, status: 'scheduled' } }),
    api('/materials'),
  ]);
  const upcoming = lessons.filter((l) => l.end_at > now);
  const next = upcoming[0];
  const d = state.dues || {};
  const s = state.settings;
  render(el, html`
    <div class="page-head"><h1>Dzień dobry, ${state.me.name.split(' ')[0]}!</h1>
      ${s.allow_client_booking && state.students.length ? html`<a class="btn primary" href="#/rezerwuj">Zarezerwuj lekcję</a>` : ''}</div>
    ${countdowns()}
    ${d.due > 0 ? html`
      <section class="card notice warn">
        <div><strong>Do zapłaty: ${zl(d.due)}</strong> <span class="muted">(${d.due_count} ${plural(d.due_count, 'lekcja', 'lekcje', 'lekcji')})</span></div>
        ${s.payment_info ? md(s.payment_info) : ''}
      </section>` : ''}
    ${d.credit > 0 ? html`<section class="card notice"><strong>Nadpłata: ${zl(d.credit)}</strong> <span class="muted">za odwołane, wcześniej opłacone lekcje. Korepetytor rozliczy ją przy kolejnej płatności.</span></section>` : ''}

    ${next ? html`
      <section class="card next-lesson">
        <div>
          <p class="eyebrow">Najbliższa lekcja</p>
          <h2>${fmtDateLong(next.start_at)}, ${fmtTime(next.start_at)}</h2>
          <p class="muted">${next.student_name}${next.topic ? html` · ${next.topic}` : ''} · ${next.mode === 'online' ? 'online' : next.location || 'stacjonarnie'}</p>
        </div>
        <div class="row">
          ${canJoin(next) ? html`<a class="btn primary big" href="#/pokoj/${next.id}">Wejdź na lekcję</a>` : html`<a class="btn" href="#/lekcja/${next.id}">Szczegóły</a>`}
        </div>
      </section>` : html`
      <section class="card empty">
        <h2>Brak zaplanowanych lekcji</h2>
        ${s.allow_client_booking ? html`<p>Wybierz wolny termin, który Ci pasuje.</p><a class="btn primary" href="#/rezerwuj">Zobacz wolne terminy</a>` : html`<p>Korepetytor doda lekcje do kalendarza.</p>`}
      </section>`}

    <div class="grid-2">
      <section>
        <div class="section-head"><h2>Nadchodzące</h2><a href="#/lekcje">Wszystkie lekcje</a></div>
        ${upcoming.length > 1 ? html`<div class="list">${upcoming.slice(1, 8).map((l) => lessonCard(l))}</div>` : html`<p class="muted">Nic więcej w kalendarzu.</p>`}
      </section>
      <section>
        <div class="section-head"><h2>Ostatnie materiały</h2><a href="#/materialy">Wszystkie</a></div>
        ${materials.length ? html`<ul class="materials compact">${materials.slice(0, 3).map((m) => materialItem(m, { showStudent: state.students.length > 1 }))}</ul>` : html`<p class="muted">Jeszcze nic tu nie ma.</p>`}
      </section>
    </div>
    ${s.rules_text ? html`<details class="card rules"><summary>Zasady lekcji</summary>${md(s.rules_text)}</details>` : ''}`);
}

export async function lessons(el) {
  const now = Date.now();
  const { lessons: all } = await api('/lessons', { query: { from: now - 365 * 86400000, to: now + 365 * 86400000 } });
  const upcoming = all.filter((l) => l.end_at > now && l.status === 'scheduled');
  const past = all.filter((l) => !(l.end_at > now && l.status === 'scheduled')).reverse();
  render(el, html`
    <div class="page-head"><h1>Lekcje</h1>${state.settings.allow_client_booking ? html`<a class="btn primary" href="#/rezerwuj">Zarezerwuj</a>` : ''}</div>
    <section><h2>Nadchodzące</h2>
      ${upcoming.length ? html`<div class="list">${upcoming.map((l) => lessonCard(l))}</div>` : html`<p class="muted">Brak zaplanowanych lekcji.</p>`}</section>
    <section><h2>Historia</h2>
      ${past.length ? html`<div class="list">${past.map((l) => lessonCard(l, { showPaid: true }))}</div>` : html`<p class="muted">Tu pojawią się odbyte lekcje z notatkami.</p>`}</section>`);
}

export async function book(el) {
  const s = state.settings;
  if (!s.allow_client_booking) {
    render(el, html`<div class="card empty"><h2>Rezerwacje są wyłączone</h2><p>Korepetytor sam dodaje lekcje do kalendarza.</p></div>`);
    return;
  }
  if (!state.students.length) {
    render(el, html`<div class="card empty"><h2>Brak przypisanego ucznia</h2><p>Poproś korepetytora o dodanie ucznia do Twojego konta.</p></div>`);
    return;
  }
  let student = state.students[0];
  let minutes = s.durations[0].minutes;
  let week = weekStart(todayKey());
  const lastDay = keyOf(Date.now() + s.horizon_days * 86400000);

  async function draw() {
    const from = week;
    const to = addDays(week, 6);
    const { slots } = await api('/slots', { query: { from, to, minutes } });
    const byDay = new Map();
    for (let i = 0; i < 7; i++) byDay.set(addDays(week, i), []);
    for (const sl of slots) byDay.get(keyOf(sl.start))?.push(sl);
    const price = student.prices.find((p) => p.minutes === minutes)?.price ?? 0;
    const dayName = (k) => new Intl.DateTimeFormat('pl-PL', { timeZone: s.timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(keyToUtc(k, 720));
    render(el, html`
      <h1>Zarezerwuj lekcję</h1>
      <div class="card booking-opts">
        ${state.students.length > 1 ? html`
          <div class="opt"><span class="opt-label">Dla kogo</span><div class="chips" role="radiogroup">
            ${state.students.map((st) => html`<button class="chip ${st.id === student.id ? 'on' : ''}" data-student="${st.id}" role="radio" aria-checked="${st.id === student.id}">${st.name}</button>`)}</div></div>` : ''}
        <div class="opt"><span class="opt-label">Długość</span><div class="chips" role="radiogroup">
          ${student.prices.map((p) => html`<button class="chip ${p.minutes === minutes ? 'on' : ''}" data-min="${p.minutes}" role="radio" aria-checked="${p.minutes === minutes}">${p.minutes} min · ${zl(p.price)}</button>`)}</div></div>
      </div>
      <div class="week-nav">
        <button class="btn sm" id="prev" ${week <= weekStart(todayKey()) ? 'disabled' : ''} aria-label="Poprzedni tydzień">←</button>
        <strong>${fmtShort(from)} – ${fmtShort(to)}</strong>
        <button class="btn sm" id="next" ${addDays(week, 7) > lastDay ? 'disabled' : ''} aria-label="Następny tydzień">→</button>
      </div>
      <div class="slot-days">
        ${[...byDay.entries()].filter(([k]) => k >= todayKey()).map(([k, list]) => html`
          <section class="slot-day ${list.length ? '' : 'empty'}">
            <h3>${dayName(k)}</h3>
            ${list.length ? html`<div class="chips">${list.map((sl) => html`<button class="chip slot" data-start="${sl.start}">${fmtTime(sl.start)}</button>`)}</div>` : html`<p class="muted small">brak wolnych terminów</p>`}
          </section>`)}
      </div>
      ${slots.length === 0 ? html`<p class="muted center">W tym tygodniu nie ma wolnych terminów. Sprawdź następny tydzień.</p>` : ''}`);

    $$('[data-student]', el).forEach((b) => b.addEventListener('click', () => { student = state.students.find((x) => x.id === +b.dataset.student); draw().catch(fail); }));
    $$('[data-min]', el).forEach((b) => b.addEventListener('click', () => { minutes = +b.dataset.min; draw().catch(fail); }));
    $('#prev')?.addEventListener('click', () => { week = addDays(week, -7); draw().catch(fail); });
    $('#next')?.addEventListener('click', () => { week = addDays(week, 7); draw().catch(fail); });
    $$('[data-start]', el).forEach((b) => b.addEventListener('click', () => {
      const start = +b.dataset.start;
      dialog('Potwierdź rezerwację', html`
        <div class="stack">
          <p class="lead">${fmtRange(start, start + minutes * 60000)}</p>
          <p>${student.name} · ${minutes} min · <strong>${zl(price)}</strong></p>
          <label>Czego dotyczy lekcja? <span class="muted small">(opcjonalnie)</span><input class="input" name="topic" placeholder="np. funkcja kwadratowa, sprawdzian w piątek"></label>
          <p class="muted small">Bezpłatne odwołanie do ${s.cancel_hours} h przed lekcją${s.late_cancel_fee_pct ? `, później ${s.late_cancel_fee_pct === 100 ? 'pełna opłata' : `${s.late_cancel_fee_pct}% ceny`}` : ''}.</p>
        </div>`, {
        submit: 'Rezerwuję',
        onSubmit: async (fd) => {
          const r = await api('/lessons', { method: 'POST', body: { student_id: student.id, start, minutes, topic: fd.get('topic') } });
          toast('Zarezerwowano! Lekcja jest w kalendarzu.');
          location.hash = `#/lekcja/${r.created[0]}`;
        },
      });
    }));
  }

  function fmtShort(k) {
    return new Intl.DateTimeFormat('pl-PL', { timeZone: s.timezone, day: 'numeric', month: 'short' }).format(keyToUtc(k, 720));
  }

  await draw();
}
