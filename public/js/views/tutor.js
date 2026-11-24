// Panel korepetytora.
import {
  api, html, render, $, $$, state, zl, parseZl, zlInput, fmtTime, fmtDate, fmtDateFull, fmtRange,
  minutesOf, keyOf, keyToUtc, addDays, weekStart, todayKey, hhmm, zonedParts, toast, fail, dialog,
  confirmDialog, copy, loadMe, plural,
} from '../lib.js';
import { lessonCard, countdowns, lessonStatus } from './shared.js';

const WEEKDAYS = ['', 'Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota', 'Niedziela'];
const WD_SHORT = ['', 'pon', 'wt', 'śr', 'czw', 'pt', 'sob', 'nd'];

async function allStudents() {
  const { clients } = await api('/clients');
  return clients.flatMap((c) => c.students.filter((s) => s.active).map((s) => ({ ...s, client_name: c.name })));
}

/** Okno dodawania lekcji (z opcją powtarzania co tydzień). */
export async function addLessonDialog({ date = todayKey(), time = '16:00', studentId = null, onDone } = {}) {
  const students = await allStudents();
  if (!students.length) {
    dialog('Najpierw dodaj ucznia', html`<p>Lekcja musi być przypisana do ucznia.</p><a class="btn primary" href="#/uczniowie">Przejdź do uczniów</a>`);
    return;
  }
  const s = state.settings;
  dialog('Nowa lekcja', html`
    <div class="stack">
      <label>Uczeń<select class="input" name="student_id" required>
        ${students.map((st) => html`<option value="${st.id}" ${st.id === studentId ? 'selected' : ''}>${st.name}${st.client_name !== st.name ? html` (${st.client_name})` : ''}</option>`)}</select></label>
      <div class="row">
        <label class="grow">Data<input class="input" type="date" name="date" value="${date}" required></label>
        <label>Godzina<input class="input" type="time" name="time" value="${time}" step="300" required></label>
      </div>
      <div class="row">
        <label class="grow">Długość<select class="input" name="minutes">
          ${[...new Set([...s.durations.map((d) => d.minutes), 45, 60, 90, 120])].sort((a, b) => a - b).map((m) => html`<option value="${m}" ${m === s.durations[0].minutes ? 'selected' : ''}>${m} min</option>`)}</select></label>
        <label class="grow">Cena (zł)<input class="input" name="price" inputmode="decimal" placeholder="z cennika"></label>
      </div>
      <label>Temat <span class="muted small">(opcjonalnie)</span><input class="input" name="topic"></label>
      <div class="row">
        <label class="grow">Forma<select class="input" name="mode"><option value="online">online</option><option value="onsite">stacjonarnie</option></select></label>
        <label class="grow">Powtarzaj<select class="input" name="repeat_weeks">
          <option value="1">jednorazowo</option>${[4, 8, 12, 16, 20, 26, 40].map((n) => html`<option value="${n}">co tydzień, ${n} razy</option>`)}</select></label>
      </div>
      <label>Miejsce <span class="muted small">(dla lekcji stacjonarnych)</span><input class="input" name="location"></label>
    </div>`, {
    submit: 'Dodaj lekcję',
    onSubmit: async (fd) => {
      const body = Object.fromEntries(fd);
      body.price = body.price ? parseZl(body.price) : null;
      body.minutes = +body.minutes;
      body.repeat_weeks = +body.repeat_weeks;
      const r = await api('/lessons', { method: 'POST', body });
      if (r.conflicts.length) {
        toast(`Dodano ${r.created.length}. Pominięto ${r.conflicts.length} (kolizje): ${r.conflicts.map((c) => fmtDate(c)).join(', ')}`, 'warn');
      } else toast(r.created.length > 1 ? `Dodano ${r.created.length} lekcji.` : 'Dodano lekcję.');
      onDone?.(r);
    },
  });
}

// ---------- pulpit ----------

export async function dashboard(el) {
  const d = await api('/dashboard');
  const today = d.upcoming.filter((l) => keyOf(l.start_at) === todayKey());
  const later = d.upcoming.filter((l) => keyOf(l.start_at) !== todayKey());
  const q = d.quarter;
  const pct = q.limit ? Math.min(100, Math.round((q.revenue / q.limit) * 100)) : 0;
  const onboarding = !d.has_availability || d.client_count === 0;
  const settleTotal = d.to_settle.reduce((a, l) => a + l.price, 0);

  render(el, html`
    <div class="page-head">
      <h1>Dzień dobry, ${state.me.name.split(' ')[0]}!</h1>
      <div class="row"><button class="btn" id="add-client">Dodaj ucznia</button><button class="btn primary" id="add-lesson">Dodaj lekcję</button></div>
    </div>
    ${onboarding ? html`
      <section class="card steps">
        <h2>Na start</h2>
        <ol>
          <li class="${d.has_availability ? 'done' : ''}"><a href="#/dostepnosc">Zaznacz godziny, w których uczysz</a>, żeby rodzice widzieli wolne terminy.</li>
          <li class="${d.client_count ? 'done' : ''}"><a href="#/uczniowie">Dodaj ucznia</a> i wyślij rodzicowi link do założenia konta (SMS, WhatsApp, Messenger).</li>
          <li><a href="#/ustawienia">Sprawdź cennik i zasady odwołań</a>.</li>
        </ol>
      </section>` : ''}
    ${countdowns()}
    <div class="grid-2">
      <section>
        <div class="section-head"><h2>Dziś</h2><a href="#/kalendarz">Kalendarz</a></div>
        ${today.length ? html`<div class="list">${today.map((l) => lessonCard(l))}</div>` : html`<p class="muted">Dziś nie masz lekcji.</p>`}
        <h2>Najbliższe 7 dni</h2>
        ${later.length ? html`<div class="list">${later.map((l) => lessonCard(l))}</div>` : html`<p class="muted">Pusto.</p>`}
      </section>
      <section>
        ${d.needs_summary.length ? html`
          <div class="card">
            <h2>Brakuje notatki po lekcji</h2>
            <ul class="plain">${d.needs_summary.map((l) => html`<li><a href="#/lekcja/${l.id}">${l.student_name}, ${fmtDate(l.start_at)} ${fmtTime(l.start_at)}</a></li>`)}</ul>
          </div>` : ''}
        <div class="card">
          <div class="section-head"><h2>Do rozliczenia</h2>${settleTotal ? html`<strong>${zl(settleTotal)}</strong>` : ''}</div>
          ${d.to_settle.length ? html`<ul class="settle">${d.to_settle.map((l) => html`
            <li><a href="#/lekcja/${l.id}">${l.student_name}</a> <span class="muted small">${fmtDate(l.start_at)}${l.late_cancel ? ' · późne odwołanie' : ''}</span>
              <span class="grow"></span><span>${zl(l.price)}</span><button class="btn sm" data-paid="${l.id}">Opłacona</button></li>`)}</ul>`
            : html`<p class="muted">Wszystko opłacone. 👌</p>`}
        </div>
        ${q.limit ? html`
          <div class="card">
            <h2>Limit działalności nierejestrowanej</h2>
            <p class="muted small">${q.quarter}. kwartał ${q.year}: przychód ${zl(q.revenue)} z ${zl(q.limit)}</p>
            <div class="meter ${pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : ''}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
            ${pct >= 90 ? html`<p class="small warn-text">Zbliżasz się do limitu. Po jego przekroczeniu masz 7 dni na rejestrację firmy w CEIDG.</p>` : ''}
            <a class="small" href="#/raporty">Raporty i eksport CSV</a>
          </div>` : ''}
      </section>
    </div>`);

  $('#add-lesson').addEventListener('click', () => addLessonDialog({ onDone: () => dashboard(el) }));
  $('#add-client').addEventListener('click', () => addClientDialog(() => dashboard(el)));
  $$('[data-paid]', el).forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/lessons/${b.dataset.paid}`, { method: 'PATCH', body: { paid: true } }); toast('Zapisano wpłatę.'); dashboard(el); } catch (e) { fail(e); }
  }));
}

// ---------- kalendarz tygodniowy ----------

export async function calendar(el) {
  let week = weekStart(todayKey());
  const HOUR = 44;

  async function draw() {
    const from = keyToUtc(week);
    const to = keyToUtc(addDays(week, 7));
    const [{ lessons }, av] = await Promise.all([
      api('/lessons', { query: { from, to } }),
      api('/availability'),
    ]);
    const rules = av.rules.map((r) => ({ ...r, a: toMin(r.start), b: toMin(r.end) }));
    let minH = 8, maxH = 21;
    for (const r of rules) { minH = Math.min(minH, Math.floor(r.a / 60)); maxH = Math.max(maxH, Math.ceil(r.b / 60)); }
    for (const l of lessons) {
      const z = zonedParts(l.start_at);
      minH = Math.min(minH, z.hour);
      maxH = Math.max(maxH, Math.ceil((z.minutes + minutesOf(l)) / 60));
    }
    maxH = Math.min(24, maxH);
    const days = [...Array(7)].map((_, i) => addDays(week, i));
    const top = (min) => ((min - minH * 60) / 60) * HOUR;
    const nowKey = todayKey();
    const nowMin = zonedParts(Date.now()).minutes;
    const count = lessons.filter((l) => l.status === 'scheduled').length;

    render(el, html`
      <div class="page-head">
        <h1>Kalendarz</h1>
        <div class="row"><a class="btn" href="#/dostepnosc">Dostępność</a><button class="btn primary" id="add">Dodaj lekcję</button></div>
      </div>
      <div class="week-nav">
        <button class="btn sm" id="prev" aria-label="Poprzedni tydzień">←</button>
        <strong>${fmtDateFull(keyToUtc(week, 720))} – ${fmtDateFull(keyToUtc(addDays(week, 6), 720))}</strong>
        <button class="btn sm" id="next" aria-label="Następny tydzień">→</button>
        <button class="btn sm ghost" id="today">Dziś</button>
        <span class="muted small">${count} ${plural(count, 'lekcja', 'lekcje', 'lekcji')}</span>
      </div>
      <div class="cal-scroll">
        <div class="cal" style="--rows:${maxH - minH}; --hour:${HOUR}px">
          <div class="cal-head"></div>
          ${days.map((k, i) => html`<div class="cal-head ${k === nowKey ? 'today' : ''}">${WD_SHORT[i + 1]} <strong>${+k.slice(8)}</strong></div>`)}
          <div class="cal-hours">${[...Array(maxH - minH)].map((_, i) => html`<div style="height:${HOUR}px">${hhmm((minH + i) * 60)}</div>`)}</div>
          ${days.map((k, i) => html`
            <div class="cal-day" data-day="${k}" style="height:${(maxH - minH) * HOUR}px">
              ${rules.filter((r) => r.weekday === i + 1).map((r) => html`<div class="cal-avail" style="top:${top(r.a)}px;height:${top(r.b) - top(r.a)}px"></div>`)}
              ${av.time_off.filter((o) => o.end_at > keyToUtc(k) && o.start_at < keyToUtc(addDays(k, 1))).map((o) => {
                const a = Math.max(o.start_at, keyToUtc(k)); const b = Math.min(o.end_at, keyToUtc(addDays(k, 1)));
                const am = (a - keyToUtc(k)) / 60000; const bm = (b - keyToUtc(k)) / 60000;
                return html`<div class="cal-off" style="top:${Math.max(0, top(am))}px;height:${Math.max(0, top(Math.min(bm, maxH * 60)) - Math.max(0, top(am)))}px" title="${o.note || 'wolne'}"></div>`;
              })}
              ${k === nowKey && nowMin >= minH * 60 && nowMin <= maxH * 60 ? html`<div class="cal-now" style="top:${top(nowMin)}px"></div>` : ''}
              ${lessons.filter((l) => keyOf(l.start_at) === k).map((l) => {
                const z = zonedParts(l.start_at);
                const [label, kind] = lessonStatus(l);
                return html`<a class="cal-lesson ${kind} ${l.status}" href="#/lekcja/${l.id}" style="top:${top(z.minutes)}px;height:${Math.max(22, (minutesOf(l) / 60) * HOUR - 2)}px" title="${label}">
                  <strong>${fmtTime(l.start_at)} ${l.student_name}</strong><span>${l.topic || (l.mode === 'onsite' ? l.location || 'stacjonarnie' : '')}</span></a>`;
              })}
            </div>`)}
        </div>
      </div>
      <p class="muted small"><span class="legend avail"></span> dostępność · <span class="legend off"></span> wolne · kliknij puste miejsce, żeby dodać lekcję.</p>`);

    $('#prev').addEventListener('click', () => { week = addDays(week, -7); draw().catch(fail); });
    $('#next').addEventListener('click', () => { week = addDays(week, 7); draw().catch(fail); });
    $('#today').addEventListener('click', () => { week = weekStart(todayKey()); draw().catch(fail); });
    $('#add').addEventListener('click', () => addLessonDialog({ onDone: () => draw().catch(fail) }));
    $$('.cal-day', el).forEach((col) => col.addEventListener('click', (e) => {
      if (e.target.closest('.cal-lesson')) return;
      const y = e.clientY - col.getBoundingClientRect().top;
      const min = Math.round(((y / HOUR) * 60 + minH * 60) / 30) * 30;
      addLessonDialog({ date: col.dataset.day, time: hhmm(Math.min(min, 23 * 60 + 30)), onDone: () => draw().catch(fail) });
    }));
  }
  await draw();
}

const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

// ---------- dostępność ----------

export async function availability(el) {
  const av = await api('/availability');
  let rules = av.rules.map((r) => ({ ...r }));

  function draw() {
    render(el, html`
      <div class="page-head"><h1>Dostępność</h1><button class="btn primary" id="save">Zapisz godziny</button></div>
      <p class="muted">Zaznacz, kiedy zwykle uczysz. Rodzice zobaczą w tych godzinach wolne terminy (bez już zajętych). Lekcje możesz też zawsze wpisać ręcznie poza tymi godzinami.</p>
      <div class="card">
        <div class="row wrap presets"><span class="muted small">Szybko:</span>
          <button class="btn sm ghost" data-preset="weekday">pon–pt 15:00–20:00</button>
          <button class="btn sm ghost" data-preset="sat">+ sobota 9:00–14:00</button>
          <button class="btn sm ghost" data-preset="clear">wyczyść</button>
        </div>
        <div class="avail">
          ${[1, 2, 3, 4, 5, 6, 7].map((wd) => html`
            <div class="avail-row">
              <strong>${WEEKDAYS[wd]}</strong>
              <div class="avail-ranges">
                ${rules.map((r, i) => (r.weekday === wd ? html`
                  <span class="range"><input class="input" type="time" step="900" value="${r.start}" data-i="${i}" data-k="start" aria-label="Od">–<input class="input" type="time" step="900" value="${r.end}" data-i="${i}" data-k="end" aria-label="Do"><button class="icon-btn" data-rm="${i}" aria-label="Usuń przedział">✕</button></span>` : ''))}
                ${rules.some((r) => r.weekday === wd) ? '' : html`<span class="muted small">nie uczę</span>`}
              </div>
              <button class="btn sm ghost" data-add="${wd}">+ godziny</button>
            </div>`)}
        </div>
      </div>

      <section class="card">
        <div class="section-head"><h2>Urlop, wolne dni</h2><button class="btn sm" id="add-off">Dodaj wolne</button></div>
        ${av.time_off.length ? html`<ul class="plain">${av.time_off.map((o) => html`
          <li class="row">${fmtRange(o.start_at, o.end_at)}${o.note ? html` · ${o.note}` : ''}<span class="grow"></span><button class="btn sm ghost" data-off="${o.id}">Usuń</button></li>`)}</ul>`
          : html`<p class="muted">W tych dniach nikt nie zarezerwuje lekcji.</p>`}
      </section>`);

    $$('input[data-i]', el).forEach((inp) => inp.addEventListener('change', () => { rules[+inp.dataset.i][inp.dataset.k] = inp.value; }));
    $$('[data-rm]', el).forEach((b) => b.addEventListener('click', () => { rules.splice(+b.dataset.rm, 1); draw(); }));
    $$('[data-add]', el).forEach((b) => b.addEventListener('click', () => {
      const wd = +b.dataset.add;
      const last = rules.filter((r) => r.weekday === wd).pop();
      rules.push(last ? { weekday: wd, start: last.end, end: hhmm(Math.min(1440, toMin(last.end) + 120)) } : { weekday: wd, start: '16:00', end: '20:00' });
      draw();
    }));
    $$('[data-preset]', el).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.preset === 'clear') rules = [];
      if (b.dataset.preset === 'weekday') rules = [...rules.filter((r) => r.weekday > 5), ...[1, 2, 3, 4, 5].map((wd) => ({ weekday: wd, start: '15:00', end: '20:00' }))];
      if (b.dataset.preset === 'sat') rules = [...rules.filter((r) => r.weekday !== 6), { weekday: 6, start: '09:00', end: '14:00' }];
      draw();
    }));
    $('#save').addEventListener('click', async () => {
      try { await api('/availability', { method: 'PUT', body: { rules } }); toast('Zapisano dostępność.'); } catch (e) { fail(e); }
    });
    $('#add-off').addEventListener('click', () => dialog('Wolne', html`
      <div class="stack">
        <div class="row"><label class="grow">Od dnia<input class="input" type="date" name="from" value="${todayKey()}" required></label>
          <label class="grow">Do dnia (włącznie)<input class="input" type="date" name="to" value="${todayKey()}" required></label></div>
        <label>Notatka <span class="muted small">(widzisz tylko Ty)</span><input class="input" name="note" placeholder="np. ferie"></label>
        <p class="muted small">Zaplanowane lekcje w tym czasie zostają. Odwołaj je osobno, jeśli trzeba.</p>
      </div>`, {
      submit: 'Dodaj',
      onSubmit: async (fd) => { await api('/time-off', { method: 'POST', body: Object.fromEntries(fd) }); av.time_off = (await api('/availability')).time_off; draw(); },
    }));
    $$('[data-off]', el).forEach((b) => b.addEventListener('click', async () => {
      await api(`/time-off/${b.dataset.off}`, { method: 'DELETE' }).catch(fail);
      av.time_off = av.time_off.filter((o) => o.id !== +b.dataset.off);
      draw();
    }));
  }
  draw();
}

// ---------- uczniowie i klienci ----------

function inviteMessage(url) {
  return `Dzień dobry! Tu link do założenia konta na moich korepetycjach. Zobaczysz w nim terminy lekcji, notatki i materiały, a lekcje online odbywają się w przeglądarce: ${url}`;
}

function showInvite(url, name) {
  const msg = inviteMessage(url);
  const d = dialog('Link dla: ' + name, html`
    <p>Wyślij ten link rodzicowi albo uczniowi (SMS, WhatsApp, e-mail). Działa 14 dni i tylko raz.</p>
    <div class="copyline"><input class="input mono" readonly value="${url}"><button type="button" class="btn" id="cp-link">Kopiuj link</button></div>
    <label>Gotowa wiadomość<textarea class="input" rows="4" readonly>${msg}</textarea></label>
    <div class="row wrap">
      <button type="button" class="btn primary" id="cp-msg">Kopiuj wiadomość</button>
      ${navigator.share ? html`<button type="button" class="btn" id="share">Udostępnij…</button>` : ''}
      <a class="btn ghost" href="sms:?&body=${encodeURIComponent(msg)}">SMS</a>
    </div>`);
  $('#cp-link', d).addEventListener('click', () => copy(url));
  $('#cp-msg', d).addEventListener('click', () => copy(msg));
  $('#share', d)?.addEventListener('click', () => navigator.share({ text: msg }).catch(() => {}));
}

export function addClientDialog(onDone) {
  dialog('Nowy uczeń', html`
    <div class="stack">
      <label>Kto będzie się logował? <span class="muted small">(rodzic albo dorosły uczeń)</span><input class="input" name="name" placeholder="np. Anna Kowalska" required></label>
      <label>Imię ucznia <span class="muted small">(puste = ta sama osoba)</span><input class="input" name="student" placeholder="np. Kuba"></label>
      <div class="row"><label class="grow">Poziom<input class="input" name="level" placeholder="np. 8 klasa, matura rozsz." list="levels"></label>
        <label class="grow">Przedmiot<input class="input" name="subject" placeholder="np. matematyka"></label></div>
      <datalist id="levels"><option>4–6 klasa</option><option>7 klasa</option><option>8 klasa (E8)</option><option>liceum / technikum</option><option>matura podstawowa</option><option>matura rozszerzona</option><option>studia</option><option>dorosły</option></datalist>
      <div class="row"><label class="grow">Telefon <span class="muted small">(opcjonalnie)</span><input class="input" name="phone" type="tel"></label>
        <label class="grow">Własna stawka za 60 min <span class="muted small">(zł, opcjonalnie)</span><input class="input" name="hourly" inputmode="decimal" placeholder="z cennika"></label></div>
      <p class="muted small">Zbieraj tylko to, czego potrzebujesz. Nazwiska ani daty urodzenia dziecka nie są potrzebne.</p>
    </div>`, {
    submit: 'Dodaj i utwórz link',
    onSubmit: async (fd) => {
      const b = Object.fromEntries(fd);
      const r = await api('/clients', {
        method: 'POST',
        body: { name: b.name, phone: b.phone, students: [{ name: b.student || b.name, level: b.level, subject: b.subject, hourly_price: parseZl(b.hourly) }] },
      });
      onDone?.();
      setTimeout(() => showInvite(r.invite_url, b.name), 50);
    },
  });
}

export async function clients(el) {
  const { clients: list } = await api('/clients');
  render(el, html`
    <div class="page-head"><h1>Uczniowie</h1><button class="btn primary" id="add">Dodaj ucznia</button></div>
    ${list.length ? html`<div class="client-grid">${list.map((c) => html`
      <article class="card client" data-href="#/uczniowie/${c.id}" tabindex="0">
        <div class="section-head"><h2>${c.name}</h2>${c.dues.due ? html`<span class="badge warn">${zl(c.dues.due)}</span>` : ''}</div>
        <div class="chips">${c.students.map((s) => html`<span class="chip static ${s.active ? '' : 'off'}">${s.name}${s.level ? html` · <span class="muted">${s.level}</span>` : ''}</span>`)}</div>
        <p class="muted small">${c.active ? html`konto aktywne${c.email ? html` · ${c.email}` : ''}` : c.invite_pending ? 'czeka na założenie konta' : 'link wygasł: wygeneruj nowy'}</p>
      </article>`)}</div>`
      : html`<div class="card empty"><h2>Nie masz jeszcze uczniów</h2><p>Dodaj ucznia, a dostaniesz link, który wyślesz rodzicowi. Po założeniu konta rodzic sam rezerwuje lekcje i widzi notatki.</p></div>`}`);
  $('#add').addEventListener('click', () => addClientDialog(() => clients(el)));
}

export async function clientDetail(el, { id }) {
  const { clients: list } = await api('/clients');
  const c = list.find((x) => x.id === +id);
  if (!c) { render(el, html`<div class="card empty"><p>Nie znaleziono.</p><a href="#/uczniowie">Wróć</a></div>`); return; }
  const now = Date.now();
  const { lessons } = await api('/lessons', { query: { client_id: c.id, from: now - 120 * 86400000, to: now + 120 * 86400000, order: 'desc' } });
  const redraw = () => clientDetail(el, { id }).catch(fail);

  render(el, html`
    <a class="back" href="#/uczniowie">← Uczniowie</a>
    <div class="page-head">
      <div><h1>${c.name}</h1><p class="muted">${c.email || 'bez e-maila'}${c.phone ? html` · <a href="tel:${c.phone}">${c.phone}</a>` : ''} · ${c.active ? 'konto aktywne' : c.invite_pending ? 'czeka na założenie konta' : 'link wygasł'}</p></div>
      <div class="row wrap"><button class="btn" id="edit">Edytuj</button><button class="btn" id="link">${c.active ? 'Link do resetu hasła' : 'Nowy link'}</button><button class="btn primary" id="lesson">Dodaj lekcję</button></div>
    </div>
    <div class="grid-2">
      <section class="card">
        <div class="section-head"><h2>Uczniowie</h2><button class="btn sm" id="add-st">Dodaj kolejne dziecko</button></div>
        <ul class="plain students">${c.students.map((s) => html`
          <li>
            <div><strong>${s.name}</strong> ${s.active ? '' : html`<span class="badge muted">nieaktywny</span>`}
              <div class="muted small">${[s.level, s.subject, s.hourly_price != null ? `${zl(s.hourly_price)}/h` : null].filter(Boolean).join(' · ') || 'bez szczegółów'}</div>
              ${s.tutor_notes ? html`<div class="small note">${s.tutor_notes}</div>` : ''}</div>
            <div class="row"><a class="btn sm ghost" href="#/materialy?uczen=${s.id}">Materiały</a><button class="btn sm ghost" data-edit-st="${s.id}">Edytuj</button></div>
          </li>`)}</ul>
      </section>
      <section class="card">
        <h2>Płatności</h2>
        <dl class="facts">
          <dt>Do zapłaty</dt><dd><strong>${zl(c.dues.due)}</strong> ${c.dues.due_count ? html`<span class="muted">(${c.dues.due_count} ${plural(c.dues.due_count, 'lekcja', 'lekcje', 'lekcji')})</span>` : ''}</dd>
          <dt>Zaplanowane, nieopłacone</dt><dd>${zl(c.dues.upcoming_unpaid)}</dd>
          ${c.dues.credit ? html`<dt>Nadpłata</dt><dd>${zl(c.dues.credit)} <span class="muted small">(opłacone lekcje, które odwołano)</span></dd>` : ''}
        </dl>
        ${c.dues.due ? html`<button class="btn primary" id="settle">Oznacz wszystko jako opłacone</button>` : ''}
      </section>
    </div>
    <section>
      <h2>Lekcje (4 miesiące wstecz i w przód)</h2>
      ${lessons.length ? html`<div class="list">${lessons.map((l) => lessonCard(l, { showClient: false, showPaid: true }))}</div>` : html`<p class="muted">Brak lekcji.</p>`}
    </section>
    <section class="danger-zone">
      <h2>Usuwanie danych</h2>
      <p class="small">Usunięcie kasuje konto, uczniów, lekcje, notatki, materiały i czat tej rodziny. Jeśli potrzebujesz historii do rozliczeń, najpierw <a href="#/raporty">pobierz CSV</a>.</p>
      <button class="btn danger-ghost" id="delete">Usuń klienta i wszystkie jego dane</button>
    </section>`);

  $('#lesson').addEventListener('click', () => addLessonDialog({ studentId: c.students[0]?.id, onDone: redraw }));
  $('#link').addEventListener('click', async () => {
    try { const r = await api(`/clients/${c.id}/invite`, { method: 'POST' }); showInvite(r.invite_url, c.name); } catch (e) { fail(e); }
  });
  $('#settle')?.addEventListener('click', async () => {
    try { const r = await api(`/clients/${c.id}/mark-paid`, { method: 'POST' }); toast(`Oznaczono ${r.updated} ${plural(r.updated, 'lekcję', 'lekcje', 'lekcji')}.`); redraw(); } catch (e) { fail(e); }
  });
  $('#edit').addEventListener('click', () => dialog('Dane kontaktowe', html`
    <div class="stack">
      <label>Imię i nazwisko<input class="input" name="name" value="${c.name}" required></label>
      <label>E-mail (login)<input class="input" type="email" name="email" value="${c.email || ''}"></label>
      <label>Telefon<input class="input" type="tel" name="phone" value="${c.phone || ''}"></label>
    </div>`, { onSubmit: async (fd) => { await api(`/clients/${c.id}`, { method: 'PATCH', body: Object.fromEntries(fd) }); redraw(); } }));
  const studentForm = (s = {}) => html`
    <div class="stack">
      <label>Imię<input class="input" name="name" value="${s.name || ''}" required></label>
      <div class="row"><label class="grow">Poziom<input class="input" name="level" value="${s.level || ''}"></label><label class="grow">Przedmiot<input class="input" name="subject" value="${s.subject || ''}"></label></div>
      <label>Własna stawka za 60 min (zł) <span class="muted small">puste = cennik</span><input class="input" name="hourly" inputmode="decimal" value="${zlInput(s.hourly_price)}"></label>
      <label>Notatki o uczniu <span class="muted small">(widzisz tylko Ty)</span><textarea class="input" name="tutor_notes" rows="3">${s.tutor_notes || ''}</textarea></label>
      ${s.id ? html`<label class="check"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> Aktywny (może rezerwować)</label>` : ''}
    </div>`;
  $('#add-st').addEventListener('click', () => dialog('Kolejne dziecko', studentForm(), {
    submit: 'Dodaj',
    onSubmit: async (fd) => { const b = Object.fromEntries(fd); await api('/students', { method: 'POST', body: { ...b, client_id: c.id, hourly_price: parseZl(b.hourly) } }); redraw(); },
  }));
  $$('[data-edit-st]', el).forEach((btn) => btn.addEventListener('click', () => {
    const s = c.students.find((x) => x.id === +btn.dataset.editSt);
    dialog('Uczeń', studentForm(s), {
      onSubmit: async (fd) => { const b = Object.fromEntries(fd); await api(`/students/${s.id}`, { method: 'PATCH', body: { ...b, hourly_price: parseZl(b.hourly), active: fd.get('active') === 'on' } }); redraw(); },
    });
  }));
  $('#delete').addEventListener('click', async () => {
    if (!(await confirmDialog(`Usunąć ${c.name}?`, 'Wszystkie dane tej rodziny zostaną trwale usunięte. Nie da się tego cofnąć.', { submit: 'Usuń trwale' }))) return;
    try { await api(`/clients/${c.id}`, { method: 'DELETE' }); toast('Usunięto.'); location.hash = '#/uczniowie'; } catch (e) { fail(e); }
  });
}

// ---------- raporty ----------

const MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];

export async function reports(el, _p, year) {
  const r = await api('/reports', { query: { year } });
  const tot = r.months.reduce((a, m) => ({ lessons: a.lessons + m.lessons, hours: a.hours + m.hours, revenue: a.revenue + m.revenue, received: a.received + m.received }), { lessons: 0, hours: 0, revenue: 0, received: 0 });
  const max = Math.max(1, ...r.months.map((m) => m.revenue));
  render(el, html`
    <div class="page-head">
      <h1>Raporty ${r.year}</h1>
      <div class="row"><button class="btn sm" id="prev">← ${r.year - 1}</button><button class="btn sm" id="next">${r.year + 1} →</button>
        <a class="btn primary" href="/api/reports/csv?year=${r.year}" download>Pobierz CSV</a></div>
    </div>
    ${r.limit ? html`<div class="quarters">${r.quarters.map((q) => {
      const pct = Math.min(100, Math.round((q.revenue / r.limit) * 100));
      return html`<div class="card quarter"><span class="muted small">${q.quarter}. kwartał</span><strong>${zl(q.revenue)}</strong>
        <div class="meter ${pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : ''}"><span style="width:${pct}%"></span></div><span class="muted small">${pct}% limitu ${zl(r.limit)}</span></div>`;
    })}</div>` : ''}
    <div class="card table-wrap">
      <table class="table">
        <thead><tr><th>Miesiąc</th><th class="num">Lekcje</th><th class="num">Godziny</th><th class="num">Przychód</th><th class="num">Wpłaty</th><th class="bar-col" aria-hidden="true"></th></tr></thead>
        <tbody>${r.months.map((m) => html`<tr>
          <td>${MONTHS[m.month - 1]}</td><td class="num">${m.lessons}${m.late_cancels ? html` <span class="muted small">+${m.late_cancels} odw.</span>` : ''}</td>
          <td class="num">${m.hours.toFixed(1).replace('.', ',')}</td><td class="num">${zl(m.revenue)}</td><td class="num">${zl(m.received)}</td>
          <td class="bar-col">${m.revenue ? html`<span class="bar" style="width:${Math.round((m.revenue / max) * 100)}%"></span>` : ''}</td></tr>`)}</tbody>
        <tfoot><tr><th>Razem</th><th class="num">${tot.lessons}</th><th class="num">${tot.hours.toFixed(1).replace('.', ',')}</th><th class="num">${zl(tot.revenue)}</th><th class="num">${zl(tot.received)}</th><th></th></tr></tfoot>
      </table>
    </div>
    <p class="muted small">Przychód to odbyte lekcje i opłaty za późne odwołania, liczone według daty lekcji. Wpłaty liczone są według dnia oznaczenia lekcji jako opłaconej. Plik CSV otworzysz w Excelu albo LibreOffice i możesz go użyć jako podstawy ewidencji sprzedaży. To pomoc w liczeniu, nie porada podatkowa.</p>`);
  $('#prev').addEventListener('click', () => reports(el, _p, r.year - 1).catch(fail));
  $('#next').addEventListener('click', () => reports(el, _p, r.year + 1).catch(fail));
}

// ---------- ustawienia ----------

export async function settings(el) {
  const { settings: s } = await api('/settings');
  let durations = s.durations.map((d) => ({ ...d }));
  let countdownList = s.countdowns.map((c) => ({ ...c }));

  function draw() {
    render(el, html`
      <form id="settings" class="settings">
        <div class="page-head"><h1>Ustawienia</h1><button class="btn primary" type="submit">Zapisz</button></div>

        <section class="card"><h2>Ogólne</h2>
          <div class="row wrap">
            <label class="grow">Nazwa, którą widzą rodzice<input class="input" name="school_name" value="${s.school_name}"></label>
            <label class="grow">Strefa czasowa<input class="input" name="timezone" value="${s.timezone}"></label>
          </div></section>

        <section class="card"><h2>Cennik</h2>
          <p class="muted small">Długości lekcji do wyboru przy rezerwacji. Uczeń z własną stawką płaci ją proporcjonalnie do długości.</p>
          <div class="stack">${durations.map((d, i) => html`
            <div class="row"><label>Minuty<input class="input" type="number" min="15" max="600" step="5" value="${d.minutes}" data-dur="${i}" data-k="minutes"></label>
              <label>Cena (zł)<input class="input" inputmode="decimal" value="${zlInput(d.price)}" data-dur="${i}" data-k="price"></label>
              <button type="button" class="icon-btn" data-rm-dur="${i}" aria-label="Usuń">✕</button></div>`)}</div>
          <button type="button" class="btn sm ghost" id="add-dur">+ długość</button></section>

        <section class="card"><h2>Rezerwacje przez rodziców</h2>
          <label class="check"><input type="checkbox" name="allow_client_booking" ${s.allow_client_booking ? 'checked' : ''}> Rodzice i uczniowie mogą sami rezerwować wolne terminy</label>
          <div class="row wrap">
            <label>Najpóźniej (godzin przed)<input class="input" type="number" name="min_notice_hours" min="0" value="${s.min_notice_hours}"></label>
            <label>Najdalej (dni do przodu)<input class="input" type="number" name="horizon_days" min="1" value="${s.horizon_days}"></label>
            <label>Początki lekcji co (min)<input class="input" type="number" name="slot_step" min="5" step="5" value="${s.slot_step}"></label>
            <label>Przerwa między lekcjami (min)<input class="input" type="number" name="buffer_min" min="0" step="5" value="${s.buffer_min}"></label>
            <label>Maks. przyszłych rezerwacji rodzica (0 = bez limitu)<input class="input" type="number" name="max_client_bookings" min="0" max="200" value="${s.max_client_bookings}"></label>
          </div></section>

        <section class="card"><h2>Odwołania</h2>
          <label class="check"><input type="checkbox" name="allow_client_cancel" ${s.allow_client_cancel ? 'checked' : ''}> Rodzice i uczniowie mogą sami odwoływać lekcje</label>
          <div class="row wrap">
            <label>Bezpłatnie do (godzin przed)<input class="input" type="number" name="cancel_hours" min="0" value="${s.cancel_hours}"></label>
            <label>Później: opłata (% ceny)<input class="input" type="number" name="late_cancel_fee_pct" min="0" max="100" value="${s.late_cancel_fee_pct}"></label>
          </div></section>

        <section class="card"><h2>Płatności i zasady</h2>
          <label>Jak płacić <span class="muted small">(widzi rodzic przy kwocie do zapłaty)</span><textarea class="input" name="payment_info" rows="2">${s.payment_info}</textarea></label>
          <label>Zasady lekcji <span class="muted small">(widoczne przy zakładaniu konta i na pulpicie rodzica)</span><textarea class="input" name="rules_text" rows="5">${s.rules_text}</textarea></label>
        </section>

        <section class="card"><h2>Lekcje online</h2>
          <p class="muted small">Wideo łączy się bezpośrednio między przeglądarkami (WebRTC). Serwer STUN pomaga znaleźć drogę przez router. Jeśli połączenie czasem nie wychodzi (sieci szkolne, niektóre sieci komórkowe), dodaj własny serwer TURN, np. coturn. Instrukcja jest w README.</p>
          <label>Serwery ICE (JSON)<textarea class="input mono" name="ice_servers" rows="4">${JSON.stringify(s.ice_servers, null, 2)}</textarea></label>
          <label>Zapasowy link do wideo <span class="muted small">(opcjonalnie, np. pokój Jitsi)</span><input class="input" name="external_meeting_url" value="${s.external_meeting_url}" placeholder="https://…"></label>
        </section>

        <section class="card"><h2>Odliczanie na pulpicie</h2>
          <div class="stack">${countdownList.map((c, i) => html`
            <div class="row"><label class="grow">Nazwa<input class="input" value="${c.label}" data-cd="${i}" data-k="label"></label>
              <label>Data<input class="input" type="date" value="${c.date}" data-cd="${i}" data-k="date"></label>
              <button type="button" class="icon-btn" data-rm-cd="${i}" aria-label="Usuń">✕</button></div>`)}</div>
          <button type="button" class="btn sm ghost" id="add-cd">+ termin</button></section>

        <section class="card"><h2>Limit przychodu</h2>
          <p class="muted small">Kwartalny limit działalności nierejestrowanej (2026: 225% minimalnego wynagrodzenia, czyli 10 813,50 zł). Wpisz 0, żeby ukryć pasek. Co roku sprawdź aktualną kwotę.</p>
          <label>Limit na kwartał (zł)<input class="input" name="quarterly_limit" inputmode="decimal" value="${zlInput(s.quarterly_limit)}"></label>
        </section>
      </form>`);

    $$('[data-dur]', el).forEach((inp) => inp.addEventListener('input', () => {
      durations[+inp.dataset.dur][inp.dataset.k] = inp.dataset.k === 'price' ? parseZl(inp.value) : +inp.value;
    }));
    $$('[data-rm-dur]', el).forEach((b) => b.addEventListener('click', () => { durations.splice(+b.dataset.rmDur, 1); draw(); }));
    $('#add-dur').addEventListener('click', () => { durations.push({ minutes: 45, price: 8000 }); draw(); });
    $$('[data-cd]', el).forEach((inp) => inp.addEventListener('input', () => { countdownList[+inp.dataset.cd][inp.dataset.k] = inp.value; }));
    $$('[data-rm-cd]', el).forEach((b) => b.addEventListener('click', () => { countdownList.splice(+b.dataset.rmCd, 1); draw(); }));
    $('#add-cd').addEventListener('click', () => { countdownList.push({ label: '', date: '' }); draw(); });

    $('#settings').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      let ice;
      try { ice = JSON.parse(fd.get('ice_servers') || '[]'); } catch { fail(new Error('Serwery ICE: niepoprawny JSON.')); return; }
      const body = {
        school_name: fd.get('school_name'), timezone: fd.get('timezone'),
        payment_info: fd.get('payment_info'), rules_text: fd.get('rules_text'),
        external_meeting_url: fd.get('external_meeting_url').trim(),
        allow_client_booking: fd.get('allow_client_booking') === 'on',
        allow_client_cancel: fd.get('allow_client_cancel') === 'on',
        min_notice_hours: +fd.get('min_notice_hours'), horizon_days: +fd.get('horizon_days'),
        slot_step: +fd.get('slot_step'), buffer_min: +fd.get('buffer_min'), max_client_bookings: +fd.get('max_client_bookings'),
        cancel_hours: +fd.get('cancel_hours'), late_cancel_fee_pct: +fd.get('late_cancel_fee_pct'),
        quarterly_limit: parseZl(fd.get('quarterly_limit')) ?? 0,
        durations, countdowns: countdownList, ice_servers: ice,
      };
      try {
        const r = await api('/settings', { method: 'PUT', body });
        Object.assign(s, r.settings);
        durations = s.durations.map((d) => ({ ...d }));
        countdownList = s.countdowns.map((c) => ({ ...c }));
        await loadMe();
        $('.brand span').textContent = s.school_name;
        toast('Zapisano ustawienia.');
        draw();
      } catch (ex) { fail(ex); }
    });
  }
  draw();
}

