// Разовая правка турнира №24 (2026-10-02/03), запускать из /opt/poker-bot:
//   node scripts/fix-game-24.js           — только показать, что изменится (база не меняется)
//   node scripts/fix-game-24.js --apply   — бэкап базы и запись изменений
// Правки: Данил Шеронов докупается в 01:27 МСК (сразу после выбывания от Никиты),
//         Ксюша выбивает Данила Шеронова в 02:05 МСК.
// По исправленной хронологии заново считаются места, докупки, нокауты, очки, итоги игроков,
// места в рейтинге до/после (у этой и последующих игр) и недостающие ачивки. Титулы бот
// пересчитывает сам из истории — скрипт показывает их до и после.
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { placementPoints } = require('../scoring');
const { prizeBreakdown } = require('../chipStructure');
const { ACHIEVEMENTS } = require('../achievements');
const { DYNAMIC_TITLES } = require('../titles');

const GAME_NO = 24;
const GAME_ID = 'de5a22e9-9aae-4e5b-bd3a-d8412573a00f';
const DANIL = '780019611';
const KSYUSHA = '825957525';
const REBUY_AT = '2026-10-02T22:27:58.000Z'; // 01:27:58 МСК, после выбывания в 01:27:52
const BUST_AT = '2026-10-02T23:05:00.000Z'; // 02:05 МСК

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '..', 'poker.db');

async function run() {
  // пробный прогон — на копии базы: так и титулы (db.js, своё подключение) считаются по новым данным
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = APPLY ? DB_PATH : path.join(os.tmpdir(), `poker.db.${stamp}.dryrun`);
  {
    const src = new Database(DB_PATH, { readonly: true });
    const copy = APPLY ? `/root/poker.db.${stamp}.pre-game24-fix.bak` : target;
    await src.backup(copy);
    src.close();
    console.log(APPLY ? `Бэкап базы: ${copy}` : `Пробный прогон на копии: ${copy}`);
  }
  // db.js открывает poker.db рядом с собой — подменяем путь на target
  const Real = Database;
  const Redirected = function (file, opts) {
    return new Real(path.resolve(file) === DB_PATH ? target : file, opts);
  };
  Redirected.prototype = Real.prototype;
  require.cache[require.resolve('better-sqlite3')].exports = Redirected;
  const dbModule = require('../db');
  const db = new Real(target);

const game = db.prepare('SELECT rowid AS game_no, * FROM games WHERE rowid = ?').get(GAME_NO);
if (!game || game.id !== GAME_ID) throw new Error(`Игра №${GAME_NO} не та, что ожидалась — стоп`);
const oldLog = JSON.parse(game.events_log || '[]');
if (oldLog.some(e => e.type === 'REBUY' && e.id === DANIL)) {
  console.log('Докупка Данила уже есть в хронологии — правка, похоже, уже применена. Ничего не делаю.');
  process.exit(0);
}

const oldResults = db.prepare('SELECT * FROM results WHERE game_id = ? ORDER BY place').all(GAME_ID);
const nameOf = Object.fromEntries(oldResults.map(r => [String(r.telegram_id), r.player_name]));
const N = game.num_players;

// --- новая хронология ---
const sorted = log => log.slice().sort((a, b) => new Date(a.at) - new Date(b.at));
// bustedIndex считаем повтором событий — так же, как его записывает бот
function replay(log) {
  const ids = oldResults.map(r => String(r.telegram_id));
  const busted = [];
  const rebuys = Object.fromEntries(ids.map(id => [id, 0]));
  const knockouts = Object.fromEntries(ids.map(id => [id, 0]));
  for (const e of log) {
    if (e.type === 'BUST') {
      if (busted.includes(e.id)) throw new Error(`${nameOf[e.id]} выбывает, уже выбыв (${e.at})`);
      busted.push(e.id);
      if (e.by) knockouts[e.by]++;
    } else if (e.type === 'REBUY') {
      const idx = busted.indexOf(e.id);
      if (idx === -1) throw new Error(`${nameOf[e.id]} докупается, не выбыв (${e.at})`);
      if (e.bustedIndex == null) e.bustedIndex = idx;
      busted.splice(idx, 1);
      rebuys[e.id]++;
    }
  }
  const remaining = ids.filter(id => !busted.includes(id));
  if (remaining.length !== 1) throw new Error(`В конце за столом ${remaining.length} игроков, а должен быть 1`);
  const order = [remaining[0], ...busted.slice().reverse()];
  return order.map((id, i) => {
    const place = i + 1;
    const placementPts = placementPoints(place, N);
    return { telegramId: Number(id), name: nameOf[id], place, rebuys: rebuys[id], knockouts: knockouts[id], placementPts, total: placementPts - 2 * rebuys[id] + knockouts[id] };
  });
}

// сверка: повтор старой хронологии должен дать ровно то, что сейчас в базе
const check = replay(sorted(oldLog));
for (const r of check) {
  const o = oldResults.find(x => x.telegram_id === r.telegramId);
  if (o.place !== r.place || o.rebuys !== r.rebuys || o.knockouts !== r.knockouts || o.total_points !== r.total) {
    throw new Error(`Старая хронология не сходится с результатами в базе (${r.name}) — стоп`);
  }
}

const newLog = sorted([
  ...oldLog,
  { type: 'REBUY', id: DANIL, at: REBUY_AT },
  { type: 'BUST', id: DANIL, by: KSYUSHA, at: BUST_AT }
]);
const newResults = replay(newLog);

// --- рейтинг до/после: снимок = текущие итоги минус очки всех более поздних игр ---
const laterGames = db.prepare('SELECT rowid AS game_no, id, date, ended_at FROM games WHERE date > ? ORDER BY date').all(game.date);
const resultsOf = id => db.prepare('SELECT * FROM results WHERE game_id = ?').all(id);
const allPlayers = () => db.prepare('SELECT telegram_id, total_points, registered_at FROM players').all();

function rankAt(players, subtractGames, registeredBy) {
  const totals = Object.fromEntries(players.map(p => [p.telegram_id, p.total_points]));
  for (const g of subtractGames) for (const r of resultsOf(g.id)) if (r.telegram_id in totals) totals[r.telegram_id] -= r.total_points;
  const ranked = players
    .filter(p => !registeredBy || p.registered_at <= registeredBy)
    .sort((a, b) => totals[b.telegram_id] - totals[a.telegram_id] || (a.registered_at < b.registered_at ? -1 : 1));
  return Object.fromEntries(ranked.map((p, i) => [p.telegram_id, i + 1]));
}

// rank_after этой и последующих игр, rank_before последующих
function computeRanks() {
  const chain = [game, ...laterGames];
  const players = allPlayers();
  const out = {};
  chain.forEach((g, i) => {
    const after = rankAt(players, chain.slice(i + 1), g.ended_at || g.date);
    out[g.id] = { after };
    if (i > 0) out[g.id].before = out[chain[i - 1].id].after;
  });
  return out;
}

const fmtTitles = h =>
  DYNAMIC_TITLES.map(t => `${t.emoji} ${t.name}: ${(h[t.id] || []).map(x => `${x.name} (${x.value})`).join(', ') || '—'}`);

function protocolText(results, ranksAfter) {
  const rebuysTotal = results.reduce((s, r) => s + r.rebuys, 0);
  const stake = game.buy_in || game.chip_stack;
  const bank = stake * N + stake * rebuysTotal;
  const prizes = prizeBreakdown(bank, N);
  const lines = [`🏆 Протокол турнира №${GAME_NO}`, `Банк: ${stake * N} + ${stake * rebuysTotal} = ${bank} ${game.buy_in ? '₽' : 'фишек'}`, ''];
  for (const r of results) {
    const p = db.prepare('SELECT total_points FROM players WHERE telegram_id = ?').get(r.telegramId);
    const before = db.prepare('SELECT rank_before FROM results WHERE game_id = ? AND telegram_id = ?').get(GAME_ID, r.telegramId).rank_before;
    const after = ranksAfter[r.telegramId];
    const d = before != null && after != null ? before - after : null;
    const dl = d == null ? '—' : d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : '0';
    const prize = prizes[r.place - 1] ? prizes[r.place - 1].amount : 0;
    lines.push(`${r.place}. ${r.name} — ${r.total > 0 ? '+' : ''}${r.total} (итого ${p ? p.total_points : '?'}) · выигрыш ${prize} · рейтинг ${dl} · re-entry ${r.rebuys} · KO ${r.knockouts}`);
  }
  return lines.join('\n');
}

// --- что изменится ---
console.log(`Турнир №${GAME_NO}: ${APPLY ? 'ПРИМЕНЯЮ' : 'пробный прогон, база не меняется'}\n`);
console.log('Место | Игрок | очки было → стало | re-entry | KO');
for (const r of newResults) {
  const o = oldResults.find(x => x.telegram_id === r.telegramId);
  console.log(`${o.place}→${r.place} | ${r.name} | ${o.total_points} → ${r.total} | ${o.rebuys}→${r.rebuys} | ${o.knockouts}→${r.knockouts}`);
}

const titlesBefore = dbModule.getTitleHolders();
const ranksOldCheck = computeRanks();
const rankMismatch = oldResults.filter(r => r.rank_after != null && ranksOldCheck[GAME_ID].after[r.telegram_id] !== r.rank_after);
if (rankMismatch.length) {
  console.log(`\n⚠️ Пересчёт рейтинга по текущим данным не совпал с сохранённым снимком у: ${rankMismatch.map(r => r.player_name).join(', ')}` +
    ' (например, после правок/удалений игроков). Места в рейтинге будут пересчитаны по текущим данным.');
}

const apply = db.transaction(() => {
  db.prepare('UPDATE games SET events_log = ? WHERE id = ?').run(JSON.stringify(newLog), GAME_ID);
  for (const r of newResults) {
    const o = oldResults.find(x => x.telegram_id === r.telegramId);
    db.prepare('UPDATE results SET place = ?, rebuys = ?, knockouts = ?, placement_points = ?, total_points = ? WHERE game_id = ? AND telegram_id = ?')
      .run(r.place, r.rebuys, r.knockouts, r.placementPts, r.total, GAME_ID, r.telegramId);
    db.prepare(`UPDATE players SET total_points = total_points + ?, wins = wins + ?, knockouts = knockouts + ?, rebuys = rebuys + ? WHERE telegram_id = ?`)
      .run(r.total - o.total_points, (r.place === 1) - (o.place === 1), r.knockouts - o.knockouts, r.rebuys - o.rebuys, r.telegramId);
  }

  const ranks = computeRanks();
  for (const g of [game, ...laterGames]) {
    for (const r of resultsOf(g.id)) {
      const before = g.id === GAME_ID ? r.rank_before : ranks[g.id].before[r.telegram_id] ?? r.rank_before;
      const after = ranks[g.id].after[r.telegram_id] ?? r.rank_after;
      db.prepare('UPDATE results SET rank_before = ?, rank_after = ? WHERE game_id = ? AND telegram_id = ?').run(before, after, g.id, r.telegram_id);
    }
  }

  // ачивки этой игры по новым результатам (снятые ачивки не отбираем — их и не было: в игре №24 ничего не разблокировалось)
  const unlocked = [];
  const unlock = (id, ach, gameId, at) => {
    const info = db.prepare('INSERT OR IGNORE INTO achievements (telegram_id, achievement_id, game_id, unlocked_at) VALUES (?, ?, ?, ?)').run(id, ach, gameId, at);
    if (info.changes) unlocked.push(`${nameOf[String(id)] || id}: ${ACHIEVEMENTS.find(a => a.id === ach).emoji} ${ACHIEVEMENTS.find(a => a.id === ach).name} (игра ${gameId === GAME_ID ? '№' + GAME_NO : gameId})`);
  };
  const busts = newLog.filter(e => e.type === 'BUST' && e.by);
  for (const r of newResults) {
    const victims = new Set(busts.filter(e => e.by === String(r.telegramId)).map(e => e.id));
    if (victims.size === N - 1) unlock(r.telegramId, 'solo', GAME_ID, game.ended_at);
    if (r.knockouts === 0) unlock(r.telegramId, 'peacemaker', GAME_ID, game.ended_at);
    if (r.place === 1 && r.rebuys > 0) unlock(r.telegramId, 'phoenix', GAME_ID, game.ended_at);
    if (r.place === 1 && r.rebuys === 0) unlock(r.telegramId, 'skillOnly', GAME_ID, game.ended_at);
  }
  // "Круглая цифра" — итог, кратный 100, сразу после этой и каждой следующей игры
  const players = allPlayers();
  const chain = [game, ...laterGames];
  chain.forEach((g, i) => {
    for (const r of resultsOf(g.id)) {
      const p = players.find(x => x.telegram_id === r.telegram_id);
      if (!p) continue;
      let total = p.total_points;
      for (const lg of chain.slice(i + 1)) for (const lr of resultsOf(lg.id)) if (lr.telegram_id === r.telegram_id) total -= lr.total_points;
      if (total !== 0 && total % 100 === 0) unlock(r.telegram_id, 'round100', g.id, g.ended_at || g.date);
    }
  });
  return { unlocked, ranks };
});

  const { unlocked, ranks } = apply();
  const titlesAfter = dbModule.getTitleHolders();

  console.log('\nНовые ачивки:', unlocked.length ? '\n  ' + unlocked.join('\n  ') : 'нет');
  const lostAch = db.prepare('SELECT * FROM achievements WHERE game_id IN (' + [game, ...laterGames].map(() => '?').join(',') + ')').all(...[game, ...laterGames].map(g => g.id));
  console.log(`(всего ачивок, привязанных к игре №${GAME_NO} и последующим: ${lostAch.length})`);

  console.log('\nТитулы (было → стало):');
  const before = fmtTitles(titlesBefore);
  const after = fmtTitles(titlesAfter);
  before.forEach((line, i) => console.log(line === after[i] ? `  ${line}` : `* ${line}\n  → ${after[i]}`));

  console.log('\n' + protocolText(newResults, ranks[GAME_ID].after));
  if (laterGames.length) console.log(`\nПересчитаны места в рейтинге и у ${laterGames.length} следующей игры (№${laterGames.map(g => g.game_no).join(', ')}).`);

  if (!APPLY) {
    console.log('\nПробный прогон — рабочая база не менялась. Для записи: node scripts/fix-game-24.js --apply');
  } else {
    console.log('\nГотово. Полный протокол: История → турнир №24 → «📢 Отправить в канал».');
  }
}

run().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
