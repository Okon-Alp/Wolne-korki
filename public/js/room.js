// Pokój lekcji: tablica + wideo + czat.
import { api, html, render, $, state, fmtTime, fmtRange, toast, fail, typeset, isTutor, zonedParts } from './lib.js';
import { Call } from './rtc.js';

// Tablica (Excalidraw) ładuje się dopiero w pokoju lekcji. Czcionki serwujemy sami, bez CDN.
function loadBoard() {
  window.EXCALIDRAW_ASSET_PATH = '/board/';
  if (!document.querySelector('link[data-board-css]')) {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/board/board.css' });
    link.dataset.boardCss = '';
    document.head.append(link);
  }
  return import('/board/board.js');
}

export async function room(el, { id }) {
  const { lesson: l } = await api(`/lessons/${id}`);
  document.title = `Lekcja: ${l.student_name}`;
  const back = `#/lekcja/${l.id}`;

  if (l.status !== 'scheduled') {
    render(el, html`<div class="auth"><div class="card auth-card"><h1>Lekcja jest odwołana</h1><a class="btn" href="${back}">Wróć</a></div></div>`);
    return;
  }

  render(el, html`
    <div class="room">
      <header class="room-bar">
        <a class="btn sm ghost" href="${back}">← Wyjdź</a>
        <div class="room-title"><strong>${l.student_name}</strong><span class="muted">${fmtRange(l.start_at, l.end_at)}</span></div>
        <span class="timer" id="timer"></span>
        <button class="btn sm" id="save" title="Zapisz obraz tablicy w materiałach lekcji">💾 Do materiałów</button>
        <span class="conn" id="conn" data-state="connecting">Łączenie…</span>
      </header>
      ${window.isSecureContext ? '' : html`<p class="banner warn">Kamera i mikrofon działają tylko przez HTTPS. Tablica i czat działają normalnie.</p>`}
      <div class="room-main">
        <section class="board-area">
          <div class="board-host" id="board"><p class="board-loading">Ładuję tablicę…</p></div>
        </section>
        <aside class="side">
          <div class="videos">
            <div class="remote-wrap">
              <video id="remote" playsinline autoplay></video>
              <div class="video-ph" id="remote-ph">Czekam na drugą osobę…</div>
              <button class="btn primary sm" id="unmute" hidden>Włącz dźwięk</button>
            </div>
            <video id="local" playsinline autoplay muted></video>
          </div>
          <div class="av-controls">
            <button class="btn sm" id="mic" aria-pressed="true">🎙 Mikrofon</button>
            <button class="btn sm" id="cam" aria-pressed="true">📷 Kamera</button>
            ${navigator.mediaDevices?.getDisplayMedia ? html`<button class="btn sm" id="screen">🖥 Ekran</button>` : ''}
            ${state.settings.external_meeting_url ? html`<a class="btn sm ghost" href="${state.settings.external_meeting_url}" target="_blank" rel="noopener" title="Gdyby wideo nie działało">Zapasowe wideo</a>` : ''}
          </div>
          <div class="chat">
            <div class="chat-log" id="chat-log" aria-live="polite"></div>
            <form id="chat-form" class="chat-form">
              <input class="input" name="body" placeholder="Napisz… (wzory: $x^2$)" autocomplete="off" maxlength="2000" aria-label="Wiadomość">
              <button class="btn primary sm">Wyślij</button>
            </form>
          </div>
        </aside>
      </div>
    </div>`);

  const conn = $('#conn');
  const setConn = (st, text) => { conn.dataset.state = st; conn.textContent = text; };
  let ws = null;
  let me = null;
  let call = null;
  let closedByUs = false;
  let retry = 0;
  let retryTimer = null;
  let peerPresent = false;
  let alive = true;
  const names = new Map();

  const send = (msg) => { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); };
  let board = null;
  let pendingInit = null;
  const pendingOps = [];
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  loadBoard()
    .then(({ mountBoard }) => {
      if (!alive) return null;
      $('#board').innerHTML = '';
      return mountBoard($('#board'), { send: (op) => send({ t: 'xd', ...op }), theme: dark ? 'dark' : 'light', onSaveToMaterials: saveToMaterials });
    })
    .then((b) => {
      if (!b) return;
      board = b;
      if (pendingInit) board.init(pendingInit);
      pendingOps.splice(0).forEach((m) => board.remote(m));
    })
    .catch((e) => { console.error(e); render($('#board'), html`<p class="board-loading">Nie udało się załadować tablicy. Odśwież stronę.</p>`); });

  // ---------- czat ----------
  const log = $('#chat-log');
  function addMsg(m) {
    const div = document.createElement('div');
    div.className = `msg ${m.user_id === state.me.id ? 'mine' : ''}`;
    render(div, html`<span class="who">${m.user_id === state.me.id ? 'Ty' : m.name || names.get(m.user_id) || '—'} · ${fmtTime(m.at)}</span><span class="body">${m.body}</span>`);
    log.append(div);
    log.scrollTop = log.scrollHeight;
    typeset(div);
  }
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = e.target.body;
    if (!inp.value.trim()) return;
    send({ t: 'chat', body: inp.value });
    inp.value = '';
  });

  // ---------- wideo ----------
  const remoteVideo = $('#remote');
  function onCallState(st) {
    if (!alive) return;
    const ph = $('#remote-ph');
    if (st === 'connected') { ph.hidden = true; setConn('ok', 'Połączono'); }
    else if (st === 'connecting' || st === 'new') { ph.hidden = false; ph.textContent = 'Łączenie obrazu…'; }
    else if (st === 'waiting') { ph.hidden = false; ph.textContent = 'Czekam na drugą osobę…'; setConn('ok', 'Online'); }
    else if (st === 'failed' || st === 'disconnected') { ph.hidden = false; ph.textContent = 'Obraz się rwie. Próbuję połączyć ponownie…'; }
    else if (st === 'needs-click') $('#unmute').hidden = false;
    else if (st === 'no-media') toast('Brak dostępu do kamery i mikrofonu. Sprawdź uprawnienia przeglądarki (ikona kłódki przy adresie).', 'warn');
  }
  $('#unmute').addEventListener('click', () => { remoteVideo.play().then(() => { $('#unmute').hidden = true; }).catch(() => {}); });

  function setupCall(ice) {
    if (call) return;
    call = new Call({
      send: (data) => send({ t: 'signal', data }),
      polite: !isTutor(),
      iceServers: ice,
      localVideo: $('#local'),
      remoteVideo,
      onState: onCallState,
    });
    call.ready.then(() => {
      if (!alive) return;
      if (!call.stream) return;
      if (!call.stream.getAudioTracks().length) { $('#mic').disabled = true; $('#mic').textContent = '🎙 brak'; }
      if (!call.camTrack) { $('#cam').disabled = true; $('#cam').textContent = '📷 brak'; }
    });
  }
  const toggleBtn = (btn, on, label) => { btn.setAttribute('aria-pressed', String(on)); btn.classList.toggle('off', !on); btn.textContent = `${label}${on ? '' : ' (wył.)'}`; };
  $('#mic').addEventListener('click', (e) => { const on = call?.toggleMic(); if (on != null) toggleBtn(e.currentTarget, on, '🎙 Mikrofon'); });
  $('#cam').addEventListener('click', (e) => { const on = call?.toggleCam(); if (on != null) toggleBtn(e.currentTarget, on, '📷 Kamera'); });
  $('#screen')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try { const on = await call.shareScreen(); btn.classList.toggle('on', on); btn.textContent = on ? '🖥 Zakończ' : '🖥 Ekran'; } catch { /* anulowano */ }
  });

  // ---------- WebSocket ----------
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?lesson=${l.id}`);
    let opened = false;
    ws.onopen = () => { opened = true; retry = 0; setConn('ok', 'Online'); };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.t) {
        case 'init':
          me = m.you;
          if (board) board.init(m.board); else { pendingInit = m.board; pendingOps.length = 0; }
          log.innerHTML = '';
          if (!m.chat.length) log.innerHTML = '<p class="muted small">Czat lekcji. Wiadomości zostają w historii lekcji.</p>';
          m.chat.forEach(addMsg);
          m.peers.forEach((p) => names.set(p.id, p.name));
          setupCall(m.ice);
          peerPresent = m.peers.length > 0;
          if (peerPresent) call.restart(); else onCallState('waiting');
          break;
        case 'peer-join':
          names.set(m.peer.id, m.peer.name);
          peerPresent = true;
          toast(`${m.peer.name} dołącza do lekcji.`);
          call?.restart();
          break;
        case 'peer-leave':
          peerPresent = false;
          call?.peerLeft();
          board?.peerLeft(m.peer.id);
          toast(`${m.peer.name} wychodzi z lekcji.`, 'warn');
          break;
        case 'signal': call?.signal(m.data); break;
        case 'xd': if (board) board.remote(m); else pendingOps.push(m); break;
        case 'chat': addMsg(m.msg); break;
        case 'notice': toast(m.text, 'warn'); break;
        default:
      }
    };
    ws.onclose = (ev) => {
      if (closedByUs) return;
      if (ev.code === 4000) { setConn('err', 'Otwarte w innym oknie'); return; }
      if (!opened && retry >= 2) { setConn('err', 'Brak dostępu do pokoju'); return; }
      setConn('err', 'Rozłączono, wznawiam…');
      retry += 1;
      retryTimer = setTimeout(connect, Math.min(10000, 500 * 2 ** retry));
    };
  }
  connect();

  // ---------- zapis tablicy ----------
  const stamp = () => {
    const z = zonedParts(Date.now());
    const p2 = (n) => String(n).padStart(2, '0');
    return `${z.y}-${p2(z.m)}-${p2(z.d)}_${p2(z.hour)}-${p2(z.minute)}`;
  };
  async function saveToMaterials() {
    if (!board) return;
    if (board.isEmpty()) { toast('Tablica jest pusta.', 'warn'); return; }
    try {
      const blob = await board.exportPng();
      await api('/materials/upload', { method: 'POST', file: blob, query: { lesson_id: l.id, name: `tablica-${stamp()}.png`, mime: 'image/png', title: `Tablica z lekcji ${fmtTime(Date.now())}` } });
      toast('Tablica zapisana w materiałach lekcji.');
    } catch (e) { fail(e); }
  }
  $('#save').addEventListener('click', saveToMaterials);

  // ---------- zegar lekcji ----------
  const tick = () => {
    if (!alive) return;
    const now = Date.now();
    const t = $('#timer');
    if (!t) return;
    if (now < l.start_at) t.textContent = `start za ${Math.ceil((l.start_at - now) / 60000)} min`;
    else if (now < l.end_at) t.textContent = `zostało ${Math.ceil((l.end_at - now) / 60000)} min`;
    else t.textContent = 'czas minął';
  };
  tick();
  const timer = setInterval(tick, 15000);

  // Strażnik połączenia: jeśli obraz nie ruszył przez ~15 s, korepetytor restartuje połączenie po obu stronach.
  let stuck = 0;
  const watchdog = setInterval(() => {
    if (!alive || !peerPresent || !call || ws?.readyState !== 1) { stuck = 0; return; }
    if (call.pc?.connectionState === 'connected') { stuck = 0; return; }
    stuck += 1;
    if (isTutor() && stuck >= 3) {
      stuck = 0;
      call.restart();
      send({ t: 'signal', data: { restart: true } });
    }
  }, 5000);

  return () => {
    alive = false;
    closedByUs = true;
    clearTimeout(retryTimer);
    clearInterval(timer);
    clearInterval(watchdog);
    ws?.close();
    call?.close();
    board?.destroy();
    document.title = 'Wolne Korki';
    void me;
  };
}
