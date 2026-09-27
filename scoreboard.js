const http = require('http');
const fs = require('fs');
const path = require('path');

// Веб-табло турнира: страница scoreboard.html + её данные. Живёт в том же процессе, что и бот, и
// берёт состояние стола прямо из state.js — синхронизировать нечего. Страница открывается по
// ссылке /t/<boardKey> (ключ случайный, выдаётся столу при создании — без него табло не найти) и
// держит SSE-соединение: после каждого setState стола ей сразу уходит свежее состояние.
//
// GET /t/<key>         — сама страница
// GET /t/<key>/state   — состояние одним JSON (для отладки и первой загрузки)
// GET /t/<key>/stream  — SSE: событие "state" при каждом изменении стола

const PAGE_FILE = path.join(__dirname, 'scoreboard.html');
const HEARTBEAT_MS = 25000; // комментарий в поток, чтобы прокси не рвал "молчащее" соединение
const DEBOUNCE_MS = 150; // несколько setState подряд (действие + обновление закрепа) — одна рассылка
const FINISHED_TTL_MS = 12 * 60 * 60 * 1000; // сколько показываем итог после конца турнира

function startScoreboardServer({ port, host, gameEvents, getActiveGames, toView }) {
  const clients = new Map(); // boardKey -> Set<res>
  const finished = new Map(); // boardKey -> { view, at } — столы, которые уже закрыты
  const pendingSend = new Map(); // boardKey -> timeout

  function findActive(key) {
    for (const { ownerId, state } of getActiveGames()) {
      if (state.boardKey === key) return { ownerId, state };
    }
    return null;
  }

  // текущее состояние для табло: живой стол, закрытый (итог/отмена) или null — такого нет
  function viewFor(key) {
    const active = findActive(key);
    if (active) return { ...toView(active.state), status: 'live' };
    const done = finished.get(key);
    if (done && Date.now() - done.at < FINISHED_TTL_MS) return done.view;
    return null;
  }

  function payload(key) {
    const view = viewFor(key) || { status: 'missing' };
    return JSON.stringify({ ...view, serverNow: Date.now() });
  }

  function send(res, data) {
    res.write(`event: state\ndata: ${data}\n\n`);
  }

  function broadcast(key) {
    const set = clients.get(key);
    if (!set || !set.size) return;
    clearTimeout(pendingSend.get(key));
    pendingSend.set(
      key,
      setTimeout(() => {
        pendingSend.delete(key);
        const data = payload(key);
        for (const res of set) send(res, data);
      }, DEBOUNCE_MS)
    );
  }

  // слушатели не должны ронять setState бота — любые ошибки табло остаются внутри табло
  gameEvents.on('change', (ownerId, state) => {
    try {
      if (state && state.boardKey) broadcast(state.boardKey);
    } catch (err) {
      console.error('Scoreboard broadcast failed:', err.message);
    }
  });
  gameEvents.on('clear', (ownerId, prev) => {
    try {
      if (!prev || !prev.boardKey) return;
      // endedAt ставится только при нормальном завершении — иначе стол отменили/прервали
      const status = prev.endedAt ? 'finished' : 'cancelled';
      finished.set(prev.boardKey, { view: { ...toView(prev), status }, at: Date.now() });
      broadcast(prev.boardKey);
    } catch (err) {
      console.error('Scoreboard broadcast failed:', err.message);
    }
  });

  setInterval(() => {
    for (const [key, done] of finished) if (Date.now() - done.at >= FINISHED_TTL_MS) finished.delete(key);
    for (const set of clients.values()) for (const res of set) res.write(': ping\n\n');
  }, HEARTBEAT_MS).unref();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/t\/([A-Za-z0-9_-]{6,64})(\/state|\/stream)?\/?$/);
    const baseHeaders = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
    if (req.method !== 'GET' || !m) {
      res.writeHead(404, { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const [, key, sub] = m;

    if (!sub) {
      fs.readFile(PAGE_FILE, (err, html) => {
        if (err) {
          res.writeHead(500, baseHeaders);
          return res.end('Scoreboard page missing');
        }
        res.writeHead(200, { ...baseHeaders, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }

    if (sub === '/state') {
      res.writeHead(200, { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(payload(key));
    }

    // /stream
    res.writeHead(200, {
      ...baseHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    send(res, payload(key));
    if (!clients.has(key)) clients.set(key, new Set());
    clients.get(key).add(res);
    req.on('close', () => {
      const set = clients.get(key);
      if (!set) return;
      set.delete(res);
      if (!set.size) clients.delete(key);
    });
  });

  server.on('error', err => console.error('Scoreboard server error:', err.message));
  server.listen(port, host, () => console.log(`Scoreboard listening on http://${host}:${port}`));
  return server;
}

module.exports = { startScoreboardServer };
