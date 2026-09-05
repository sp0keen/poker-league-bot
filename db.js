const path = require('path');
const Database = require('better-sqlite3');
const { placementPoints } = require('./scoring');
const { prizeBreakdown } = require('./chipStructure');
const { MIN_GAMES_FOR_AVG_TITLE } = require('./titles');

// запасной номинальный стек — только для миграции старых записей и как крайний фолбэк;
// у каждой новой игры реальный стек хранится в games.chip_stack
const NOMINAL_CHIP_STACK = 500;

const db = new Database(path.join(__dirname, 'poker.db'));
db.pragma('journal_mode = WAL');
// та же логика призовых (варьируется по N, последнее место — остаток банка), доступная из SQL —
// чтобы не дублировать формулу третий раз в рейтинговом запросе (prizeForPlace объявлена ниже,
// но это function-декларация, поэтому она уже поднята к этому моменту)
db.function('prize_for_place', (place, bank, n) => prizeForPlace(place, bank, n));

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    display_name TEXT NOT NULL,
    games INTEGER NOT NULL DEFAULT 0,
    total_points REAL NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    knockouts INTEGER NOT NULL DEFAULT 0,
    rebuys INTEGER NOT NULL DEFAULT 0,
    registered_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    num_players INTEGER NOT NULL,
    players TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS results (
    game_id TEXT NOT NULL,
    telegram_id INTEGER NOT NULL,
    player_name TEXT NOT NULL,
    place INTEGER NOT NULL,
    rebuys INTEGER NOT NULL,
    knockouts INTEGER NOT NULL,
    placement_points REAL NOT NULL,
    total_points REAL NOT NULL
  );

  -- в отличие от титулов (живой перерасчёт), ачивки разблокируются один раз и остаются навсегда —
  -- PRIMARY KEY на (telegram_id, achievement_id) сам защищает от повторной разблокировки
  CREATE TABLE IF NOT EXISTS achievements (
    telegram_id INTEGER NOT NULL,
    achievement_id TEXT NOT NULL,
    game_id TEXT,
    unlocked_at TEXT NOT NULL,
    PRIMARY KEY (telegram_id, achievement_id)
  );
`);

// миграции для существующих БД (созданных до фич бай-инов / времени окончания)
const gameCols = db.prepare('PRAGMA table_info(games)').all().map(c => c.name);
if (!gameCols.includes('buy_in')) {
  db.exec('ALTER TABLE games ADD COLUMN buy_in INTEGER NOT NULL DEFAULT 0');
}
if (!gameCols.includes('ended_at')) {
  db.exec('ALTER TABLE games ADD COLUMN ended_at TEXT');
}
if (!gameCols.includes('chip_stack')) {
  // старые записи создавались с фиксированным номинальным стеком 500 — фиксируем это явно
  db.exec(`ALTER TABLE games ADD COLUMN chip_stack INTEGER NOT NULL DEFAULT ${NOMINAL_CHIP_STACK}`);
}
if (!gameCols.includes('events_log')) {
  // JSON-массив событий (выбывания/докупки) с таймстампами — для хронологии в протоколе
  db.exec('ALTER TABLE games ADD COLUMN events_log TEXT');
}

const resultCols = db.prepare('PRAGMA table_info(results)').all().map(c => c.name);
if (!resultCols.includes('rank_before')) {
  // место в общем рейтинге непосредственно до и сразу после этой игры — застывший снимок на
  // момент сохранения, чтобы в протоколе показать, как турнир сдвинул позицию каждого игрока
  // (эта цифра не пересчитывается задним числом, даже если рейтинг потом ещё изменится)
  db.exec('ALTER TABLE results ADD COLUMN rank_before INTEGER');
  db.exec('ALTER TABLE results ADD COLUMN rank_after INTEGER');
}

function registerPlayer(telegramId, username, displayName) {
  const existing = db.prepare('SELECT telegram_id FROM players WHERE telegram_id = ?').get(telegramId);
  if (existing) {
    db.prepare('UPDATE players SET username = ?, display_name = ? WHERE telegram_id = ?')
      .run(username, displayName, telegramId);
    return false; // already registered
  }
  db.prepare(`
    INSERT INTO players (telegram_id, username, display_name, registered_at)
    VALUES (?, ?, ?, ?)
  `).run(telegramId, username, displayName, new Date().toISOString());
  return true; // newly registered
}

function getAllPlayers() {
  return db.prepare('SELECT telegram_id, display_name FROM players ORDER BY display_name').all();
}

function getPlayerByTelegramId(telegramId) {
  return db.prepare('SELECT * FROM players WHERE telegram_id = ?').get(telegramId);
}

function saveGameResults(state, results, N) {
  const insertGame = db.prepare(
    'INSERT INTO games (id, date, num_players, players, buy_in, ended_at, chip_stack, events_log) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertResult = db.prepare(`
    INSERT INTO results (game_id, telegram_id, player_name, place, rebuys, knockouts, placement_points, total_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updatePlayer = db.prepare(`
    UPDATE players SET
      games = games + 1,
      total_points = total_points + @total,
      wins = wins + @win,
      knockouts = knockouts + @knockouts,
      rebuys = rebuys + @rebuys
    WHERE telegram_id = @telegramId
  `);

  const rankSnapshot = db.prepare('SELECT telegram_id FROM players ORDER BY total_points DESC, registered_at ASC');
  const updateRank = db.prepare('UPDATE results SET rank_before = ?, rank_after = ? WHERE game_id = ? AND telegram_id = ?');

  const tx = db.transaction(() => {
    const rankBefore = {};
    rankSnapshot.all().forEach((p, i) => {
      rankBefore[p.telegram_id] = i + 1;
    });

    insertGame.run(
      state.gameId,
      state.date,
      N,
      Object.values(state.players).join(', '),
      state.buyIn || 0,
      state.endedAt || new Date().toISOString(),
      state.chipStack || NOMINAL_CHIP_STACK,
      JSON.stringify(state.log || [])
    );
    results.forEach(r => {
      insertResult.run(state.gameId, r.telegramId, r.name, r.place, r.rebuys, r.knockouts, r.placementPts, r.total);
      updatePlayer.run({
        telegramId: r.telegramId,
        total: r.total,
        win: r.place === 1 ? 1 : 0,
        knockouts: r.knockouts,
        rebuys: r.rebuys
      });
    });

    // застывший снимок мест до/после — считается один раз здесь и больше не пересчитывается
    const rankAfter = {};
    rankSnapshot.all().forEach((p, i) => {
      rankAfter[p.telegram_id] = i + 1;
    });
    results.forEach(r => {
      updateRank.run(rankBefore[r.telegramId] ?? null, rankAfter[r.telegramId] ?? null, state.gameId, r.telegramId);
    });
  });
  tx();
}

const RATING_ORDER = 'ORDER BY total_points DESC, registered_at ASC';

// полный список — используется для подсчёта места игрока (getPlayerRank)
function getRating() {
  return db.prepare(`
    SELECT telegram_id, display_name, games, total_points, wins, knockouts, rebuys
    FROM players
    ${RATING_ORDER}
  `).all();
}

function getRatingCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM players').get().c;
}

const RATING_ORDER_COL = {
  points: 'p.total_points',
  wins: 'p.wins',
  knockouts: 'p.knockouts',
  winningsChips: 'winningsChips',
  winningsRub: 'winningsRub'
};

// одна таблица со всеми метриками сразу (очки/победы/выбивания/докупок/оба выигрыша) —
// столбцы везде одни и те же, меняется только порядок сортировки
function getRatingPage(mode, offset, limit) {
  const orderCol = RATING_ORDER_COL[mode] || RATING_ORDER_COL.points;
  return db.prepare(`
    WITH game_banks AS (
      SELECT r.game_id AS game_id,
             SUM((CASE WHEN g.buy_in > 0 THEN g.buy_in ELSE g.chip_stack END) * (1 + r.rebuys)) AS chip_bank,
             SUM(g.buy_in * (1 + r.rebuys)) AS rub_bank,
             MAX(g.buy_in) AS buy_in,
             COUNT(*) AS n
      FROM results r
      JOIN games g ON g.id = r.game_id
      GROUP BY r.game_id
    ),
    prize_rows AS (
      SELECT res.telegram_id AS telegram_id,
             prize_for_place(res.place, gb.chip_bank, gb.n) AS chip_prize,
             CASE WHEN gb.buy_in > 0
               THEN prize_for_place(res.place, gb.rub_bank, gb.n)
               ELSE 0
             END AS rub_prize
      FROM results res
      JOIN game_banks gb ON gb.game_id = res.game_id
      WHERE res.place <= 3
    ),
    prizes AS (
      SELECT telegram_id, SUM(chip_prize) AS winningsChips, SUM(rub_prize) AS winningsRub
      FROM prize_rows
      GROUP BY telegram_id
    ),
    last_result AS (
      SELECT telegram_id, total_points AS lastResult FROM (
        SELECT res.telegram_id, res.total_points,
               ROW_NUMBER() OVER (PARTITION BY res.telegram_id ORDER BY g.date DESC) AS rn
        FROM results res
        JOIN games g ON g.id = res.game_id
      )
      WHERE rn = 1
    )
    SELECT p.telegram_id, p.display_name, p.games, p.total_points, p.wins, p.knockouts, p.rebuys,
           COALESCE(pr.winningsChips, 0) AS winningsChips,
           COALESCE(pr.winningsRub, 0) AS winningsRub,
           lr.lastResult AS lastResult
    FROM players p
    LEFT JOIN prizes pr ON pr.telegram_id = p.telegram_id
    LEFT JOIN last_result lr ON lr.telegram_id = p.telegram_id
    ORDER BY ${orderCol} DESC, p.registered_at ASC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function getPlayerRank(telegramId) {
  const rows = getRating();
  const idx = rows.findIndex(r => r.telegram_id === telegramId);
  return { rank: idx === -1 ? null : idx + 1, total: rows.length };
}

// доп. метрики, которых нет в players (агрегатной таблице): ITM, среднее место, бесплатные/платные игры
function getPlayerAdvancedStats(telegramId) {
  return db.prepare(`
    SELECT
      COUNT(*) AS games,
      -- "в призовых" = реально оплачиваемое место (топ-2 на ≤4 игроков, топ-3 на 5+ — та же
      -- раскладка, что и в prizeBreakdown), а НЕ положительные очки: за 3-е место на 4 игроков
      -- дают +2 очка (обошёл последнее место), но приза за него нет
      SUM(CASE WHEN r.place <= (CASE WHEN g.num_players <= 4 THEN 2 ELSE 3 END) THEN 1 ELSE 0 END) AS itm,
      AVG(place) AS avg_place,
      MAX(total_points) AS best_game,
      SUM(CASE WHEN g.buy_in = 0 THEN 1 ELSE 0 END) AS free_games,
      SUM(CASE WHEN g.buy_in > 0 THEN 1 ELSE 0 END) AS paid_games
    FROM results r
    JOIN games g ON g.id = r.game_id
    WHERE r.telegram_id = ?
  `).get(telegramId);
}

// игра, в которой игрок набрал больше всего очков за раз — для кликабельной ссылки в /me
function getPlayerBestGame(telegramId) {
  return db.prepare(`
    SELECT game_id, total_points
    FROM results
    WHERE telegram_id = ?
    ORDER BY total_points DESC
    LIMIT 1
  `).get(telegramId);
}

// призовые за место в конкретной игре — та же раскладка (2 места на 4 игроков, 3 на 5-8,
// последнее оплачиваемое место забирает остаток банка, чтобы сумма не уезжала от округления)
function prizeForPlace(place, bank, N) {
  const entry = prizeBreakdown(bank, N)[place - 1];
  return entry ? entry.amount : 0;
}

// реальные деньги — только платные игры, банк = реальный бай-ин
function getPlayerWinnings(telegramId) {
  const rows = db.prepare(`
    WITH game_banks AS (
      SELECT r.game_id AS game_id, SUM(g.buy_in * (1 + r.rebuys)) AS bank, g.buy_in AS buy_in, COUNT(*) AS n
      FROM results r
      JOIN games g ON g.id = r.game_id
      GROUP BY r.game_id
    )
    SELECT res.place, gb.bank, gb.n
    FROM results res
    JOIN game_banks gb ON gb.game_id = res.game_id
    WHERE res.telegram_id = ? AND gb.buy_in > 0 AND res.place <= 3
  `).all(telegramId);

  let total = 0;
  for (const row of rows) {
    total += prizeForPlace(row.place, row.bank, row.n);
  }
  return total;
}

// сколько всего вложено (бай-ины + докупки) в платные игры, реальными деньгами
function getPlayerInvested(telegramId) {
  const row = db.prepare(`
    SELECT SUM(g.buy_in * (1 + r.rebuys)) AS invested
    FROM results r
    JOIN games g ON g.id = r.game_id
    WHERE r.telegram_id = ? AND g.buy_in > 0
  `).get(telegramId);
  return row.invested || 0;
}

// фишки — та же механика, но по ВСЕМ играм: в платных банк = реальный бай-ин,
// в бесплатных — сохранённый стек этой конкретной игры (games.chip_stack)
function getPlayerChipsWinnings(telegramId) {
  const rows = db.prepare(`
    WITH game_banks AS (
      SELECT r.game_id AS game_id,
             SUM((CASE WHEN g.buy_in > 0 THEN g.buy_in ELSE g.chip_stack END) * (1 + r.rebuys)) AS bank,
             COUNT(*) AS n
      FROM results r
      JOIN games g ON g.id = r.game_id
      GROUP BY r.game_id
    )
    SELECT res.place, gb.bank, gb.n
    FROM results res
    JOIN game_banks gb ON gb.game_id = res.game_id
    WHERE res.telegram_id = ? AND res.place <= 3
  `).all(telegramId);

  let total = 0;
  for (const row of rows) {
    total += prizeForPlace(row.place, row.bank, row.n);
  }
  return total;
}

function getPlayerChipsInvested(telegramId) {
  const row = db.prepare(`
    SELECT SUM((CASE WHEN g.buy_in > 0 THEN g.buy_in ELSE g.chip_stack END) * (1 + r.rebuys)) AS invested
    FROM results r
    JOIN games g ON g.id = r.game_id
    WHERE r.telegram_id = ?
  `).get(telegramId);
  return row.invested || 0;
}

function getPlayerGamesCount(telegramId) {
  return db.prepare('SELECT COUNT(*) AS c FROM results WHERE telegram_id = ?').get(telegramId).c;
}

function getPlayerGamesPage(telegramId, offset, limit) {
  return db.prepare(`
    SELECT g.rowid AS game_no, g.id AS game_id, g.date, r.place, r.total_points
    FROM results r
    JOIN games g ON g.id = r.game_id
    WHERE r.telegram_id = ?
    ORDER BY g.date DESC
    LIMIT ? OFFSET ?
  `).all(telegramId, limit, offset);
}

// для админа: все игры, а не только те, где он сам участвовал (нужно для управления)
function getAllGamesCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM games').get().c;
}

function getAllGamesPage(offset, limit) {
  return db.prepare(`
    SELECT rowid AS game_no, id AS game_id, date, num_players, buy_in
    FROM games
    ORDER BY date DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

// прогноз номера ещё не сохранённой игры — для заголовка "Турнир №X" на старте; финальный
// номер (game_no = rowid) присваивается только при реальной записи в games
function getNextGameNo() {
  return db.prepare('SELECT COALESCE(MAX(rowid), 0) + 1 AS n FROM games').get().n;
}

function getGameById(gameId) {
  const game = db.prepare('SELECT rowid AS game_no, * FROM games WHERE id = ?').get(gameId);
  if (!game) return null;
  const results = db.prepare('SELECT * FROM results WHERE game_id = ? ORDER BY place ASC').all(gameId);
  return { game, results };
}

// ---------- admin: удаление / сброс / редактирование задним числом ----------

// снимает игрока с рейтинга; исторические протоколы игр, где он участвовал, не трогает
// (имя игрока там хранится отдельным снимком в results.player_name)
function deletePlayer(telegramId) {
  db.prepare('DELETE FROM players WHERE telegram_id = ?').run(telegramId);
}

// обнуляет карьерную статистику игрока, не трогая исторические протоколы игр
function resetPlayerStats(telegramId) {
  db.prepare(`
    UPDATE players SET games = 0, total_points = 0, wins = 0, knockouts = 0, rebuys = 0
    WHERE telegram_id = ?
  `).run(telegramId);
}

// полностью удаляет игру и отменяет её влияние на агрегированную статистику игроков
function deleteGame(gameId) {
  const results = db.prepare('SELECT * FROM results WHERE game_id = ?').all(gameId);
  const revert = db.prepare(`
    UPDATE players SET
      games = games - 1,
      total_points = total_points - @total,
      wins = wins - @win,
      knockouts = knockouts - @knockouts,
      rebuys = rebuys - @rebuys
    WHERE telegram_id = @telegramId
  `);
  const tx = db.transaction(() => {
    results.forEach(r => {
      revert.run({
        telegramId: r.telegram_id,
        total: r.total_points,
        win: r.place === 1 ? 1 : 0,
        knockouts: r.knockouts,
        rebuys: r.rebuys
      });
    });
    db.prepare('DELETE FROM results WHERE game_id = ?').run(gameId);
    db.prepare('DELETE FROM games WHERE id = ?').run(gameId);
  });
  tx();
}

// правит один результат в уже сохранённой игре (место/докупки/выбивания) и пересчитывает
// его очки за эту игру + разницу переносит в агрегированную статистику игрока
function updateGameResult(gameId, telegramId, { place, rebuys, knockouts }) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  const old = db.prepare('SELECT * FROM results WHERE game_id = ? AND telegram_id = ?').get(gameId, telegramId);
  if (!game || !old) return null;

  const placementPts = placementPoints(place, game.num_players);
  const total = placementPts - 2 * rebuys + knockouts;

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE results SET place = ?, rebuys = ?, knockouts = ?, placement_points = ?, total_points = ?
      WHERE game_id = ? AND telegram_id = ?
    `).run(place, rebuys, knockouts, placementPts, total, gameId, telegramId);

    db.prepare(`
      UPDATE players SET
        total_points = total_points - @oldTotal + @newTotal,
        wins = wins - @oldWin + @newWin,
        knockouts = knockouts - @oldKnockouts + @newKnockouts,
        rebuys = rebuys - @oldRebuys + @newRebuys
      WHERE telegram_id = @telegramId
    `).run({
      telegramId,
      oldTotal: old.total_points,
      newTotal: total,
      oldWin: old.place === 1 ? 1 : 0,
      newWin: place === 1 ? 1 : 0,
      oldKnockouts: old.knockouts,
      newKnockouts: knockouts,
      oldRebuys: old.rebuys,
      newRebuys: rebuys
    });
  });
  tx();
  return { place, rebuys, knockouts, placementPts, total };
}

// ---------- динамические титулы ----------
// титул держит РОВНО один человек — это переходящий рекорд, а не моментальный лидерборд: кто
// первым дошёл до какого-то значения, тот и держит титул, пока кто-то другой его не побьёт
// СТРОГО (не сравняет, а именно превзойдёт). Реализовано одним проходом по всей истории игр в
// хронологическом порядке — при равенстве выигрывает тот, кто добрался до этого значения раньше
// по времени, естественным образом, без отдельного тай-брейка. Ничего не хранится отдельно,
// пересчитывается заново при каждом вызове из полной истории (как и раньше)
function getTitleHolders() {
  const rows = db
    .prepare(
      `SELECT r.telegram_id AS telegramId, p.display_name AS name, r.place, r.rebuys, r.knockouts,
              r.total_points AS totalPoints, r.rank_before AS rankBefore, r.rank_after AS rankAfter,
              g.num_players AS numPlayers, g.date AS date
       FROM results r
       JOIN games g ON g.id = r.game_id
       JOIN players p ON p.telegram_id = r.telegram_id
       ORDER BY g.date ASC, g.id ASC`
    )
    .all();

  const running = {}; // telegramId -> бегущие показатели карьеры на момент текущей строки
  const holders = {}; // titleId -> { telegramId, name, value } — текущий держатель рекорда

  // держатель меняется, только если новое значение СТРОГО лучше — при равенстве прежний остаётся
  const claim = (titleId, telegramId, name, value, isBetter) => {
    const cur = holders[titleId];
    if (!cur || isBetter(value, cur.value)) holders[titleId] = { telegramId, name, value };
  };
  const higher = (a, b) => a > b;
  const lower = (a, b) => a < b;

  rows.forEach(r => {
    const id = r.telegramId;
    if (!running[id]) {
      running[id] = { knockouts: 0, games: 0, rebuys: 0, podium: 0, last: 0, bubble: 0, pointsSum: 0, neverRebought: true };
    }
    const st = running[id];
    st.knockouts += r.knockouts;
    st.games += 1;
    st.rebuys += r.rebuys;
    st.pointsSum += r.totalPoints;
    if (r.place <= 3) st.podium++;
    if (r.place === r.numPlayers) st.last++;
    const paidPlaces = r.numPlayers <= 4 ? 2 : 3;
    if (r.place === paidPlaces + 1) st.bubble++;
    if (r.rebuys > 0) st.neverRebought = false; // одна докупка — и претендентом на "Жаднич" больше не быть, даже задним числом

    if (st.knockouts > 0) claim('killer', id, r.name, st.knockouts, higher);
    claim('grinder', id, r.name, st.games, higher);
    if (st.rebuys > 0) claim('spender', id, r.name, st.rebuys, higher);
    if (st.podium > 0) claim('podium', id, r.name, st.podium, higher);
    if (st.last > 0) claim('lastPlace', id, r.name, st.last, higher);
    if (st.bubble > 0) claim('bubble', id, r.name, st.bubble, higher);
    // "Жаднич" — не просто порог, а рекорд по числу игр без единой докупки за карьеру
    if (st.neverRebought && st.games >= MIN_GAMES_FOR_AVG_TITLE) claim('cheapskate', id, r.name, st.games, higher);

    if (st.games >= MIN_GAMES_FOR_AVG_TITLE) {
      const avg = Math.round((st.pointsSum / st.games) * 10) / 10;
      claim('sweat', id, r.name, avg, higher);
      claim('bot', id, r.name, avg, lower);
    }

    // "Бык"/"Медведь" — лучший/худший скачок рейтинга ЗА ОДНУ ИГРУ когда-либо в истории лиги
    // (рекорд конкретной игры, а не "как у тебя дела в последней" — иначе титул не смог бы
    // держаться устойчиво: следующая же игра любого игрока переписывала бы его заново)
    if (r.rankBefore != null && r.rankAfter != null) {
      const delta = r.rankBefore - r.rankAfter;
      if (delta > 0) claim('bull', id, r.name, delta, higher);
      if (delta < 0) claim('bear', id, r.name, delta, lower);
    }
  });

  const result = {};
  ['killer', 'grinder', 'spender', 'cheapskate', 'podium', 'lastPlace', 'bubble', 'sweat', 'bot', 'bull', 'bear'].forEach(titleId => {
    result[titleId] = holders[titleId] ? [holders[titleId]] : [];
  });
  return result;
}

// личное соперничество: кто чаще всех выбивал этого игрока (nemesis) и кого чаще всех выбивал
// он сам (victim). Считается из events_log каждой сыгранной игры (BUST-события) — отдельной
// таблицы для этого нет, полный скан games на масштабах домашней лиги не проблема
function getHeadToHead(telegramId) {
  const rows = db.prepare('SELECT events_log FROM games WHERE events_log IS NOT NULL').all();
  const knockedOutBy = {};
  const knockedOut = {};
  const id = String(telegramId);
  for (const row of rows) {
    let log;
    try {
      log = JSON.parse(row.events_log);
    } catch {
      continue;
    }
    for (const ev of log) {
      if (ev.type !== 'BUST' || !ev.by) continue; // без выбивания (слил банк сам) — не влияет на h2h
      if (String(ev.id) === id) knockedOutBy[ev.by] = (knockedOutBy[ev.by] || 0) + 1;
      if (String(ev.by) === id) knockedOut[ev.id] = (knockedOut[ev.id] || 0) + 1;
    }
  }
  const topOf = map => {
    let bestId = null;
    let bestCount = 0;
    for (const [oppId, count] of Object.entries(map)) {
      if (count > bestCount) {
        bestId = oppId;
        bestCount = count;
      }
    }
    if (!bestId) return null;
    const player = getPlayerByTelegramId(Number(bestId));
    return { telegramId: Number(bestId), name: player ? player.display_name : 'Игрок', count: bestCount };
  };
  return { nemesis: topOf(knockedOutBy), victim: topOf(knockedOut) };
}

// ---------- ачивки ----------

function getPlayerAchievements(telegramId) {
  return db
    .prepare('SELECT achievement_id AS id, unlocked_at AS unlockedAt FROM achievements WHERE telegram_id = ?')
    .all(telegramId);
}

// вызывается сразу после saveGameResults для этой же игры — на каждого участника проверяет все
// условия ачивок и разблокирует новые (INSERT OR IGNORE — за счёт PRIMARY KEY повторная
// разблокировка молча не делает ничего). results — тот же массив, что передавался в
// saveGameResults ({telegramId, place, rebuys, knockouts, ...}). Возвращает вновь разблокированные
// [{telegramId, achievementId}] — чтобы можно было объявить об этом в протоколе
function checkAndUnlockAchievements(gameId, results) {
  const N = results.length;
  const unlockStmt = db.prepare(
    'INSERT OR IGNORE INTO achievements (telegram_id, achievement_id, game_id, unlocked_at) VALUES (?, ?, ?, ?)'
  );
  const streakStmt = db.prepare(
    `SELECT r.place, g.num_players AS numPlayers
     FROM results r JOIN games g ON g.id = r.game_id
     WHERE r.telegram_id = ?
     ORDER BY g.date DESC LIMIT 3`
  );

  const unlocked = [];
  const unlock = (telegramId, achievementId) => {
    const info = unlockStmt.run(telegramId, achievementId, gameId, new Date().toISOString());
    if (info.changes > 0) unlocked.push({ telegramId, achievementId });
  };

  // "Соло" — реально РАЗНЫХ соперников выбил лично, а не просто набрал N-1 нокаутов: если кто-то
  // докупался и его выбивали повторно, счётчик нокаутов растёт быстрее числа реально выбитых людей
  const gameRow = db.prepare('SELECT events_log FROM games WHERE id = ?').get(gameId);
  let bustEvents = [];
  if (gameRow && gameRow.events_log) {
    try {
      bustEvents = JSON.parse(gameRow.events_log).filter(e => e.type === 'BUST' && e.by);
    } catch {
      bustEvents = [];
    }
  }

  results.forEach(r => {
    const player = getPlayerByTelegramId(r.telegramId); // уже с учётом этой игры — saveGameResults вызывается раньше
    if (!player) return;

    if (player.games === 1) unlock(r.telegramId, 'debut');
    if (r.place === 1 && player.wins === 1) unlock(r.telegramId, 'firstWin');
    if (r.place === 1 && r.rebuys > 0) unlock(r.telegramId, 'phoenix');
    if (r.place === 1 && r.rebuys === 0) unlock(r.telegramId, 'skillOnly');
    const distinctVictims = new Set(
      bustEvents.filter(e => String(e.by) === String(r.telegramId)).map(e => e.id)
    );
    if (N > 1 && distinctVictims.size === N - 1) unlock(r.telegramId, 'solo');
    if (player.games >= 50) unlock(r.telegramId, 'veteran');
    if (player.total_points !== 0 && player.total_points % 100 === 0) unlock(r.telegramId, 'round100');
    if (r.knockouts === 0) unlock(r.telegramId, 'peacemaker');

    const streak = streakStmt.all(r.telegramId);
    if (streak.length === 3 && streak.every(s => s.place === 1)) unlock(r.telegramId, 'hatTrick');
    if (streak.length === 3 && streak.every(s => s.place === s.numPlayers)) unlock(r.telegramId, 'rockBottom');
  });

  return unlocked;
}

// консистентный snapshot БД для бэкапа через официальный SQLite backup API — в отличие от
// сырого копирования файла poker.db, корректно учитывает WAL-режим (недавние записи могут
// лежать только в poker.db-wal, отдельно от основного файла, и наивный fs-копир их бы не увидел)
function backupDatabaseTo(destPath) {
  return db.backup(destPath);
}

function closeDatabase() {
  db.close();
}

module.exports = {
  db,
  registerPlayer,
  getAllPlayers,
  getPlayerByTelegramId,
  saveGameResults,
  getRating,
  getRatingCount,
  getRatingPage,
  getPlayerRank,
  getPlayerAdvancedStats,
  getPlayerBestGame,
  getPlayerWinnings,
  getPlayerInvested,
  getPlayerChipsWinnings,
  getPlayerChipsInvested,
  prizeForPlace,
  NOMINAL_CHIP_STACK,
  getPlayerGamesCount,
  getPlayerGamesPage,
  getAllGamesCount,
  getAllGamesPage,
  getGameById,
  getNextGameNo,
  deletePlayer,
  resetPlayerStats,
  deleteGame,
  updateGameResult,
  backupDatabaseTo,
  closeDatabase,
  getTitleHolders,
  getHeadToHead,
  getPlayerAchievements,
  checkAndUnlockAchievements
};
