// Pokój lekcji: sygnalizacja WebRTC (wideo 1:1), wspólna tablica i czat przez WebSocket.
import { WebSocketServer } from 'ws';
import { userFromRequest } from './auth.js';
import { getSettings } from './db.js';

const MAX_MSG = 12 * 1024 * 1024;          // wklejone zdjęcia na tablicy bywają duże
const MAX_ELEMENTS = 20000;
const MAX_ELEMENT_BYTES = 2 * 1024 * 1024;   // jeden element (np. długa odręczna linia)
const MAX_BOARD_BYTES = 25 * 1024 * 1024;    // cała tablica bez obrazków

/** Prosty „kubełek z żetonami”: pojemność i tempo odnawiania na sekundę. */
function bucket(capacity, perSecond) {
  let tokens = capacity;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * perSecond);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const MAX_FILES_BYTES = 60 * 1024 * 1024;  // na jedną lekcję

export function attachRooms(server, { db, lessonFor, trustProxy = false }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG });
  // lessonId -> { peers: Map<ws, user>, elements: Map<id, element>, files: Map<id, file>, filesBytes, timer }
  const rooms = new Map();

  function loadRoom(lessonId) {
    if (!rooms.has(lessonId)) {
      const room = { peers: new Map(), elements: new Map(), sizes: new Map(), bytes: 0, files: new Map(), filesBytes: 0, timer: null };
      try {
        const data = JSON.parse(db.prepare('SELECT whiteboard FROM lessons WHERE id = ?').get(lessonId)?.whiteboard || 'null');
        if (data?.format === 'excalidraw') {
          for (const el of data.elements || []) {
            const size = JSON.stringify(el).length;
            room.elements.set(el.id, el);
            room.sizes.set(el.id, size);
            room.bytes += size;
          }
          for (const f of Object.values(data.files || {})) { room.files.set(f.id, f); room.filesBytes += f.dataURL.length; }
        }
      } catch { /* uszkodzony zapis: zaczynamy od czystej tablicy */ }
      rooms.set(lessonId, room);
    }
    return rooms.get(lessonId);
  }

  function boardData(room) {
    return { format: 'excalidraw', elements: [...room.elements.values()], files: Object.fromEntries(room.files) };
  }

  function save(lessonId, room) {
    clearTimeout(room.timer);
    room.timer = null;
    db.prepare('UPDATE lessons SET whiteboard = ? WHERE id = ?').run(JSON.stringify(boardData(room)), lessonId);
  }

  function scheduleSave(lessonId, room) {
    if (!room.timer) room.timer = setTimeout(() => save(lessonId, room), 2000);
  }

  const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const broadcast = (room, msg, except) => { for (const ws of room.peers.keys()) if (ws !== except) send(ws, msg); };
  const peerInfo = (u) => ({ id: u.id, name: u.name, role: u.role });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    // Ochrona przed podłączeniem z obcej strony (WebSocket nie podlega CORS).
    const origin = req.headers.origin;
    const fwd = trustProxy && String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    try {
      if (origin && ![req.headers.host, fwd].includes(new URL(origin).host)) throw new Error('origin');
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    const user = userFromRequest(db, req);
    let lesson = null;
    try { lesson = user && lessonFor(user, url.searchParams.get('lesson')); } catch { lesson = null; }
    if (!user || !lesson || lesson.status !== 'scheduled') {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user, lesson.id));
  });

  function onConnection(ws, user, lessonId) {
    const room = loadRoom(lessonId);
    // Ta sama osoba w drugiej karcie: stare połączenie zamykamy.
    for (const [other, u] of room.peers) if (u.id === user.id) other.close(4000, 'Otwarto w innym oknie');
    room.peers.set(ws, user);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const settings = getSettings(db);
    const chat = db.prepare(
      'SELECT c.id, c.body, c.at, c.user_id, u.name FROM chat c LEFT JOIN users u ON u.id = c.user_id WHERE lesson_id = ? ORDER BY c.id DESC LIMIT 200'
    ).all(lessonId).reverse();
    send(ws, {
      t: 'init',
      you: peerInfo(user),
      peers: [...room.peers.values()].filter((u) => u.id !== user.id).map(peerInfo),
      board: boardData(room),
      chat,
      ice: settings.ice_servers,
    });
    broadcast(room, { t: 'peer-join', peer: peerInfo(user) }, ws);

    // Limity na połączenie: ogólny (rysowanie, kursor, wideo) i osobny, ciaśniejszy na czat.
    const allowAny = bucket(400, 150);
    const allowChat = bucket(10, 1);
    let dropped = 0;
    let warned = false;
    ws.on('message', (raw) => {
      if (!allowAny()) {
        dropped += 1;
        if (dropped > 2000) ws.close(1008, 'Za dużo wiadomości');
        return;
      }
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object') return;
      switch (m.t) {
        case 'signal':
          broadcast(room, { t: 'signal', from: user.id, data: m.data }, ws);
          break;
        case 'xd': {
          const out = applyBoard(room, m);
          if (room.full && !warned) {
            warned = true;
            send(ws, { t: 'notice', text: 'Tablica jest pełna. Zapisz ją w materiałach i wyczyść, żeby rysować dalej.' });
          }
          if (out) {
            broadcast(room, { t: 'xd', uid: user.id, name: user.name, ...out }, ws);
            if (out.op !== 'pointer') scheduleSave(lessonId, room);
          }
          break;
        }
        case 'chat': {
          if (!allowChat()) return;
          const body = String(m.body || '').trim().slice(0, 2000);
          if (!body) return;
          const at = Date.now();
          const id = db.prepare('INSERT INTO chat (lesson_id, user_id, body, at) VALUES (?, ?, ?, ?)').run(lessonId, user.id, body, at).lastInsertRowid;
          broadcast(room, { t: 'chat', msg: { id, body, at, user_id: user.id, name: user.name } });
          break;
        }
        case 'ping':
          send(ws, { t: 'pong' });
          break;
        default:
      }
    });

    ws.on('close', () => {
      room.peers.delete(ws);
      const stillHere = [...room.peers.values()].some((u) => u.id === user.id);
      if (!stillHere) broadcast(room, { t: 'peer-leave', peer: peerInfo(user) });
      if (room.peers.size === 0) {
        save(lessonId, room);
        rooms.delete(lessonId);
      }
    });
  }

  /**
   * Operacja tablicy Excalidraw. Element wygrywa, jeśli ma wyższą wersję
   * (przy remisie: niższe versionNonce), tak samo jak w reconcileElements po stronie przeglądarki.
   * Zwraca to, co trzeba rozesłać, albo null.
   */
  function applyBoard(room, m) {
    switch (m.op) {
      case 'elements': {
        if (!Array.isArray(m.elements)) return null;
        const accepted = [];
        room.full = false;
        for (const el of m.elements.slice(0, 5000)) {
          if (!validElement(el)) continue;
          const cur = room.elements.get(el.id);
          if (!cur && room.elements.size >= MAX_ELEMENTS) { room.full = true; continue; }
          if (!cur || el.version > cur.version || (el.version === cur.version && el.versionNonce < cur.versionNonce)) {
            const size = JSON.stringify(el).length;
            const total = room.bytes - (room.sizes.get(el.id) || 0) + size;
            if (size > MAX_ELEMENT_BYTES || total > MAX_BOARD_BYTES) { room.full = true; continue; }
            room.elements.set(el.id, el);
            room.sizes.set(el.id, size);
            room.bytes = total;
            accepted.push(el);
          }
        }
        return accepted.length ? { op: 'elements', elements: accepted } : null;
      }
      case 'files': {
        if (!Array.isArray(m.files)) return null;
        const accepted = [];
        for (const f of m.files.slice(0, 20)) {
          if (!f || typeof f.id !== 'string' || f.id.length > 100 || room.files.has(f.id)) continue;
          if (typeof f.dataURL !== 'string' || !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/.test(f.dataURL)) continue;
          if (f.dataURL.length > MAX_FILE_BYTES * 1.37 || room.filesBytes + f.dataURL.length > MAX_FILES_BYTES * 1.37) continue;
          const file = { id: f.id, mimeType: String(f.mimeType || '').slice(0, 40), dataURL: f.dataURL, created: +f.created || Date.now() };
          room.files.set(file.id, file);
          room.filesBytes += file.dataURL.length;
          accepted.push(file);
        }
        return accepted.length ? { op: 'files', files: accepted } : null;
      }
      case 'pointer':
        return {
          op: 'pointer', x: +m.x || 0, y: +m.y || 0,
          tool: m.tool === 'laser' ? 'laser' : 'pointer', button: m.button === 'down' ? 'down' : 'up',
        };
      default:
        return null;
    }
  }

  function validElement(el) {
    return el && typeof el === 'object' && !Array.isArray(el)
      && typeof el.id === 'string' && el.id.length > 0 && el.id.length <= 64
      && typeof el.type === 'string' && el.type.length <= 32
      && Number.isInteger(el.version) && el.version >= 0
      && Number.isFinite(el.versionNonce);
  }

  // Wykrywanie zerwanych połączeń.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  return {
    /** Ile osób jest teraz w pokojach lekcji. */
    activePeople() { let n = 0; for (const r of rooms.values()) n += r.peers.size; return n; },
    close() {
      clearInterval(heartbeat);
      for (const [id, room] of rooms) save(id, room);
      for (const ws of wss.clients) ws.terminate();
    },
  };
}
