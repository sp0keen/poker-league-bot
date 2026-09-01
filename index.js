require('dotenv').config();
const crypto = require('crypto');
const { Telegraf, Markup, Input } = require('telegraf');
const { placementPoints, PLACEMENT_POINTS } = require('./scoring');
const {
  registerPlayer,
  getAllPlayers,
  getPlayerByTelegramId,
  saveGameResults,
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
  updateGameResult
} = require('./db');
const {
  STANDARD_CHIPSET,
  TEMPO_PRESETS,
  computeStandardStack,
  computeTargetStack,
  computeBlindLevels,
  computeRebuySchedule,
  computeDenomSchedule,
  activeDenomsAtLevel,
  prizeBreakdown,
  parseChipSet
} = require('./chipStructure');
const {
  getState,
  setState,
  clearState,
  getActiveGames,
  hasActiveGames,
  addPendingApproval,
  getPendingApproval,
  getAllPendingApprovals,
  removePendingApproval
} = require('./state');
const { createBackupArchive, inspectBackupArchive, applyBackupArchive } = require('./backup');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is not set (см. .env)');
  process.exit(1);
}
if (!ADMIN_IDS.length) {
  console.error('ADMIN_IDS is not set (см. .env) — некому будет создавать игры');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

let BOT_USERNAME = null; // заполняется при старте, нужен для диплинков на профиль игрока

function isAdmin(ctx) {
  return ADMIN_IDS.includes(ctx.from.id);
}

// владелец (ADMIN_IDS) — единолично подтверждает завершённые турниры и правит/удаляет данные.
// организатором (кто может начать и вести игру) может быть любой зарегистрированный игрок —
// это безопасно, потому что итог всё равно не попадёт в статистику без подтверждения владельца.
function canOrganize(ctx) {
  return isAdmin(ctx) || !!getPlayerByTelegramId(ctx.from.id);
}

// каждый управляет только своим столом (макс. 1 на человека); владелец может временно
// "войти" в чужой стол через 🕹 Активные турниры — тогда gameOwnerId возвращает его владельца
const actingOwner = new Map(); // adminTelegramId -> ownerId стола, которым он сейчас управляет

function gameOwnerId(ctx) {
  if (isAdmin(ctx) && actingOwner.has(ctx.from.id)) return actingOwner.get(ctx.from.id);
  return ctx.from.id;
}

function displayNameOf(from) {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || `id${from.id}`;
}

// ---------- HTML formatting helpers ----------

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function b(s) {
  return `<b>${esc(s)}</b>`;
}
function i(s) {
  return `<i>${esc(s)}</i>`;
}
// кликабельное имя игрока — диплинк t.me/бот?start=player_<id>, открывает его профиль
function playerLink(telegramId, name) {
  if (!BOT_USERNAME) return `<b>${esc(name)}</b>`;
  return `<b><a href="https://t.me/${BOT_USERNAME}?start=player_${telegramId}">${esc(name)}</a></b>`;
}

const HTML = { parse_mode: 'HTML' };
function kb(rows) {
  return { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(rows).reply_markup };
}

// ---------- rich messages (Bot API 10.1, sendRichMessage) ----------
// Telegraf не знает про этот метод — зовём Bot API напрямую.
// rich_message.html принимает расширенный HTML: h1-h6, table, ul/ol, blockquote (в т.ч. expandable) и т.д.

async function callTelegramApi(method, payload) {
  const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`${method} failed: ${data.description}`);
  return data.result;
}

async function sendRichRaw(chatId, html, replyMarkup) {
  const payload = { chat_id: chatId, rich_message: { html } };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    return await callTelegramApi('sendRichMessage', payload);
  } catch (err) {
    console.error('sendRichMessage failed, falling back to plain text:', err.message);
    const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const fallbackPayload = { chat_id: chatId, text: plain };
    if (replyMarkup) fallbackPayload.reply_markup = replyMarkup;
    return callTelegramApi('sendMessage', fallbackPayload);
  }
}

function sendRich(chatId, html, keyboardRows) {
  return sendRichRaw(chatId, html, keyboardRows ? Markup.keyboard(keyboardRows).resize().reply_markup : undefined);
}

function sendRichInline(chatId, html, inlineRows) {
  return sendRichRaw(chatId, html, inlineRows ? Markup.inlineKeyboard(inlineRows).reply_markup : undefined);
}

// ---------- single-live-message panel: delete the previous bot message before showing a new one ----------

const lastMessageId = new Map(); // chatId -> message_id of the current live bot message

async function showPanel(ctx, text, extra = HTML) {
  const chatId = ctx.chat.id;
  const prevId = lastMessageId.get(chatId);
  if (prevId) {
    try {
      await ctx.telegram.deleteMessage(chatId, prevId);
    } catch (e) {
      // message already gone / too old to delete — ignore
    }
  }
  const sent = await ctx.reply(text, extra);
  lastMessageId.set(chatId, sent.message_id);
  return sent;
}

// как showPanel, но через sendRichMessage (для содержательных экранов с таблицами)
async function showRichPanel(ctx, html, keyboardRows) {
  const chatId = ctx.chat.id;
  const prevId = lastMessageId.get(chatId);
  if (prevId) {
    try {
      await ctx.telegram.deleteMessage(chatId, prevId);
    } catch (e) {
      // ignore
    }
  }
  const sent = await sendRich(chatId, html, keyboardRows);
  lastMessageId.set(chatId, sent.message_id);
  return sent;
}

// как showRichPanel, но с inline-кнопками (для интерактивных списков вроде истории игр)
async function showRichPanelInline(ctx, html, inlineRows) {
  const chatId = ctx.chat.id;
  const prevId = lastMessageId.get(chatId);
  if (prevId) {
    try {
      await ctx.telegram.deleteMessage(chatId, prevId);
    } catch (e) {
      // ignore
    }
  }
  const sent = await sendRichInline(chatId, html, inlineRows);
  lastMessageId.set(chatId, sent.message_id);
  return sent;
}

// ---------- level system (career total_points ~ ELO) ----------

// минимум очков для уровней 1..10; шаг растёт, чтобы прогресс ощущался как прогресс
const LEVEL_THRESHOLDS = [0, 15, 35, 60, 90, 125, 165, 210, 260, 315];
const LEVEL_TIERS = [
  [1, 3, '🟢 Новичок'],
  [4, 6, '🟡 Любитель'],
  [7, 8, '🟠 Профи'],
  [9, 10, '🔴 Мастер']
];

function levelOf(points) {
  const p = Math.max(0, points);
  let level = 1;
  for (let idx = 0; idx < LEVEL_THRESHOLDS.length; idx++) {
    if (p >= LEVEL_THRESHOLDS[idx]) level = idx + 1;
  }
  return level;
}

function levelTierName(level) {
  const tier = LEVEL_TIERS.find(([from, to]) => level >= from && level <= to);
  return tier ? tier[2] : '';
}

function levelBadgeHtml(points) {
  const p = Math.max(0, points);
  const level = levelOf(p);
  const tierName = levelTierName(level);
  if (level >= 10) {
    return `<p>🏅 <b>Уровень 10/10 (макс.)</b> — ${tierName}</p>`;
  }
  const curMin = LEVEL_THRESHOLDS[level - 1];
  const nextMin = LEVEL_THRESHOLDS[level];
  const span = nextMin - curMin;
  const into = p - curMin;
  const filled = Math.round((10 * into) / span);
  const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);
  return (
    `<p>🏅 <b>Уровень ${level}/10</b> — ${tierName}</p>` +
    `<p>${bar} ${into}/${span} очков до уровня ${level + 1}</p>`
  );
}

// компактный бейдж уровня для таблиц (не развёрнутый блок как в /me) — эмодзи тира + номер
function levelBadgeShort(points) {
  const level = levelOf(Math.max(0, points));
  const tier = LEVEL_TIERS.find(([from, to]) => level >= from && level <= to);
  const emoji = tier ? tier[2].split(' ')[0] : '';
  return `${emoji}${level}`;
}

// ---------- persistent bottom keyboards: two "pages" — main menu and the game panel ----------

const BTN_RATING = '🏆 Рейтинг';
const BTN_ME = '👤 Моя статистика';
const BTN_HISTORY = '📜 История';
const BTN_NEWGAME = '🎮 Новая игра';
const BTN_CHANNEL = '📢 Telegram-канал';
const BTN_RULES = '📋 Правила';
const BTN_REBUY = '💰 Докупка';
const BTN_OUT = '❌ Выбывание';
const BTN_NEXT_LEVEL = '▶️ Следующий уровень';
const BTN_CANCEL = '↩️ Отменить последнее';
const BTN_GAME_RULES = '📋 Правила турнира';
const BTN_ENDGAME = '🏁 Завершить турнир';
const BTN_BACK_TO_MENU = '⬅️ Главное меню';
const BTN_ACTIVE_GAMES = '🕹 Активные турниры';

// Главное меню: новая игра (только если у этого пользователя ещё нет своего стола — на человека
// максимум один), активные турниры (видна всем, если хоть один стол открыт — владельцу все с
// управлением, организатору со своим столом сразу его стол, остальным чужие турниры можно только
// смотреть в реальном времени, без управления), правила турнира, статистика/рейтинг, история/канал
function menuRows(ctx) {
  const rows = [];
  const myTable = getState(ctx.from.id);
  if (canOrganize(ctx) && !myTable) rows.push([BTN_NEWGAME]);
  if (hasActiveGames()) rows.push([BTN_ACTIVE_GAMES]);
  rows.push([BTN_ME, BTN_RATING]);
  rows.push([BTN_HISTORY, BTN_RULES]);
  if (CHANNEL_ID) rows.push([BTN_CHANNEL]);
  return rows;
}

// Панель управления игрой: действия за столом + возврат в меню. Кнопки докупки нет вообще,
// если в наборе не осталось резерва фишек на неё прямо сейчас (canRebuyNow)
function hasNextLevel(state) {
  const levels = state && state.structure && state.structure.levels;
  return Boolean(levels && (state.blindLevel || 0) < levels.length - 1);
}

// докупка не только физически/по расписанию разрешена (canRebuyNow), но и есть кому её сделать —
// кто-то выбыл и ещё не упёрся в личный лимит докупок
function hasRebuyCandidate(state) {
  const maxRebuys = maxRebuysConfigured(state);
  return state.busted.some(id => state.rebuys[id] < maxRebuys);
}

function gameRows(state) {
  const topRow = [
    ...(hasNextLevel(state) ? [BTN_NEXT_LEVEL] : []),
    BTN_OUT,
    ...(state && canRebuyNow(state) && hasRebuyCandidate(state) ? [BTN_REBUY] : [])
  ];
  return [topRow, [BTN_CANCEL], [BTN_GAME_RULES], [BTN_ENDGAME, BTN_BACK_TO_MENU]];
}

function replyKb(rows) {
  return { parse_mode: 'HTML', reply_markup: Markup.keyboard(rows).resize().reply_markup };
}

// ---------- registration ----------

bot.start(async ctx => {
  const isNew = registerPlayer(ctx.from.id, ctx.from.username || null, displayNameOf(ctx.from));

  // диплинк вида t.me/бот?start=player_<id> — переход с кликабельного имени в таблице
  const playerMatch = ctx.startPayload && ctx.startPayload.match(/^player_(\d+)$/);
  if (playerMatch) {
    return showPlayerProfile(ctx, Number(playerMatch[1]));
  }

  // диплинк вида t.me/бот?start=game_<id> — переход по клику на "лучший результат" в /me
  const gameMatch = ctx.startPayload && ctx.startPayload.match(/^game_([0-9a-f-]+)$/);
  if (gameMatch) {
    return showGameProtocol(ctx, gameMatch[1], 0);
  }

  const text = isNew
    ? `🎉 Привет, ${b(displayNameOf(ctx.from))}!\nТы зарегистрирован в покерной лиге.`
    : `👋 С возвращением, ${b(displayNameOf(ctx.from))}!`;
  await showPanel(ctx, text, replyKb(menuRows(ctx)));
});

// ---------- main menu navigation ----------

bot.hears(BTN_BACK_TO_MENU, ctx => {
  actingOwner.delete(ctx.from.id); // выходя в меню, владелец перестаёт "управлять" чужим столом
  showPanel(ctx, '🏠 Главное меню', replyKb(menuRows(ctx)));
});

bot.action('back:menu', ctx => {
  ctx.answerCbQuery();
  showPanel(ctx, '🏠 Главное меню', replyKb(menuRows(ctx)));
});

// владелец: обзор всех открытых столов с управлением (у каждого пользователя не больше одного
// стола); обычный организатор своей кнопкой сразу попадает в свой стол, без списка и чужих данных
function activeGameCardHtml({ ownerId, state }) {
  const organizer = getPlayerByTelegramId(ownerId);
  const names = Object.values(state.players).map(esc).join(', ');
  return (
    `<p>🏆 <b>Турнир №${state.gameNo}</b><br>` +
    `👤 <b>${esc(organizer ? organizer.display_name : `id${ownerId}`)}</b><br>` +
    `🕐 ${fmtDate(state.date)}, ${fmtTime(state.date)}<br>` +
    `👥 ${Object.keys(state.players).length} игроков: ${names}</p>`
  );
}

bot.hears(BTN_ACTIVE_GAMES, async ctx => {
  if (!isAdmin(ctx)) {
    const games = getActiveGames();
    if (!games.length) return showPanel(ctx, '🕹 Активных турниров нет.', replyKb(menuRows(ctx)));

    // ровно один турнир и без выбора — сразу в него (играть свой или смотреть чужой)
    if (games.length === 1) {
      const only = games[0];
      if (only.ownerId === ctx.from.id) return showRichPanel(ctx, statusHtml(only.state), gameRows(only.state));
      return showRichPanelInline(ctx, statusHtml(only.state), [
        [{ text: '📋 Правила турнира', callback_data: `ag:rules:${only.ownerId}` }],
        [{ text: '⬅️ Главное меню', callback_data: 'hist:menu' }]
      ]);
    }

    // турниров несколько (например свой + чужой, где просто зовут поиграть) — отдельное
    // сообщение на каждый: свой стол — играть, остальные — только смотреть в реальном времени
    const chatId = ctx.chat.id;
    const prevId = lastMessageId.get(chatId);
    if (prevId) {
      try {
        await ctx.telegram.deleteMessage(chatId, prevId);
      } catch (e) {
        // уже удалено/устарело — не страшно
      }
    }
    for (const game of games) {
      const isMine = game.ownerId === ctx.from.id;
      const rows = [[{ text: isMine ? '▶️ Играть' : '👁 Смотреть', callback_data: isMine ? `ag:play:${game.ownerId}` : `ag:view:${game.ownerId}` }]];
      // не трогаем lastMessageId здесь — иначе финальный showPanel удалит последнюю карточку
      await sendRichInline(chatId, activeGameCardHtml(game), rows);
    }
    return showPanel(ctx, `🕹 Активных турниров: ${games.length}. Выбери один выше.`, replyKb(menuRows(ctx)));
  }

  const games = getActiveGames();
  if (!games.length) return showPanel(ctx, '🕹 Активных турниров нет.', replyKb(menuRows(ctx)));

  // отдельное сообщение на каждый турнир — у каждого свои "Войти"/"Удалить", не общая сетка
  const chatId = ctx.chat.id;
  const prevId = lastMessageId.get(chatId);
  if (prevId) {
    try {
      await ctx.telegram.deleteMessage(chatId, prevId);
    } catch (e) {
      // уже удалено/устарело — не страшно
    }
  }
  for (const game of games) {
    const rows = [
      [
        { text: '➡️ Войти', callback_data: `ag:enter:${game.ownerId}` },
        { text: '🗑 Удалить', callback_data: `ag:abort:${game.ownerId}` }
      ]
    ];
    // не трогаем lastMessageId здесь — иначе следующий showPanel сочтёт последнюю карточку
    // "предыдущим единственным сообщением" и удалит именно её
    await sendRichInline(chatId, activeGameCardHtml(game), rows);
  }
  await showPanel(ctx, `🕹 Активных турниров: ${games.length}. Выбери один выше.`, replyKb(menuRows(ctx)));
});

// вход в свой стол со списка активных турниров (когда их несколько) — не "войти в чужой" как
// у владельца, поэтому доступно только самому себе, без прав администратора
bot.action(/^ag:play:(\d+)$/, ctx => {
  const ownerId = Number(ctx.match[1]);
  if (ownerId !== ctx.from.id) return ctx.answerCbQuery('Это не твой стол');
  const state = getState(ownerId);
  ctx.answerCbQuery();
  if (!state) return showPanel(ctx, 'Этот стол уже закрыт.', replyKb(menuRows(ctx)));
  showRichPanel(ctx, statusHtml(state), gameRows(state));
});

// только просмотр, без управления — доступно любому, у кого нет своего стола
bot.action(/^ag:view:(\d+)$/, ctx => {
  const ownerId = Number(ctx.match[1]);
  const state = getState(ownerId);
  ctx.answerCbQuery();
  if (!state) return showPanel(ctx, 'Этот стол уже закрыт.', replyKb(menuRows(ctx)));
  showRichPanelInline(ctx, statusHtml(state), [
    [{ text: '📋 Правила турнира', callback_data: `ag:rules:${ownerId}` }],
    [{ text: '⬅️ Главное меню', callback_data: 'hist:menu' }]
  ]);
});

// правила чужого турнира при просмотре — доступно любому, не только участникам/владельцу
bot.action(/^ag:rules:(\d+)$/, ctx => {
  const ownerId = Number(ctx.match[1]);
  const state = getState(ownerId);
  ctx.answerCbQuery();
  if (!state) return showPanel(ctx, 'Этот стол уже закрыт.', replyKb(menuRows(ctx)));
  const html = state.structure
    ? gameRulesHtml({ state, ...state.structure })
    : '<p>Для этой игры правила не сохранились.</p>';
  showRichPanelInline(ctx, html, [[{ text: '⬅️ Назад', callback_data: `ag:view:${ownerId}` }]]);
});

bot.action(/^ag:enter:(\d+)$/, ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Только для владельца');
  const ownerId = Number(ctx.match[1]);
  const state = getState(ownerId);
  ctx.answerCbQuery();
  if (!state) return showPanel(ctx, 'Этот стол уже закрыт.', replyKb(menuRows(ctx)));
  actingOwner.set(ctx.from.id, ownerId);
  showRichPanel(ctx, statusHtml(state), gameRows(state));
});

bot.action(/^ag:abort:(\d+)$/, ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Только для владельца');
  const ownerId = Number(ctx.match[1]);
  if (!getState(ownerId)) return ctx.answerCbQuery('Этот стол уже закрыт');
  ctx.answerCbQuery();
  showRichPanelInline(
    ctx,
    '<p>🗑 Точно отменить этот турнир целиком? Все его данные (докупки, выбивания) потеряются без возможности восстановить. Статистику это не тронет — она и так ещё не записана.</p>',
    [[{ text: '✅ Да, отменить', callback_data: `ag:abortConfirm:${ownerId}` }, { text: '❌ Не трогать', callback_data: 'hist:menu' }]]
  );
});

bot.action(/^ag:abortConfirm:(\d+)$/, async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Только для владельца');
  const ownerId = Number(ctx.match[1]);
  const state = getState(ownerId);
  if (!state) return ctx.answerCbQuery('Этот стол уже закрыт');
  clearState(ownerId);
  if (actingOwner.get(ctx.from.id) === ownerId) actingOwner.delete(ctx.from.id);
  ctx.answerCbQuery('Турнир отменён');
  await showPanel(ctx, '🗑 Турнир отменён.', replyKb(menuRows(ctx)));
  if (ownerId !== ctx.from.id) {
    await ctx.telegram.sendMessage(ownerId, '🗑 Владелец лиги отменил ваш текущий турнир целиком.').catch(() => {});
  }
});

bot.hears(BTN_CHANNEL, ctx => {
  const username = CHANNEL_ID && CHANNEL_ID.startsWith('@') ? CHANNEL_ID.slice(1) : null;
  if (!username) return showPanel(ctx, 'Канал не настроен.', replyKb(menuRows(ctx)));
  showPanel(ctx, '📢 Протоколы турниров публикуются здесь:', {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📢 Открыть канал', url: `https://t.me/${username}` }],
        [{ text: '⬅️ Главное меню', callback_data: 'hist:menu' }]
      ]
    }
  });
});

// правила для стандартного набора фишек (главное меню) — тот же расчёт и тот же компактный
// вид, что и у "Правил турнира" внутри конкретной игры, просто по дефолтному набору
// таблица начисления очков — только на главной странице "Правила", в конкретном турнире
// (gameRulesHtml со state) не дублируется
function scoringRulesHtml() {
  const rows = Object.keys(PLACEMENT_POINTS)
    .sort((a, b) => a - b)
    .map(N => `<tr><td>${N}</td><td>${PLACEMENT_POINTS[N].join(', ')}</td></tr>`)
    .join('');
  return (
    `<h3>🏅 Очки за место</h3>` +
    `<table><tr><th>Игроков</th><th>Очки за место</th></tr>${rows}</table>` +
    `<p>🔪 <b>Выбивание:</b> +1 очко тому, кто выбил.<br>` +
    `💰 <b>Докупка:</b> −2 очка за каждую (максимум 2 докупки на игрока).</p>`
  );
}

function rulesHtml() {
  const denoms = STANDARD_CHIPSET;
  const stackResult = computeStandardStack(denoms, 8);
  const levels = computeBlindLevels(denoms);
  const rebuyRule = computeRebuySchedule(levels);
  const denomSchedule = computeDenomSchedule(denoms, levels);
  return gameRulesHtml({ stackResult, levels, rebuyRule, denomSchedule, buyIn: 0 }) + scoringRulesHtml();
}

bot.hears(BTN_RULES, ctx => {
  showRichPanelInline(ctx, rulesHtml(), [[Markup.button.callback('⬅️ Главное меню', 'hist:menu')]]);
});

// ---------- new game: набор фишек -> формат -> игроки -> расчёт и старт ----------
// pendingNewGame[adminId] = { chipSet, buyIn, selected: Set<telegramId>, stage }
const pendingNewGame = new Map();

// игроки, которые сейчас не участвуют ни в одном открытом турнире (за любым столом можно
// играть только за одним одновременно) — только их можно звать в новую игру
function getAvailablePlayers() {
  const busyIds = new Set();
  getActiveGames().forEach(({ state }) => {
    Object.keys(state.players).forEach(id => busyIds.add(String(id)));
  });
  return getAllPlayers().filter(p => !busyIds.has(String(p.telegram_id)));
}

function newGameKeyboard(selected) {
  const players = getAvailablePlayers();
  const rows = players.map(p => [
    Markup.button.callback(
      `${selected.has(p.telegram_id) ? '✅' : '⬜'} ${p.display_name}`,
      `ng:toggle:${p.telegram_id}`
    )
  ]);
  rows.push([
    Markup.button.callback(`▶️ Начать (${selected.size})`, 'ng:done'),
    Markup.button.callback('❌ Отмена', 'ng:cancel')
  ]);
  return rows;
}

function chipSetSummary(denoms) {
  return denoms.map(d => `${d.value}×${d.count}`).join(', ');
}

function chipSetPrompt() {
  return {
    text: `🃏 ${b('Набор фишек')}\nСтандартный (${chipSetSummary(STANDARD_CHIPSET)}) или свой?`,
    keyboard: kb([
      [Markup.button.callback('📦 Стандартный', 'ng:chip:standard')],
      [Markup.button.callback('✏️ Свой набор', 'ng:chip:custom')],
      [Markup.button.callback('❌ Отмена', 'ng:cancel')]
    ])
  };
}

async function startNewGameFlow(ctx) {
  if (ctx.chat.type !== 'private') return ctx.reply('Создавай игру в личке с ботом.');
  if (!canOrganize(ctx)) return showPanel(ctx, '🔒 Сначала напиши /start, чтобы зарегистрироваться.', replyKb(menuRows(ctx)));
  actingOwner.delete(ctx.from.id); // "Новая игра" — это всегда про свой стол

  const myState = getState(ctx.from.id);
  if (myState) {
    return showRichPanel(ctx, statusHtml(myState), gameRows(myState));
  }

  pendingNewGame.set(ctx.from.id, {});
  const p = chipSetPrompt();
  await showPanel(ctx, p.text, p.keyboard);
}

bot.command('newgame', startNewGameFlow);
bot.hears(BTN_NEWGAME, startNewGameFlow);

bot.action('ng:cancel', ctx => {
  pendingNewGame.delete(ctx.from.id);
  ctx.answerCbQuery();
  // showPanel, не editMessageText: нужно восстановить постоянную клавиатуру снизу
  showPanel(ctx, '❌ Отменено.', replyKb(menuRows(ctx)));
});

// --- шаг 1: набор фишек ---

bot.action('ng:chip:standard', ctx => {
  const pending = pendingNewGame.get(ctx.from.id);
  if (!pending) return ctx.answerCbQuery('Сессия выбора истекла, запусти /newgame заново');
  pending.chipSet = STANDARD_CHIPSET;
  ctx.answerCbQuery();
  const p = buyInPrompt();
  ctx.editMessageText(p.text, p.keyboard);
});

bot.action('ng:chip:custom', ctx => {
  const pending = pendingNewGame.get(ctx.from.id);
  if (!pending) return ctx.answerCbQuery('Сессия выбора истекла, запусти /newgame заново');
  pending.stage = 'chip_custom';
  ctx.answerCbQuery();
  ctx.editMessageText(
    '✏️ Введи номиналы и количество в наличии через запятую, например:\n5=120,10=120,25=120,50=120,100=120',
    kb([[Markup.button.callback('❌ Отмена', 'ng:cancel')]])
  );
});

// --- шаг 2: формат (бесплатно / бай-ин) ---

function buyInPrompt() {
  return {
    text: `💵 ${b('Формат игры')}\nБесплатно, или на деньги (бай-ин = целевой стек, докупка — по той же цене)?`,
    keyboard: kb([
      [Markup.button.callback('🆓 Бесплатно', 'ng:free')],
      [
        Markup.button.callback('300 ₽', 'ng:buyin:300'),
        Markup.button.callback('500 ₽', 'ng:buyin:500'),
        Markup.button.callback('1000 ₽', 'ng:buyin:1000')
      ],
      [Markup.button.callback('✏️ Своя сумма', 'ng:buyin:custom')],
      [Markup.button.callback('❌ Отмена', 'ng:cancel')]
    ])
  };
}

bot.action('ng:free', ctx => {
  const pending = pendingNewGame.get(ctx.from.id);
  if (!pending) return ctx.answerCbQuery('Сессия выбора истекла, запусти /newgame заново');
  pending.buyIn = 0;
  ctx.answerCbQuery();
  // если игроки уже были выбраны (вернулись сюда со шкрана рекомендаций менять бай-ин) —
  // не спрашиваем их заново, а сразу пересчитываем и показываем рекомендации/старт
  if (pending.selected) return evaluateAndProceed(ctx, pending);
  askPlayers(ctx, true);
});

bot.action(/^ng:buyin:(\d+)$/, ctx => {
  const pending = pendingNewGame.get(ctx.from.id);
  if (!pending) return ctx.answerCbQuery('Сессия выбора истекла, запусти /newgame заново');
  pending.buyIn = Number(ctx.match[1]);
  ctx.answerCbQuery();
  if (pending.selected) return evaluateAndProceed(ctx, pending);
  askPlayers(ctx, true);
});

bot.action('ng:buyin:custom', ctx => {
  const pending = pendingNewGame.get(ctx.from.id);
  if (!pending) return ctx.answerCbQuery('Сессия выбора истекла, запусти /newgame заново');
  pending.stage = 'buyin_custom';
  ctx.answerCbQuery();
  ctx.editMessageText(
    '✏️ Введи сумму бай-ина в рублях (например 500):',
    kb([[Markup.button.callback('❌ Отмена', 'ng:cancel')]])
  );
});

// свободный ввод — номиналы фишек или сумма бай-ина, единственные места, где боту нужен произвольный текст
bot.on('text', (ctx, next) => {
  const pending = pendingNewGame.get(ctx.from.id);
  if (!pending) return next();

  if (pending.stage === 'chip_custom') {
    const parsed = parseChipSet(ctx.message.text);
    if (!parsed) {
      return ctx.reply('Не понял формат. Пример: 5=120,10=120,25=120,50=120,100=120\nПопробуй ещё раз:');
    }
    pending.chipSet = parsed;
    pending.stage = undefined;
    const p = buyInPrompt();
    return ctx.reply(p.text, p.keyboard);
  }

  if (pending.stage === 'buyin_custom') {
    const amount = Number(ctx.message.text.trim().replace(/\s/g, ''));
    if (!Number.isInteger(amount) || amount <= 0) {
      return ctx.reply('Нужно целое положительное число, например 500. Попробуй ещё раз:');
    }
    pending.buyIn = amount;
    pending.stage = undefined;
    if (pending.selected) return evaluateAndProceed(ctx, pending);
    return askPlayers(ctx, false);
  }

  return next();
});

// --- шаг 3: игроки ---

function askPlayers(ctx, editable) {
  const players = getAvailablePlayers();
  if (players.length < 4) {
    pendingNewGame.delete(ctx.from.id);
    const msg = `Свободных игроков (не занятых в других турнирах): ${players.length}. Нужно минимум 4.`;
    return editable ? ctx.editMessageText(msg) : ctx.reply(msg);
  }
  const pending = pendingNewGame.get(ctx.from.id);
  pending.selected = new Set();
  const text = `👥 ${b('Участники')}\nВыбери 4–8 игроков:`;
  const keyboard = kb(newGameKeyboard(pending.selected));
  if (editable) ctx.editMessageText(text, keyboard);
  else ctx.reply(text, keyboard);
}

bot.action(/^ng:toggle:(\d+)$/, ctx => {
  const pending = pendingNewGame.get(ctx.from.id);
  if (!pending || !pending.selected) return ctx.answerCbQuery('Сессия выбора истекла, запусти /newgame заново');
  const id = Number(ctx.match[1]);
  if (pending.selected.has(id)) pending.selected.delete(id);
  else {
    if (pending.selected.size >= 8) return ctx.answerCbQuery('Максимум 8 игроков');
    // подстраховка от гонки: вдруг игрока позвали в другой стол, пока эта клавиатура была открыта
    const stillFree = getActiveGames().every(({ state }) => !state.players[id]);
    if (!stillFree) return ctx.answerCbQuery('Этот игрок уже занят в другом турнире');
    pending.selected.add(id);
  }
  ctx.editMessageReplyMarkup(kb(newGameKeyboard(pending.selected)).reply_markup);
  ctx.answerCbQuery();
});

// --- шаг 4: расчёт структуры и старт ---

function prizeTableRows(prizes, unit) {
  const medal = ['🥇', '🥈', '🥉'];
  return prizes
    .filter(p => p.amount > 0)
    .map(p => `<tr><td>${medal[p.place - 1] || p.place} ${p.place}</td><td>${p.amount} ${unit}</td></tr>`)
    .join('');
}

// сколько стеков реально написано в статичном расписании докупок для этого уровня — режем до
// того, сколько физически позволяет остаток набора (maxStacks), чтобы "До 2 стеков" не вводило
// в заблуждение, когда набора хватает физически только на 1
function cappedRebuyLabel(label, maxStacks) {
  const m = label.match(/(\d+)/);
  if (!m || maxStacks == null) return label;
  const cap = Math.min(Number(m[1]), maxStacks);
  if (cap <= 0) return '❌ Запрещены';
  return cap === 1 ? 'Только 1 стек' : `До ${cap} стеков`;
}

// без резерва на докупки колонку "Докупки" вообще не показываем — по ней всё равно нечем
// докупаться физически, показывать "Запрещены" везде было бы избыточно и вводило бы в заблуждение.
// maxStacksByLevel (если передан) — массив на каждый уровень отдельно, урезает статичное
// расписание "2 стека"/"1 стек" под то, сколько физически осталось в наборе именно на нём
// (а не одно число, посчитанное для текущего уровня игры и применённое ко всем строкам сразу)
// currentLevel (если передан) отмечает зелёным кружком текущий уровень блайндов в игре
function blindsTableHtml(levels, denomSchedule, rebuyRule, rebuysAllowed, maxStacksByLevel, currentLevel) {
  const blindsCell = i => `${i === currentLevel ? '🟢 ' : ''}${levels[i].sb}/${levels[i].bb}`;
  if (rebuysAllowed) {
    const rows = levels
      .map(
        (lv, i) =>
          `<tr><td>${blindsCell(i)}</td><td>${denomSchedule[i]}</td><td>${cappedRebuyLabel(rebuyRule[i], maxStacksByLevel ? maxStacksByLevel[i] : null)}</td></tr>`
      )
      .join('');
    return (
      `<h3>📈 Блайнды, номиналы в игре и докупки</h3>` +
      `<table><tr><th>Блайнды</th><th>Активные номиналы</th><th>Докупки</th></tr>${rows}</table>`
    );
  }
  const rows = levels.map((lv, i) => `<tr><td>${blindsCell(i)}</td><td>${denomSchedule[i]}</td></tr>`).join('');
  return (
    `<h3>📈 Блайнды и номиналы в игре</h3>` +
    `<table><tr><th>Блайнды</th><th>Активные номиналы</th></tr>${rows}</table>` +
    `<p>🚫 <i>Докупки недоступны — в наборе не хватает фишек на ещё один стек.</i></p>`
  );
}

// структура турнира (стек/блайнды/докупки) — без state рендерит только статичную часть
// (используется для дефолтных правил в главном меню); со state добавляет призовые (стартовые
// и на текущий момент — банк меняется от докупок, поэтому эта функция вызывается заново при
// каждом открытии, а не рендерится один раз и кэшируется) и тот же статус-блок, что и в игре
// живая турнирная таблица на текущий момент: выбывшие уже имеют зафиксированное место
// (N - позиция выбывания, назад это место не меняется, даже если позже выбьют ещё кого-то) —
// и, соответственно, зафиксированные очки; те, кто ещё играет, гарантированно на местах лучше
// любого выбывшего, но между собой их место пока не определено
function liveStandingsHtml(state, N, prizes, unit) {
  const prizeForPlaceNow = place => {
    const p = prizes.find(x => x.place === place);
    return p && p.amount > 0 ? `${p.amount} ${unit}` : '—';
  };
  const remainingIds = remainingPlayers(state);
  const bustedIds = state.busted;
  // место (и с ним очки за него) ещё не определено, но докупки/выбивания уже реально случились —
  // показываем то, что уже точно набежало, а не глухой прочерк, будто ничего не произошло
  const rows = remainingIds.map(id => {
    const partial = state.knockouts[id] - 2 * state.rebuys[id];
    return {
      id,
      points: partial,
      placeLabel: '🟢',
      pointsLabel: partial === 0 ? '0' : `${partial > 0 ? '+' : ''}${partial}`,
      prizeLabel: '—',
      rebuys: state.rebuys[id],
      knockouts: state.knockouts[id]
    };
  });
  for (let i = bustedIds.length - 1; i >= 0; i--) {
    const id = bustedIds[i];
    const place = N - i;
    const points = placementPoints(place, N) - 2 * state.rebuys[id] + state.knockouts[id];
    rows.push({
      id,
      points,
      placeLabel: String(place),
      pointsLabel: `${points > 0 ? '+' : ''}${points}`,
      prizeLabel: prizeForPlaceNow(place),
      rebuys: state.rebuys[id],
      knockouts: state.knockouts[id]
    });
  }
  // по очкам от большего к меньшему — даже у тех, кто ещё играет и место кому не определено
  rows.sort((a, b) => b.points - a.points);
  const body = rows
    .map(
      r =>
        `<tr><td>${r.placeLabel}</td><td>${esc(state.players[r.id])}</td><td>${r.pointsLabel}</td><td>${r.prizeLabel}</td><td>${r.rebuys}</td><td>${r.knockouts}</td></tr>`
    )
    .join('');
  return (
    `<h3>📊 Турнирная таблица на текущий момент</h3>` +
    `<table><tr><th>Место</th><th>Игрок</th><th>Очки</th><th>Приз</th><th>Докупки</th><th>Выбивания</th></tr>${body}</table>` +
    `<p><i>🟢 — ещё играет: очки за место сюда не входят, оно пока не определено.</i></p>`
  );
}

function gameRulesHtml({ state, stackResult, levels, rebuyRule, denomSchedule, buyIn }) {
  // "докупки в принципе возможны в этой игре" — статичный флаг с момента создания стола, а не
  // то, доступны ли они на ТЕКУЩЕМ уровне (иначе на последних уровнях пропадала бы вся колонка,
  // а не просто "Запрещены" в её последних строках)
  const rebuysAllowed = !state || state.rebuysAllowed !== false;
  const maxStacksByLevel = state ? maxRebuyStacksByLevel(state) : null;
  const valueLabel = buyIn ? `${stackResult.totalValue} ₽` : `${stackResult.totalValue}`;
  const stackRows = stackResult.perPlayer
    .map(d => `<tr><td>${d.value}</td><td>${d.take}</td><td>${d.value * d.take}</td></tr>`)
    .join('');
  let html =
    `<h2>📋 Правила турнира</h2>` +
    `<h3>🃏 Стартовый стек — ${valueLabel} (${stackResult.totalPieces} фишек)</h3>` +
    `<table><tr><th>Номинал</th><th>Кол-во</th><th>Сумма</th></tr>${stackRows}</table>` +
    blindsTableHtml(levels, denomSchedule, rebuyRule, rebuysAllowed, maxStacksByLevel, state ? state.blindLevel || 0 : null);

  if (state) {
    const unit = buyIn ? '₽' : 'фишек';
    const N = Object.keys(state.players).length;
    const currentBank = totalInvested(state);
    const currentPrizes = prizeBreakdown(currentBank, N);
    html +=
      `<h3>🏆 Призовые на текущий момент</h3>` +
      `<table><tr><th>Место</th><th>Приз</th></tr>${prizeTableRows(currentPrizes, unit)}</table>` +
      liveStandingsHtml(state, N, currentPrizes, unit) +
      moneyLineHtml(state);
  }

  return html;
}

function gameStructureHtml({ state, N, stackResult, levels, rebuyRule, denomSchedule, prizes, buyIn }) {
  const rebuysAllowed = state.rebuysAllowed !== false;
  const maxStacksByLevel = maxRebuyStacksByLevel(state);
  const unit = buyIn ? '₽' : 'фишек';
  const valueLabel = buyIn ? `${stackResult.totalValue} ₽` : `${stackResult.totalValue}`;
  const list = Object.values(state.players).map(n => `<li>${esc(n)}</li>`).join('');
  const formatLine = buyIn
    ? `💰 <b>Формат:</b> на деньги, бай-ин <b>${buyIn} ₽</b>${rebuysAllowed ? ` (докупка — тоже ${buyIn} ₽)` : ''}`
    : `🆓 <b>Формат:</b> бесплатная игра`;
  const tempo = state.structure && state.structure.tempo;
  const tempoLine = tempo && tempo !== 'normal' ? `<p>⏱ <b>Темп:</b> ${TEMPO_PRESETS[tempo].label}</p>` : '';

  const stackRows = stackResult.perPlayer
    .map(d => `<tr><td>${d.value}</td><td>${d.take}</td><td>${d.value * d.take}</td></tr>`)
    .join('');
  const shortfallLine = buyIn && stackResult.shortfall
    ? `<p><i>⚠️ Набором фишек можно выдать максимум ${stackResult.totalValue} из ${buyIn} ₽ бай-ина — не хватает подходящих номиналов на остаток ${stackResult.shortfall}.</i></p>`
    : '';
  const stackTable =
    `<h3>🃏 Стартовый стек — ${valueLabel} (${stackResult.totalPieces} фишек)</h3>` +
    `<table><tr><th>Номинал</th><th>Кол-во</th><th>Сумма</th></tr>${stackRows}</table>` +
    shortfallLine;

  const blindsTable = blindsTableHtml(levels, denomSchedule, rebuyRule, rebuysAllowed, maxStacksByLevel, state.blindLevel || 0);

  const bank = stackResult.totalValue * N;
  const prizeTable =
    `<h3>🏆 Ожидаемые призовые (старт. банк ${bank} ${unit})</h3>` +
    `<table><tr><th>Место</th><th>Приз</th></tr>${prizeTableRows(prizes, unit)}</table>` +
    (rebuysAllowed ? `<p><i>Банк и призовые пересчитаются автоматически с учётом докупок по ходу игры.</i></p>` : '');

  const header =
    `<h2>🏆 Турнир №${state.gameNo}</h2>` +
    `<p>📅 ${fmtDate(state.date)} · 🕐 ${fmtTime(state.date)}</p>` +
    `<p>${formatLine}</p>` +
    tempoLine +
    `<h2>✅ Игра начата!</h2><ul>${list}</ul>`;

  return header + stackTable + blindsTable + prizeTable + moneyLineHtml(state);
}

// сколько ещё стеков стоимостью targetValue можно набрать из остатка фишек — НЕ обязательно
// точно повторяя исходный состав каждый раз. Докупка в реальности — это стек из того, что
// осталось в банке, а не обязанность банкующего клонировать состав самого первого стека.
// Если считать "докупка = точная копия стартового стека", разные целевые суммы могут случайно
// лечь на разные номиналы, и тогда меньший по деньгам стек (который жадно съел один дефицитный
// номинал) может показывать МЕНЬШЕ доступных докупок, чем более крупный — нелогичный результат.
// Пересчитываем заново на каждом шаге, что ещё можно собрать из фактического остатка
// levelContext (если передан — {denoms, levels, levelIndex}) ограничивает подбор докупки только
// номиналами, реально в игре на текущем уровне блайндов, и их ТЕКУЩЕЙ принимаемой ценностью
// (выведенный, но ещё не возвращённый номинал в докупку не идёт вообще; возвращённый — идёт по
// повышенной цене, не по печатной). Без этого докупка могла набираться из уже выведенных из
// оборота мелких фишек, которые на столе физически никто не принимает
function maxStacksFromPool(pool, targetValue, changeBuffer = 0, levelContext = null) {
  // придерживаем немного младшего активного номинала на размен по ходу игры — докупки не
  // имеют права вычерпать его до нуля, иначе банкующему нечем будет давать сдачу
  const smallestValue = changeBuffer > 0 && pool.length ? Math.min(...pool.map(d => d.value)) : null;
  let remaining = pool.map(d =>
    d.value === smallestValue ? { ...d, count: Math.max(0, d.count - changeBuffer) } : { ...d }
  );
  let count = 0;
  const cap = 20; // разумный потолок итераций, докупок больше в реальной игре не бывает
  while (count < cap) {
    let searchPool = remaining;
    let effectiveToPrinted = null;
    if (levelContext) {
      const active = activeDenomsAtLevel(levelContext.denoms, levelContext.levels, levelContext.levelIndex);
      effectiveToPrinted = new Map();
      searchPool = [];
      active.forEach(a => {
        const p = remaining.find(x => x.value === a.value);
        if (p && p.count > 0) {
          searchPool.push({ value: a.effectiveValue, count: p.count });
          effectiveToPrinted.set(a.effectiveValue, a.value);
        }
      });
    }
    if (!searchPool.length) break; // активные на этом уровне номиналы в остатке кончились — докупок больше нет
    const attempt = computeTargetStack(searchPool, 1, targetValue, 1);
    if (attempt.totalValue < targetValue) break;
    count++;
    remaining = remaining.map(d => {
      const used = attempt.perPlayer.find(p => (effectiveToPrinted ? effectiveToPrinted.get(p.value) : p.value) === d.value);
      return { value: d.value, count: d.count - (used ? used.take : 0) };
    });
  }
  return count;
}

// то, что остаётся в наборе после того, как N игроков получили по стеку stackResult
function remainingAfterStacks(denoms, stackResult, N) {
  return denoms.map(d => {
    const p = stackResult.perPlayer.find(x => x.value === d.value);
    return { value: d.value, count: d.count - (p ? p.take * N : 0) };
  });
}

// сколько докупок в принципе способен потянуть набор фишек с нуля (стабильное число — не
// убывает по ходу игры, в отличие от maxRebuyStacksNow) — используется и чтобы решить, хватит
// ли хотя бы на одну докупку перед стартом, и как знаменатель "докупок: X/Y"
function maxUsableStacksFromReserve(denoms, stackResult, N) {
  return maxStacksFromPool(remainingAfterStacks(denoms, stackResult, N), stackResult.totalValue, N);
}

// docupки уже случившиеся в игре — каждая забирает из банка ещё один стек сверх изначальных N,
// поэтому статично посчитанного при старте "хватит на докупки" недостаточно: нужно
// перепроверять каждый раз с учётом того, сколько докупок уже фактически произошло
function totalRebuysSoFar(state) {
  return Object.values(state.rebuys).reduce((s, r) => s + r, 0);
}

// физический остаток набора прямо сейчас: стартовые стеки плюс все фактически случившиеся
// докупки вычтены (тем же способом, каким они реально собирались — из факт. остатка, а не как
// точные копии стартового стека). null — докупка была невозможна физически, хотя фактически
// произошла (не должно случаться, но на всякий случай)
function poolAfterRebuysSoFar(state) {
  const { stackResult, denoms } = state.structure;
  const N = Object.keys(state.players).length;
  let pool = remainingAfterStacks(denoms, stackResult, N);
  const usedSoFar = totalRebuysSoFar(state);
  for (let i = 0; i < usedSoFar; i++) {
    const attempt = computeTargetStack(pool, 1, stackResult.totalValue, 1);
    if (attempt.totalValue < stackResult.totalValue) return null;
    pool = pool.map(d => {
      const used = attempt.perPlayer.find(p => p.value === d.value);
      return { value: d.value, count: d.count - (used ? used.take : 0) };
    });
  }
  return pool;
}

// сколько ещё докупок реально доступно прямо сейчас, на текущем уровне блайндов.
// null — для старых игр без сохранённого набора, где это физически не проверить
function maxRebuyStacksNow(state) {
  if (!state.structure || !state.structure.denoms) return null;
  const { stackResult, denoms, levels, rebuyRule } = state.structure;
  const currentLevel = state.blindLevel || 0;
  // на поздних уровнях докупки закрыты по расписанию турнира (rule of thirds), независимо от
  // того, физически хватает ли ещё фишек на стек — это про темп игры, а не про наличие фишек
  if (rebuyRule && rebuyRule[currentLevel] === '❌ Запрещены') return 0;
  const pool = poolAfterRebuysSoFar(state);
  if (!pool) return 0;
  const N = Object.keys(state.players).length;
  const levelContext = { denoms, levels, levelIndex: currentLevel };
  return maxStacksFromPool(pool, stackResult.totalValue, N, levelContext);
}

// то же самое, но для КАЖДОГО уровня отдельно — для таблицы правил, где на каждой строке
// должно быть видно, сколько докупок было бы доступно именно на том уровне (расписание и набор
// номиналов, активных именно на нём), а не одно и то же число, посчитанное для текущего уровня
function maxRebuyStacksByLevel(state) {
  if (!state.structure || !state.structure.denoms) return null;
  const { stackResult, denoms, levels, rebuyRule } = state.structure;
  const pool = poolAfterRebuysSoFar(state);
  if (!pool) return levels.map(() => 0);
  const N = Object.keys(state.players).length;
  return levels.map((_, i) => {
    if (rebuyRule && rebuyRule[i] === '❌ Запрещены') return 0;
    return maxStacksFromPool(pool.map(d => ({ ...d })), stackResult.totalValue, N, { denoms, levels, levelIndex: i });
  });
}

// расписание докупок никогда не обещает больше "До 2 стеков" — капаем двойкой
function maxRebuysConfigured(state) {
  if (!state.structure || !state.structure.denoms) return 2; // старые игры без сохранённого набора — обычный лимит
  const { stackResult, denoms } = state.structure;
  const N = Object.keys(state.players).length;
  return Math.min(2, maxUsableStacksFromReserve(denoms, stackResult, N));
}

function canRebuyNow(state) {
  const max = maxRebuyStacksNow(state);
  if (max === null) return state.rebuysAllowed !== false; // старые игры без сохранённого набора — доверяем прежнему статичному флагу
  return max > 0;
}

// один источник правды для расчёта структуры — использует и старт игры, и проверка
// рекомендаций перед стартом (evaluateAndProceed), чтобы не считать по-разному в двух местах
function computeStructureFor(denoms, buyIn, N, tempo = 'normal') {
  const stackResult = buyIn
    ? computeTargetStack(denoms, N, buyIn, TEMPO_PRESETS[tempo].reserveFactor)
    : computeStandardStack(denoms, N, tempo);
  const levels = computeBlindLevels(denoms);
  const rebuyRule = computeRebuySchedule(levels);
  const denomSchedule = computeDenomSchedule(denoms, levels);
  const prizes = prizeBreakdown(stackResult.totalValue * N, N);
  const rebuysAllowed = maxUsableStacksFromReserve(denoms, stackResult, N) > 0;
  return { stackResult, levels, rebuyRule, denomSchedule, prizes, rebuysAllowed };
}

// эвристические проверки на удобство игры — не блокируют старт, только предупреждают
function buildWarnings({ denoms, N, buyIn, stackResult, levels, prizes, rebuysAllowed }) {
  const warnings = [];
  const unit = buyIn ? '₽' : 'фишек';

  if (!rebuysAllowed) {
    warnings.push(
      `🚫 Фишек в наборе слишком мало для этого числа игроков — в банке не останется резерва даже на один дополнительный стек. Докупки для этой игры будут отключены, и разменивать фишки во время игры будет физически нечем. Добавь фишек в набор или уменьши число игроков, если докупки важны.`
    );
  }

  if (stackResult.shortfall > 0) {
    if (buyIn) {
      warnings.push(
        `💸 Не хватает фишек нужных номиналов на бай-ин ${buyIn} ₽ — по факту получится ${stackResult.totalValue} ₽ на игрока (не хватает ${stackResult.shortfall} ₽). Снизь бай-ин до ${stackResult.totalValue} ₽ либо добавь фишек в набор.`
      );
    } else {
      warnings.push(
        `🪙 Набора не хватает на ${N} игроков — по факту получится ${stackResult.totalValue} фишек на игрока вместо ${stackResult.totalValue + stackResult.shortfall}. Уменьши число игроков или добавь фишек в набор.`
      );
    }
  }

  const firstBB = levels[0].bb;
  const stackInBB = stackResult.totalValue / firstBB;
  if (stackInBB < 10) {
    warnings.push(
      `📉 Стартовый стек — всего ${stackInBB.toFixed(1)} больших блайндов (стек ${stackResult.totalValue} ${unit}, старт. блайнд ${firstBB}). Турнир будет очень быстрым. Увеличь ${buyIn ? 'бай-ин' : 'стек'} или возьми набор с более мелким младшим номиналом.`
    );
  } else if (stackInBB < 20) {
    warnings.push(
      `📉 Стартовый стек — ${stackInBB.toFixed(1)} больших блайндов. Для комфортной игры лучше от 20 BB — рассмотри ${buyIn ? 'бай-ин побольше' : 'больший стек'}.`
    );
  }

  if (levels.length < 5) {
    warnings.push(
      `⏱ В наборе всего ${denoms.length} номинал${denoms.length === 1 ? '' : 'а'}, поэтому получилось только ${levels.length} уровня(ей) блайндов — эскалация будет резкой. Добавь номиналов в набор фишек.`
    );
  }

  if (stackResult.totalPieces < 8) {
    warnings.push(
      `🪙 На руки получится всего ${stackResult.totalPieces} фишек на игрока — почти нечем платить и давать сдачу. Увеличь ${buyIn ? 'бай-ин' : 'стек'} или добавь мелких номиналов.`
    );
  }

  const zeroPrize = prizes.find(p => p.amount === 0);
  if (zeroPrize) {
    warnings.push(
      `🏆 При такой сумме и количестве игроков призовое место №${zeroPrize.place} получится нулевым. Увеличь ${buyIn ? 'бай-ин' : 'стек'}.`
    );
  }

  return warnings;
}

function warningsHtml(warnings, { N, buyIn, stackResult }) {
  const unit = buyIn ? '₽' : 'фишек';
  const items = warnings.map(w => `<li>${w}</li>`).join('');
  return (
    `<h2>⚠️ Проверка перед стартом</h2>` +
    `<p>Формат: ${buyIn ? `на деньги, бай-ин ${buyIn} ₽` : 'бесплатно'} · Игроков: ${N} · Стек: ${stackResult.totalValue} ${unit}</p>` +
    `<ul>${items}</ul>` +
    `<p><i>Можно начать как есть, поменять бай-ин или вернуться к выбору набора фишек.</i></p>`
  );
}

async function evaluateAndProceed(ctx, pending) {
  const N = pending.selected.size;
  const denoms = pending.chipSet;
  const buyIn = pending.buyIn || 0;
  const structure = computeStructureFor(denoms, buyIn, N, pending.tempo);
  const warnings = buildWarnings({ denoms, N, buyIn, ...structure });
  if (!warnings.length) return createGame(ctx, pending);
  showRichPanelInline(ctx, warningsHtml(warnings, { N, buyIn, ...structure }), [
    [Markup.button.callback('✅ Начать всё равно', 'ng:confirmStart')],
    [Markup.button.callback('✏️ Изменить состав', 'ng:editPlayers')],
    [Markup.button.callback('✏️ Изменить бай-ин', 'ng:editBuyin')],
    [Markup.button.callback('✏️ Изменить набор фишек', 'ng:editChipset')],
    [Markup.button.callback('❌ Отмена', 'ng:cancel')]
  ]);
}

bot.action('ng:confirmStart', async ctx => {
  const pending = pendingNewGame.get(ctx.from.id);
  if (!pending || !pending.selected) return ctx.answerCbQuery('Сессия выбора истекла, запусти /newgame заново');
  ctx.answerCbQuery();
  await createGame(ctx, pending);
});

bot.action('ng:editBuyin', ctx => {
  const pending = pendingNewGame.get(ctx.from.id);
  if (!pending) return ctx.answerCbQuery('Сессия выбора истекла, запусти /newgame заново');
  ctx.answerCbQuery();
  const p = buyInPrompt();
  showPanel(ctx, p.text, p.keyboard);
});

bot.action('ng:editChipset', ctx => {
  const pending = pendingNewGame.get(ctx.from.id);
  if (!pending) return ctx.answerCbQuery('Сессия выбора истекла, запусти /newgame заново');
  ctx.answerCbQuery();
  const p = chipSetPrompt();
  showPanel(ctx, p.text, p.keyboard);
});

// возврат к выбору игроков с экрана рекомендаций — сохраняет уже отмеченных, а не сбрасывает
bot.action('ng:editPlayers', ctx => {
  const pending = pendingNewGame.get(ctx.from.id);
  if (!pending) return ctx.answerCbQuery('Сессия выбора истекла, запусти /newgame заново');
  ctx.answerCbQuery();
  if (!pending.selected) pending.selected = new Set();
  showPanel(ctx, `👥 ${b('Участники')}\nВыбери 4–8 игроков:`, kb(newGameKeyboard(pending.selected)));
});

// getNextGameNo() из БД учитывает только СОХРАНЁННЫЕ игры — если открыто несколько столов
// одновременно и ни один ещё не завершён, все они получили бы один и тот же "следующий" номер.
// Берём максимум ещё и по уже открытым столам, чтобы номера не задваивались
function nextGameNoAvoidingActive() {
  const lastSaved = getNextGameNo() - 1;
  const activeMax = Math.max(0, ...getActiveGames().map(g => g.state.gameNo || 0));
  return Math.max(lastSaved, activeMax) + 1;
}

async function createGame(ctx, pending) {
  const existing = getState(ctx.from.id);
  if (existing) {
    pendingNewGame.delete(ctx.from.id);
    return showRichPanel(ctx, statusHtml(existing), gameRows(existing));
  }

  const N = pending.selected.size;
  const denoms = pending.chipSet;
  const buyIn = pending.buyIn || 0;

  const { stackResult, levels, rebuyRule, denomSchedule, prizes, rebuysAllowed } = computeStructureFor(
    denoms,
    buyIn,
    N,
    pending.tempo
  );
  const stackValue = stackResult.totalValue;

  const players = {};
  pending.selected.forEach(id => {
    const p = getPlayerByTelegramId(id);
    players[id] = p.display_name;
  });

  const state = {
    gameId: crypto.randomUUID(),
    gameNo: nextGameNoAvoidingActive(),
    date: new Date().toISOString(),
    adminChatId: ctx.chat.id,
    buyIn,
    chipStack: stackValue,
    rebuysAllowed,
    blindLevel: 0,
    structure: { stackResult, levels, rebuyRule, denomSchedule, buyIn, denoms, tempo: pending.tempo || 'normal' },
    players,
    rebuys: {},
    knockouts: {},
    busted: [],
    log: []
  };
  Object.keys(players).forEach(id => { state.rebuys[id] = 0; state.knockouts[id] = 0; });
  setState(ctx.from.id, state);
  pendingNewGame.delete(ctx.from.id);

  const html = gameStructureHtml({ state, N, stackResult, levels, rebuyRule, denomSchedule, prizes, buyIn });
  await showRichPanel(ctx, html, gameRows(state));
}

// три темпа сразу — и чтобы решить, стоит ли вообще спрашивать организатора, и чтобы показать
// сравнение, если спрашиваем. Разница считается ощутимой, если самый быстрый темп даёт стек
// хотя бы на ~15% крупнее самого медленного, либо у них по-разному доступны докупки — иначе
// (например, набор фишек слишком тесный, чтобы темп на что-то влиял) молча работаем на обычном
function stacksByTempo(denoms, buyIn, N) {
  return {
    slow: computeStructureFor(denoms, buyIn, N, 'slow'),
    normal: computeStructureFor(denoms, buyIn, N, 'normal'),
    fast: computeStructureFor(denoms, buyIn, N, 'fast')
  };
}

// какие из трёх темпов реально стоит предлагать: группируем по числу доступных докупок и в
// каждой группе оставляем только темп с самым крупным стеком — если у двух темпов докупок
// одинаковое количество, смысла показывать оба нет (меньший стек при том же числе докупок
// строго хуже, а не другой вариант). Если после этого остался только один — разница
// не была ощутимой вообще, работаем на "обычном" без вопроса
function tempoOptions(byTempo, denoms, N) {
  const order = ['slow', 'normal', 'fast'];
  const bestForCount = new Map(); // число докупок -> темп с максимальным стеком при этом числе
  for (const t of order) {
    const count = maxUsableStacksFromReserve(denoms, byTempo[t].stackResult, N);
    const cur = bestForCount.get(count);
    if (!cur || byTempo[t].stackResult.totalValue > byTempo[cur].stackResult.totalValue) bestForCount.set(count, t);
  }
  const survivors = new Set(bestForCount.values());
  return order.filter(t => survivors.has(t));
}

function pluralDocupki(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'докупка';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'докупки';
  return 'докупок';
}

function tempoPromptHtml(byTempo, buyIn, denoms, N, options) {
  const unit = buyIn ? '₽' : 'фишек';
  const rows = options
    .map(t => {
      const stacks = maxUsableStacksFromReserve(denoms, byTempo[t].stackResult, N);
      return `<tr><td>${TEMPO_PRESETS[t].label}</td><td>${byTempo[t].stackResult.totalValue} ${unit}</td><td>${stacks} ${pluralDocupki(stacks)}</td></tr>`;
    })
    .join('');
  return (
    `<h2>⏱ Темп турнира</h2>` +
    `<p>Медленный — меньше в стартовый стек, больше остаётся в резерве на докупки. Быстрый — крупнее стеки сразу, но резерва на докупки меньше.</p>` +
    `<table><tr><th>Темп</th><th>Стартовый стек</th><th>Резерв</th></tr>${rows}</table>`
  );
}

bot.action('ng:done', async ctx => {
  const pending = pendingNewGame.get(ctx.from.id);
  if (!pending || !pending.selected) return ctx.answerCbQuery('Сессия выбора истекла, запусти /newgame заново');
  if (pending.selected.size < 4 || pending.selected.size > 8) {
    return ctx.answerCbQuery('Нужно от 4 до 8 игроков', { show_alert: true });
  }
  ctx.answerCbQuery();

  if (!pending.tempo) {
    const N = pending.selected.size;
    const byTempo = stacksByTempo(pending.chipSet, pending.buyIn || 0, N);
    const options = tempoOptions(byTempo, pending.chipSet, N);
    if (options.length > 1) {
      return showRichPanelInline(ctx, tempoPromptHtml(byTempo, pending.buyIn || 0, pending.chipSet, N, options), [
        options.map(t => Markup.button.callback(TEMPO_PRESETS[t].label, `ng:tempo:${t}`)),
        [Markup.button.callback('❌ Отмена', 'ng:cancel')]
      ]);
    }
    pending.tempo = 'normal';
  }
  await evaluateAndProceed(ctx, pending);
});

bot.action(/^ng:tempo:(slow|normal|fast)$/, async ctx => {
  const pending = pendingNewGame.get(ctx.from.id);
  if (!pending || !pending.selected) return ctx.answerCbQuery('Сессия выбора истекла, запусти /newgame заново');
  pending.tempo = ctx.match[1];
  ctx.answerCbQuery();
  await evaluateAndProceed(ctx, pending);
});

// ---------- in-game actions (только внутри панели игры) ----------

function remainingPlayers(state) {
  return Object.keys(state.players).filter(id => !state.busted.includes(id));
}

function totalInvested(state) {
  const stake = state.buyIn || state.chipStack || NOMINAL_CHIP_STACK;
  return Object.keys(state.players).reduce((sum, id) => sum + stake * (1 + state.rebuys[id]), 0);
}

// сколько фишек в наборе ещё остаётся не розданными прямо сейчас — стартовый резерв минус то,
// что уже забрали фактические докупки (у каждой из них тот же вес, что и у стартового стека)
// НЕ линейное "стартовый резерв минус докупки×стек": докупки жрут конкретные номиналы, и один
// исчерпанный номинал (например, самый мелкий) может застопорить дальнейшие докупки, даже если
// в других номиналах ещё полно фишек — та часть остатка становится непригодной "мёртвым" остатком.
// Поэтому берём maxRebuyStacksNow — то же самое число, которое решает, разрешать ли докупку
// прямо сейчас, — и переводим его в стоимость; так цифра резерва не разойдётся с фактом
function moneyLineHtml(state) {
  const stake = state.buyIn || state.chipStack || NOMINAL_CHIP_STACK;
  const unit = state.buyIn ? '₽' : 'фишек';
  return `<p>💵 <b>${state.buyIn ? 'Бай-ин' : 'Стек'}:</b> ${stake} ${unit} · <b>Банк:</b> ${totalInvested(state)} ${unit}</p>`;
}

// текущий уровень блайндов строчкой — тот же зелёный кружок, что отмечает его в таблице правил.
// резерв справа — сколько ещё целых стеков можно физически выдать прямо сейчас на ЭТОМ уровне
// (та же цифра, что решает, разрешать ли докупку) — уместнее тут, чем у банка, т.к. зависит
// именно от уровня (номиналы выводятся из оборота/расписание запрещает докупки под конец)
function blindLevelLine(state) {
  const levels = state.structure && state.structure.levels;
  if (!levels || !levels.length) return '';
  const idx = state.blindLevel || 0;
  const lv = levels[idx];
  const hasStructure = state.structure && state.structure.denoms;
  const stacks = hasStructure ? maxRebuyStacksNow(state) : null;
  const reserveLine =
    stacks == null ? '' : stacks === 0 ? ' · <b>Докупки недоступны</b>' : ` · <b>Резерв:</b> ${stacks} ${pluralDocupki(stacks)}`;
  return `<p>🟢 <b>Блайнды:</b> ${lv.sb}/${lv.bb} (уровень ${idx + 1}/${levels.length})${reserveLine}</p>`;
}

// полный статус (кто в игре/выбыл/докупался) — только для главной панели стола по умолчанию;
// на старте игры и на экране "Правила турнира" остаётся только строка банка (moneyLineHtml)
function statusHtml(state) {
  const remainingIds = remainingPlayers(state);
  const bustedIds = state.busted;
  const rowCount = Math.max(remainingIds.length, bustedIds.length);
  let playerRows = '';
  for (let i = 0; i < rowCount; i++) {
    const inGame = remainingIds[i] ? esc(state.players[remainingIds[i]]) : '';
    const out = bustedIds[i] ? esc(state.players[bustedIds[i]]) : '';
    playerRows += `<tr><td>${inGame}</td><td>${out}</td></tr>`;
  }
  const playersBlock =
    `<h3>👥 Игроки</h3>` + `<table><tr><th>🟢 В игре</th><th>🔴 Выбыли</th></tr>${playerRows}</table>`;
  const maxRebuys = maxRebuysConfigured(state);
  const rebuyRows = Object.keys(state.players)
    .filter(id => state.rebuys[id] > 0)
    .map(id => `<tr><td>${esc(state.players[id])}</td><td>${state.rebuys[id]}/${maxRebuys}</td></tr>`)
    .join('');
  const rebuysBlock = rebuyRows
    ? `<h3>💰 Докупки</h3><table><tr><th>Игрок</th><th>Кол-во</th></tr>${rebuyRows}</table>`
    : '';
  const eventsBlock = eventsLogHtml(state.log, state.date, state.players, maxRebuys);
  return (
    moneyLineHtml(state) +
    blindLevelLine(state) +
    `<p>&nbsp;</p>` +
    playersBlock +
    (rebuysBlock ? `<p>&nbsp;</p>` + rebuysBlock : '') +
    (eventsBlock ? `<p>&nbsp;</p>` + eventsBlock : '')
  );
}

bot.hears(BTN_GAME_RULES, ctx => {
  const ownerId = gameOwnerId(ctx);
  const state = getState(ownerId);
  if (!state) return showPanel(ctx, 'Нет активной игры.', replyKb(menuRows(ctx)));
  const html = state.structure
    ? gameRulesHtml({ state, ...state.structure })
    : '<p>Для этой игры правила не сохранились.</p>';
  showRichPanelInline(ctx, html, [[BACK_TO_STATUS]]);
});

bot.hears(BTN_NEXT_LEVEL, ctx => {
  const ownerId = gameOwnerId(ctx);
  const state = getState(ownerId);
  if (!state) return showPanel(ctx, 'Нет активной игры.', replyKb(menuRows(ctx)));
  if (!hasNextLevel(state)) {
    return showRichPanel(ctx, `<p>Следующего уровня нет.</p>` + statusHtml(state), gameRows(state));
  }
  const levels = state.structure.levels;
  state.blindLevel = Math.min(levels.length - 1, (state.blindLevel || 0) + 1);
  setState(ownerId, state);
  const lv = levels[state.blindLevel];
  showRichPanel(ctx, `<p>▶️ <b>Новый уровень:</b> ${lv.sb}/${lv.bb}</p>` + statusHtml(state), gameRows(state));
});

function cancelLastEvent(ownerId, state) {
  const last = state.log.pop();
  if (!last) return false;
  if (last.type === 'REBUY') {
    // rebuy undo: put the player back into "busted" at their original spot
    state.busted.splice(last.bustedIndex, 0, last.id);
    state.rebuys[last.id]--;
  } else if (last.type === 'BUST') {
    state.busted = state.busted.filter(x => x !== last.id);
    state.knockouts[last.by]--;
  }
  setState(ownerId, state);
  return true;
}

bot.hears(BTN_CANCEL, ctx => {
  const ownerId = gameOwnerId(ctx);
  const state = getState(ownerId);
  if (!state) return showPanel(ctx, 'Нет активной игры.', replyKb(menuRows(ctx)));
  if (!cancelLastEvent(ownerId, state)) {
    return showRichPanel(ctx, `<p>Нечего отменять.</p>` + statusHtml(state), gameRows(state));
  }
  showRichPanel(ctx, `<p>↩️ <b>Последнее событие отменено</b></p>` + statusHtml(state), gameRows(state));
});

// --- rebuy (только для тех, кто уже выбыл — докупка возвращает их за стол) ---

const BACK_TO_STATUS = Markup.button.callback('⬅️ Назад', 'back:status');

bot.action('back:status', ctx => {
  const state = getState(gameOwnerId(ctx));
  ctx.answerCbQuery();
  if (!state) return showPanel(ctx, 'Нет активной игры.', replyKb(menuRows(ctx)));
  showRichPanel(ctx, statusHtml(state), gameRows(state));
});

bot.hears(BTN_REBUY, ctx => {
  const state = getState(gameOwnerId(ctx));
  if (!state) return showPanel(ctx, 'Нет активной игры.', replyKb(menuRows(ctx)));
  if (!canRebuyNow(state)) {
    return showPanel(ctx, '🚫 Докупки недоступны — в наборе не хватает фишек на ещё один стек.', replyKb(gameRows(state)));
  }
  const maxRebuys = maxRebuysConfigured(state);
  const candidates = state.busted.filter(id => state.rebuys[id] < maxRebuys);
  if (!candidates.length) {
    return showPanel(ctx, `Докупаться некому (никто не выбыл, либо у всех уже ${maxRebuys}/${maxRebuys} докупок).`, replyKb(gameRows(state)));
  }
  showPanel(
    ctx,
    `💰 ${b('Докупка')}\nКто возвращается за стол?`,
    kb([...candidates.map(id => [Markup.button.callback(state.players[id], `rebuy:${id}`)]), [BACK_TO_STATUS]])
  );
});

bot.action(/^rebuy:(\d+)$/, ctx => {
  const ownerId = gameOwnerId(ctx);
  const state = getState(ownerId);
  if (!state) return ctx.answerCbQuery('Нет активной игры');
  if (!canRebuyNow(state)) return ctx.answerCbQuery('Докупки недоступны — фишек не хватит');
  const id = ctx.match[1];
  if (!state.players[id]) return ctx.answerCbQuery('Игрок не найден');
  const bustedIndex = state.busted.indexOf(id);
  if (bustedIndex === -1) return ctx.answerCbQuery('Игрок не выбыл — докупка не нужна');
  state.busted.splice(bustedIndex, 1); // возвращаем игрока за стол
  state.rebuys[id]++;
  state.log.push({ type: 'REBUY', id, bustedIndex, at: new Date().toISOString() });
  setState(ownerId, state);
  ctx.answerCbQuery();
  // showRichPanel, не editMessageText: сообщения с инлайн-кнопками не могут одновременно
  // нести постоянную клавиатуру — шлём новое сообщение, чтобы кнопки внизу не пропадали
  showRichPanel(
    ctx,
    `<p>💰 <b>${esc(state.players[id])}</b> докупился и возвращается за стол ${i(`(докупок: ${state.rebuys[id]}/${maxRebuysConfigured(state)})`)}</p>` +
      statusHtml(state),
    gameRows(state)
  );
});

// --- bust (two steps: who busted -> who eliminated) ---

function out1Keyboard(state) {
  const candidates = remainingPlayers(state);
  return [...candidates.map(id => [Markup.button.callback(state.players[id], `out1:${id}`)]), [BACK_TO_STATUS]];
}

bot.hears(BTN_OUT, ctx => {
  const state = getState(gameOwnerId(ctx));
  if (!state) return showPanel(ctx, 'Нет активной игры.', replyKb(menuRows(ctx)));
  if (remainingPlayers(state).length < 2) {
    return showPanel(ctx, 'Недостаточно игроков в игре для фиксации выбывания.', replyKb(gameRows(state)));
  }
  showPanel(ctx, `❌ ${b('Выбывание')}\nКто выбыл?`, kb(out1Keyboard(state)));
});

bot.action('out:back', ctx => {
  const state = getState(gameOwnerId(ctx));
  if (!state) return ctx.answerCbQuery('Нет активной игры');
  ctx.answerCbQuery();
  ctx.editMessageText(`❌ ${b('Выбывание')}\nКто выбыл?`, kb(out1Keyboard(state)));
});

bot.action(/^out1:(\d+)$/, ctx => {
  const state = getState(gameOwnerId(ctx));
  if (!state) return ctx.answerCbQuery('Нет активной игры');
  const bustedId = ctx.match[1];
  const candidates = remainingPlayers(state).filter(id => id !== bustedId);
  ctx.answerCbQuery();
  ctx.editMessageText(
    `❌ Кто выбил ${b(state.players[bustedId])}?`,
    kb([
      ...candidates.map(id => [Markup.button.callback(state.players[id], `out2:${bustedId}:${id}`)]),
      [Markup.button.callback('⬅️ Назад', 'out:back')]
    ])
  );
});

bot.action(/^out2:(\d+):(\d+)$/, ctx => {
  const ownerId = gameOwnerId(ctx);
  const state = getState(ownerId);
  if (!state) return ctx.answerCbQuery('Нет активной игры');
  const [, bustedId, byId] = ctx.match;
  if (state.busted.includes(bustedId)) return ctx.answerCbQuery('Этот игрок уже отмечен как выбывший');

  state.busted.push(bustedId);
  state.knockouts[byId] = (state.knockouts[byId] || 0) + 1;
  state.log.push({ type: 'BUST', id: bustedId, by: byId, at: new Date().toISOString() });
  setState(ownerId, state);

  const remaining = remainingPlayers(state).length;
  ctx.answerCbQuery();

  if (remaining === 1) {
    // турнир доигран сам — сразу считаем итоги, вручную жать "Завершить" не нужно
    finalizeGame(ctx, state, ownerId);
    return;
  }

  const msg =
    `<p>☠️ <b>${esc(state.players[bustedId])}</b> выбит игроком <b>${esc(state.players[byId])}</b></p>` +
    statusHtml(state);
  // showRichPanel, не editMessageText — иначе постоянная клавиатура снизу пропадает
  showRichPanel(ctx, msg, gameRows(state));
});

// --- end game ---

async function finalizeGame(ctx, state, ownerId) {
  const winner = remainingPlayers(state)[0];
  const order = [winner, ...state.busted.slice().reverse()];
  const N = Object.keys(state.players).length;

  const results = order.map((id, idx) => {
    const place = idx + 1;
    const placementPts = placementPoints(place, N);
    const total = placementPts - 2 * state.rebuys[id] + state.knockouts[id];
    return {
      telegramId: Number(id),
      name: state.players[id],
      place,
      rebuys: state.rebuys[id],
      knockouts: state.knockouts[id],
      placementPts,
      total
    };
  });

  state.endedAt = new Date().toISOString();
  clearState(ownerId); // стол освобождён — новую игру можно начинать не дожидаясь подтверждения этой
  if (actingOwner.get(ctx.from.id) === ownerId) actingOwner.delete(ctx.from.id);

  if (isAdmin(ctx)) {
    // владелец подтверждает результаты по умолчанию — спрашивать разрешения не у кого
    saveGameResults(state, results, N);
    // из БД, а не formatProtocolHtml(state,...): там уже есть застывший snapshot рейтинга до/после
    const protocol = protocolHtmlFromDb(getGameById(state.gameId));
    await showRichPanel(ctx, protocol, menuRows(ctx));
    if (CHANNEL_ID) {
      await sendRich(CHANNEL_ID, protocol);
    }
    if (ownerId !== ctx.from.id) {
      // владелец завершил чужой стол через "Активные турниры" — организатора стоит уведомить
      await sendRich(ownerId, `<p>🏁 <b>Владелец лиги завершил ваш турнир.</b></p>` + protocol).catch(() => {});
    }
    await sendBackupToAdmins(`🗄 Автобэкап после турнира №${state.gameNo}`);
    return;
  }

  // организатор не является владельцем — результат ждёт подтверждения, прежде чем попасть в статистику
  const approvalId = crypto.randomUUID();
  addPendingApproval(approvalId, {
    state,
    results,
    N,
    requestedBy: ownerId,
    requestedByName: displayNameOf(ctx.from)
  });

  const protocol = formatProtocolHtml(state, results, N);
  await showRichPanel(
    ctx,
    `<p>🕐 <b>Турнир завершён и отправлен на подтверждение организатору лиги.</b> Как только подтвердят — появится в статистике и канале. Если подтверждения не будет в течение 24 часов, заявка удалится автоматически.</p>` +
      protocol,
    menuRows(ctx)
  );

  for (const adminId of ADMIN_IDS) {
    await sendRichInline(
      adminId,
      `<p>🕐 <b>${esc(displayNameOf(ctx.from))}</b> завершил турнир — нужно подтверждение (сгорит через 24ч без ответа):</p>` +
        protocol,
      [
        [
          { text: '✅ Подтвердить', callback_data: `appr:${approvalId}` },
          { text: '❌ Отклонить', callback_data: `rej:${approvalId}` }
        ]
      ]
    ).catch(err => console.error('Не удалось уведомить владельца', adminId, err.message));
  }
}

bot.action(/^appr:([0-9a-f-]+)$/, async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Только для владельца');
  const approval = getPendingApproval(ctx.match[1]);
  if (!approval) return ctx.answerCbQuery('Заявка не найдена или уже обработана', { show_alert: true });

  removePendingApproval(ctx.match[1]);
  saveGameResults(approval.state, approval.results, approval.N);
  const protocol = protocolHtmlFromDb(getGameById(approval.state.gameId));

  ctx.answerCbQuery('Подтверждено');
  await ctx.deleteMessage().catch(() => {});
  await sendRich(ctx.chat.id, `<p>✅ <b>Подтверждено и добавлено в статистику.</b></p>` + protocol);
  if (CHANNEL_ID) await sendRich(CHANNEL_ID, protocol);
  await sendRich(approval.requestedBy, `<p>✅ <b>Твой турнир подтверждён!</b> Он в статистике и канале.</p>` + protocol).catch(() => {});
  await sendBackupToAdmins(`🗄 Автобэкап после турнира №${approval.state.gameNo}`);
});

bot.action(/^rej:([0-9a-f-]+)$/, async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Только для владельца');
  const approval = getPendingApproval(ctx.match[1]);
  if (!approval) return ctx.answerCbQuery('Заявка не найдена или уже обработана', { show_alert: true });

  removePendingApproval(ctx.match[1]);
  ctx.answerCbQuery('Отклонено');
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply('❌ Отклонено, в статистику не добавлено.');
  await ctx.telegram
    .sendMessage(approval.requestedBy, '❌ Организатор лиги отклонил протокол турнира — в статистику он не попал. Уточни детали.')
    .catch(() => {});
});

bot.hears(BTN_ENDGAME, async ctx => {
  const ownerId = gameOwnerId(ctx);
  const state = getState(ownerId);
  if (!state) return showPanel(ctx, 'Нет активной игры.', replyKb(menuRows(ctx)));
  const remaining = remainingPlayers(state);
  if (remaining.length !== 1) {
    return showRichPanelInline(
      ctx,
      `<p>⚠️ За столом ещё ${remaining.length} игрока — обычно турнир так не завершают.</p>` +
        `<p>Прервать его досрочно? Все данные по событиям (докупки, выбивания) потеряются без возможности восстановить, в статистику и историю турнир не попадёт — точно ли ты этого хочешь?</p>`,
      [
        [
          Markup.button.callback('✅ Да, прервать', `eg:earlyEndConfirm:${ownerId}`),
          Markup.button.callback('❌ Отмена', 'back:status')
        ]
      ]
    );
  }
  await finalizeGame(ctx, state, ownerId);
});

bot.action(/^eg:earlyEndConfirm:(\d+)$/, async ctx => {
  const ownerId = Number(ctx.match[1]);
  if (gameOwnerId(ctx) !== ownerId) return ctx.answerCbQuery('Нет доступа');
  const state = getState(ownerId);
  if (!state) return ctx.answerCbQuery('Стол уже закрыт');
  clearState(ownerId);
  if (actingOwner.get(ctx.from.id) === ownerId) actingOwner.delete(ctx.from.id);
  ctx.answerCbQuery('Турнир прерван');
  await showPanel(ctx, '🗑 Турнир прерван досрочно — данные не сохранены.', replyKb(menuRows(ctx)));
});

// ---------- personal stats (any user, DM) ----------

const RATING_PAGE_SIZE = 10;

// все метрики видны всегда во всех режимах; меняется только порядок — выбранная идёт первой
function lastResultLabel(r) {
  if (r.lastResult == null) return '—';
  const sign = r.lastResult > 0 ? '+' : '';
  return `${sign}${r.lastResult}`;
}

const RATING_COLS = [
  { key: 'points', label: 'Очки', get: r => r.total_points },
  { key: 'games', label: 'Игр', get: r => r.games },
  { key: 'wins', label: 'Побед', get: r => r.wins },
  { key: 'lastResult', label: 'Последний рез.', get: lastResultLabel },
  { key: 'winningsChips', label: 'Выигрыш (фишки)', get: r => r.winningsChips },
  { key: 'winningsRub', label: 'Выигрыш (₽)', get: r => `${r.winningsRub} ₽` },
  { key: 'knockouts', label: 'Выбивания', get: r => r.knockouts },
  { key: 'rebuys', label: 'Докупок', get: r => r.rebuys }
];

function ratingColumnsForMode(mode) {
  const idx = RATING_COLS.findIndex(c => c.key === mode);
  if (idx <= 0) return RATING_COLS;
  const cols = [...RATING_COLS];
  const [selected] = cols.splice(idx, 1);
  return [selected, ...cols];
}

function showRatingPage(ctx, mode, page) {
  const total = getRatingCount();
  if (!total) return showPanel(ctx, 'Пока никто не зарегистрирован.', replyKb(menuRows(ctx)));

  const rows = getRatingPage(mode, page * RATING_PAGE_SIZE, RATING_PAGE_SIZE);
  const cols = ratingColumnsForMode(mode);

  const body = rows
    .map((r, i) => {
      const idx = page * RATING_PAGE_SIZE + i;
      const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : String(idx + 1);
      const cells =
        `<td>${medal}</td><td>${levelBadgeShort(r.total_points)} ${playerLink(r.telegram_id, r.display_name)}</td>` +
        cols.map((c, i2) => `<td>${i2 === 0 ? `<b>${c.get(r)}</b>` : c.get(r)}</td>`).join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  const headerCells = `<th>#</th><th>Игрок</th>` + cols.map(c => `<th>${c.label}</th>`).join('');
  const html = `<table><tr>${headerCells}</tr>${body}</table>`;

  // выбранный режим подсвечивается зелёным (style: 'success' — Bot API 10.x)
  const modeBtn = (key, label) => {
    const btn = Markup.button.callback(label, `rat:${key}:0`);
    return mode === key ? { ...btn, style: 'success' } : btn;
  };
  const modeRows = [
    [modeBtn('points', 'Очки'), modeBtn('wins', 'Победы')],
    [modeBtn('knockouts', 'Выбивания')],
    [modeBtn('winningsChips', 'Выигрыш (фишки)'), modeBtn('winningsRub', 'Выигрыш (₽)')]
  ];

  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('◀️ Пред.', `rat:${mode}:${page - 1}`));
  if ((page + 1) * RATING_PAGE_SIZE < total) nav.push(Markup.button.callback('След. ▶️', `rat:${mode}:${page + 1}`));

  const rows_ = [...modeRows];
  if (nav.length) rows_.push(nav);
  rows_.push([Markup.button.callback('⬅️ Главное меню', 'hist:menu')]);

  showRichPanelInline(ctx, html, rows_);
}

bot.command('rating', ctx => showRatingPage(ctx, 'points', 0));
bot.hears(BTN_RATING, ctx => showRatingPage(ctx, 'points', 0));
bot.action(/^rat:(points|wins|knockouts|winningsChips|winningsRub):(\d+)$/, ctx => {
  ctx.answerCbQuery();
  showRatingPage(ctx, ctx.match[1], Number(ctx.match[2]));
});

// таблица метрик без заголовка — используется и в /me (без имени), и в чужом профиле (с именем)
function statsBodyHtml(p) {
  const { rank, total } = getPlayerRank(p.telegram_id);
  const adv = getPlayerAdvancedStats(p.telegram_id);
  const winrate = p.games ? Math.round((100 * p.wins) / p.games) : 0;
  const itmRate = p.games ? Math.round((100 * (adv.itm || 0)) / p.games) : 0;
  const avgPlace = adv.avg_place ? adv.avg_place.toFixed(1) : '—';
  const bestGameRow = getPlayerBestGame(p.telegram_id);
  const bestGame = bestGameRow
    ? `<a href="https://t.me/${BOT_USERNAME}?start=game_${bestGameRow.game_id}">${bestGameRow.total_points} очк.</a>`
    : '—';
  const roiOf = (won, inv) => (inv > 0 ? Math.round(((won - inv) / inv) * 100) : null);
  const roiText = v => (v === null ? '—' : `${v > 0 ? '+' : ''}${v}%`);

  // рубли — только платные игры, реальный бай-ин
  const winnings = getPlayerWinnings(p.telegram_id);
  const invested = getPlayerInvested(p.telegram_id);
  const losses = Math.max(0, invested - winnings);
  const roiRub = roiOf(winnings, invested);

  // фишки — все игры; в бесплатных используется номинальный стек NOMINAL_CHIP_STACK
  const chipsWinnings = getPlayerChipsWinnings(p.telegram_id);
  const chipsInvested = getPlayerChipsInvested(p.telegram_id);
  const chipsLosses = Math.max(0, chipsInvested - chipsWinnings);
  const roiChips = roiOf(chipsWinnings, chipsInvested);

  const groups = [
    [['📈 Место', `${rank}/${total}`], ['💯 Очков', p.total_points]],
    [['🥇 Побед', `${p.wins} (${winrate}%)`], ['🎮 Игр', p.games], ['💵 В призовых', `${adv.itm || 0} (${itmRate}%)`]],
    [['🆓 Бесплатных', adv.free_games || 0], ['💵 Платных', adv.paid_games || 0]],
    [['📊 Среднее место', avgPlace], ['🏆 Лучший результат', bestGame]],
    [['🔫 Выбиваний', p.knockouts], ['💸 Докупок', p.rebuys]],
    [
      ['🎰 Выиграно фишек', chipsWinnings],
      ['📉 Проиграно фишек', chipsLosses],
      ['⚖️ ROI фишками', roiText(roiChips)]
    ],
    [
      ['💰 Выиграно рублей', `${winnings} ₽`],
      ['🔻 Проиграно рублей', `${losses} ₽`],
      ['⚖️ ROI рублями', roiText(roiRub)]
    ]
  ];

  const SPACER = '<tr><td colspan="2"></td></tr>';
  const body = groups
    .map(rows => rows.map(([label, value]) => `<tr><td>${label}</td><td align="center"><b>${value}</b></td></tr>`).join(''))
    .join(SPACER);

  return levelBadgeHtml(p.total_points) + `<table>${body}</table>`;
}

function meHtml(ctx) {
  const p = getPlayerByTelegramId(ctx.from.id);
  if (!p) return '<p>Ты ещё не зарегистрирован — напиши /start</p>';
  return statsBodyHtml(p);
}
function sendMe(ctx) {
  showRichPanelInline(ctx, meHtml(ctx), [[Markup.button.callback('⬅️ Главное меню', 'hist:menu')]]);
}
bot.command('me', sendMe);
bot.hears(BTN_ME, sendMe);

// профиль другого игрока — открывается по клику на его имя в таблице (рейтинг/протокол)
function otherPlayerStatsHtml(telegramId) {
  const p = getPlayerByTelegramId(telegramId);
  if (!p) return '<p>Игрок не найден.</p>';
  return `<h2>👤 ${esc(p.display_name)}</h2>` + statsBodyHtml(p);
}

// у админа под чужим профилем — кнопки управления этим игроком
function showPlayerProfile(ctx, telegramId) {
  const html = otherPlayerStatsHtml(telegramId);
  if (!isAdmin(ctx)) return showRichPanel(ctx, html, menuRows(ctx));
  const rows = [
    [Markup.button.callback('♻️ Сбросить статистику', `pr:${telegramId}`)],
    [Markup.button.callback('🗑 Удалить игрока', `pd:${telegramId}`)],
    [Markup.button.callback('⬅️ Главное меню', 'hist:menu')]
  ];
  return showRichPanelInline(ctx, html, rows);
}

bot.action(/^pv:(\d+)$/, ctx => {
  ctx.answerCbQuery();
  showPlayerProfile(ctx, Number(ctx.match[1]));
});

bot.action(/^pr:(\d+)$/, ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Только для владельца');
  const telegramId = Number(ctx.match[1]);
  const p = getPlayerByTelegramId(telegramId);
  ctx.answerCbQuery();
  showRichPanelInline(
    ctx,
    `<p>♻️ Точно сбросить статистику игрока <b>${esc(p?.display_name || telegramId)}</b>? Действие необратимо (протоколы прошлых игр не тронет, обнулит только карьерные цифры).</p>`,
    [[Markup.button.callback('✅ Да, сбросить', `prc:${telegramId}`), Markup.button.callback('❌ Отмена', `pv:${telegramId}`)]]
  );
});

bot.action(/^prc:(\d+)$/, ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Только для владельца');
  const telegramId = Number(ctx.match[1]);
  resetPlayerStats(telegramId);
  ctx.answerCbQuery('Статистика сброшена');
  showPlayerProfile(ctx, telegramId);
});

bot.action(/^pd:(\d+)$/, ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Только для владельца');
  const telegramId = Number(ctx.match[1]);
  if (getActiveGames().some(({ state }) => state.players[telegramId])) {
    return ctx.answerCbQuery('Нельзя удалить игрока, участвующего в активной игре', { show_alert: true });
  }
  const p = getPlayerByTelegramId(telegramId);
  ctx.answerCbQuery();
  showRichPanelInline(
    ctx,
    `<p>🗑 Точно удалить игрока <b>${esc(p?.display_name || telegramId)}</b> из базы? Он пропадёт из рейтинга и списка выбора игроков (историю прошлых игр это не тронет). Действие необратимо.</p>`,
    [[Markup.button.callback('✅ Да, удалить', `pdc:${telegramId}`), Markup.button.callback('❌ Отмена', `pv:${telegramId}`)]]
  );
});

bot.action(/^pdc:(\d+)$/, ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Только для владельца');
  deletePlayer(Number(ctx.match[1]));
  ctx.answerCbQuery('Игрок удалён');
  showPanel(ctx, '🗑 Игрок удалён из базы.', replyKb(menuRows(ctx)));
});

const HISTORY_PAGE_SIZE = 10;

function showHistoryPage(ctx, page) {
  const telegramId = ctx.from.id;
  const p = getPlayerByTelegramId(telegramId);
  if (!p) return showPanel(ctx, 'Ты ещё не зарегистрирован — напиши /start', replyKb(menuRows(ctx)));

  const admin = canOrganize(ctx);
  const total = admin ? getAllGamesCount() : getPlayerGamesCount(telegramId);
  if (!total) return showPanel(ctx, 'Пока нет сыгранных турниров.', replyKb(menuRows(ctx)));

  const games = admin
    ? getAllGamesPage(page * HISTORY_PAGE_SIZE, HISTORY_PAGE_SIZE)
    : getPlayerGamesPage(telegramId, page * HISTORY_PAGE_SIZE, HISTORY_PAGE_SIZE);

  const html = admin
    ? `<h2>📜 Все турниры</h2><p>Всего: ${total}. Нажми на игру, чтобы посмотреть и отредактировать протокол.</p>`
    : `<h2>📜 История: ${esc(p.display_name)}</h2><p>Всего турниров: ${total}. Нажми на игру, чтобы посмотреть протокол.</p>`;

  const rows = games.map(g => [
    Markup.button.callback(
      admin
        ? `#${g.game_no} · ${new Date(g.date).toLocaleDateString('ru-RU')} · ${g.num_players} игроков${g.buy_in ? ' · 💵' : ''}`
        : `#${g.game_no} · ${new Date(g.date).toLocaleDateString('ru-RU')} · место ${g.place} · ${g.total_points} очк.`,
      `hist:game:${g.game_id}:${page}`
    )
  ]);
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('◀️ Пред.', `hist:page:${page - 1}`));
  if ((page + 1) * HISTORY_PAGE_SIZE < total) nav.push(Markup.button.callback('След. ▶️', `hist:page:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback('⬅️ Главное меню', 'hist:menu')]);

  showRichPanelInline(ctx, html, rows);
}

bot.command('history', ctx => showHistoryPage(ctx, 0));
bot.hears(BTN_HISTORY, ctx => showHistoryPage(ctx, 0));

bot.action(/^hist:page:(\d+)$/, ctx => {
  ctx.answerCbQuery();
  showHistoryPage(ctx, Number(ctx.match[1]));
});

function showGameProtocol(ctx, gameId, page) {
  const data = getGameById(gameId);
  const html = data ? protocolHtmlFromDb(data) : '<p>Игра не найдена.</p>';
  const rows = [];
  if (data && isAdmin(ctx)) {
    rows.push([Markup.button.callback('✏️ Редактировать результаты', `ge:${gameId}:${page}`)]);
    rows.push([Markup.button.callback('🗑 Удалить игру', `gd:${gameId}:${page}`)]);
  }
  rows.push([Markup.button.callback('⬅️ К списку игр', `hist:page:${page}`)]);
  rows.push([Markup.button.callback('⬅️ Главное меню', 'hist:menu')]);
  showRichPanelInline(ctx, html, rows);
}

bot.action(/^hist:game:([0-9a-f-]+):(\d+)$/, ctx => {
  ctx.answerCbQuery();
  showGameProtocol(ctx, ctx.match[1], Number(ctx.match[2]));
});

bot.action('hist:menu', ctx => {
  ctx.answerCbQuery();
  showPanel(ctx, '🏠 Главное меню', replyKb(menuRows(ctx)));
});

// --- админ: удаление игры целиком ---

bot.action(/^gd:([0-9a-f-]+):(\d+)$/, ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Только для владельца');
  ctx.answerCbQuery();
  const [, gameId, page] = ctx.match;
  showRichPanelInline(
    ctx,
    '<p>🗑 Точно удалить эту игру целиком? Статистика всех участников пересчитается назад. Действие необратимо.</p>',
    [[Markup.button.callback('✅ Да, удалить', `gdc:${gameId}:${page}`), Markup.button.callback('❌ Отмена', `hist:game:${gameId}:${page}`)]]
  );
});

bot.action(/^gdc:([0-9a-f-]+):(\d+)$/, ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Только для владельца');
  const [, gameId, pageStr] = ctx.match;
  deleteGame(gameId);
  ctx.answerCbQuery('Игра удалена');
  showHistoryPage(ctx, Number(pageStr));
});

// --- админ: редактирование результата игрока в уже сохранённой игре ---

bot.action(/^ge:([0-9a-f-]+):(\d+)$/, ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Только для владельца');
  ctx.answerCbQuery();
  const [, gameId, page] = ctx.match;
  const data = getGameById(gameId);
  if (!data) return showRichPanelInline(ctx, '<p>Игра не найдена.</p>', [[Markup.button.callback('⬅️ Главное меню', 'hist:menu')]]);
  const rows = [
    ...data.results.map(r => [
      Markup.button.callback(`${r.player_name} (место ${r.place})`, `ep:${gameId}:${r.telegram_id}:${page}`)
    ]),
    [Markup.button.callback('⬅️ Назад', `hist:game:${gameId}:${page}`)]
  ];
  showRichPanelInline(ctx, '<p>✏️ Кого редактировать?</p>', rows);
});

function editorScreenHtml(gameId, telegramId) {
  const data = getGameById(gameId);
  const r = data.results.find(x => x.telegram_id === telegramId);
  return (
    `<h3>✏️ ${esc(r.player_name)}</h3>` +
    `<table>` +
    `<tr><td>Место</td><td><b>${r.place}</b></td></tr>` +
    `<tr><td>Докупки</td><td><b>${r.rebuys}/2</b></td></tr>` +
    `<tr><td>Выбивания</td><td><b>${r.knockouts}</b></td></tr>` +
    `<tr><td>Очки за игру</td><td><b>${r.total_points}</b></td></tr>` +
    `</table>`
  );
}

function editorButtons(gameId, telegramId, page) {
  return [
    [
      Markup.button.callback('Место −', `ea:${gameId}:${telegramId}:p:-1:${page}`),
      Markup.button.callback('Место +', `ea:${gameId}:${telegramId}:p:1:${page}`)
    ],
    [
      Markup.button.callback('Докупки −', `ea:${gameId}:${telegramId}:r:-1:${page}`),
      Markup.button.callback('Докупки +', `ea:${gameId}:${telegramId}:r:1:${page}`)
    ],
    [
      Markup.button.callback('Выбивания −', `ea:${gameId}:${telegramId}:k:-1:${page}`),
      Markup.button.callback('Выбивания +', `ea:${gameId}:${telegramId}:k:1:${page}`)
    ],
    [Markup.button.callback('✅ Готово', `ed:${gameId}:${page}`)]
  ];
}

bot.action(/^ep:([0-9a-f-]+):(\d+):(\d+)$/, ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Только для владельца');
  ctx.answerCbQuery();
  const [, gameId, telegramIdStr, page] = ctx.match;
  showRichPanelInline(ctx, editorScreenHtml(gameId, Number(telegramIdStr)), editorButtons(gameId, telegramIdStr, page));
});

bot.action(/^ea:([0-9a-f-]+):(\d+):([prk]):(-?\d+):(\d+)$/, ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Только для владельца');
  const [, gameId, telegramIdStr, field, deltaStr, page] = ctx.match;
  const telegramId = Number(telegramIdStr);
  const delta = Number(deltaStr);
  const data = getGameById(gameId);
  const cur = data && data.results.find(x => x.telegram_id === telegramId);
  if (!cur) return ctx.answerCbQuery('Не найдено');

  let place = cur.place;
  let rebuys = cur.rebuys;
  let knockouts = cur.knockouts;
  if (field === 'p') place = Math.max(1, Math.min(data.game.num_players, place + delta));
  if (field === 'r') rebuys = Math.max(0, Math.min(2, rebuys + delta));
  if (field === 'k') knockouts = Math.max(0, knockouts + delta);

  updateGameResult(gameId, telegramId, { place, rebuys, knockouts });
  ctx.answerCbQuery();
  showRichPanelInline(ctx, editorScreenHtml(gameId, telegramId), editorButtons(gameId, telegramId, page));
});

bot.action(/^ed:([0-9a-f-]+):(\d+)$/, ctx => {
  ctx.answerCbQuery();
  showGameProtocol(ctx, ctx.match[1], Number(ctx.match[2]));
});

// ---------- бэкап и восстановление (только владелец) ----------

// шлётся в личку каждому владельцу после каждого завершённого турнира — чтобы в истории личных
// сообщений всегда лежала свежая точка восстановления, без ручных действий
async function sendBackupToAdmins(caption) {
  let filePath;
  try {
    filePath = await createBackupArchive();
    for (const adminId of ADMIN_IDS) {
      await bot.telegram
        .sendDocument(adminId, Input.fromLocalFile(filePath), { caption })
        .catch(err => console.error('Не удалось отправить автобэкап', adminId, err.message));
    }
  } catch (err) {
    console.error('Ошибка автосоздания бэкапа после турнира:', err);
  } finally {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

bot.command('backup', async ctx => {
  if (!isAdmin(ctx)) return;
  let filePath;
  try {
    filePath = await createBackupArchive();
    await ctx.replyWithDocument(Input.fromLocalFile(filePath), {
      caption:
        `🗄 <b>Полный бэкап бота</b> — ${new Date().toLocaleString('ru-RU')}\n` +
        `Внутри: БД (игроки, турниры, результаты), активные столы, заявки на подтверждение.\n` +
        `Для восстановления: /restore и пришли этот файл.`,
      parse_mode: 'HTML'
    });
  } catch (err) {
    console.error('Ошибка создания бэкапа:', err);
    await ctx.reply('❌ Не удалось создать бэкап: ' + err.message);
  } finally {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

const pendingRestore = new Set(); // adminId — ждём присылки файла
const restoreCandidates = new Map(); // adminId -> { files, expiresAt }

bot.command('restore', ctx => {
  if (!isAdmin(ctx)) return;
  pendingRestore.add(ctx.from.id);
  ctx.reply(
    '📥 Пришли файлом .tar.gz бэкапа (из /backup или из личных сообщений после турнира).\n\n' +
      '⚠️ Это полностью заменит текущие данные бота — игроков, турниры, рейтинг, активные столы. Бот перезапустится сразу после подтверждения.'
  );
});

bot.on('document', async ctx => {
  if (!isAdmin(ctx) || !pendingRestore.has(ctx.from.id)) return;
  pendingRestore.delete(ctx.from.id);
  const doc = ctx.message.document;
  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const res = await fetch(link.href);
    const buffer = Buffer.from(await res.arrayBuffer());
    const inspected = inspectBackupArchive(buffer);
    if (!inspected.ok) return ctx.reply('❌ ' + inspected.error);

    restoreCandidates.set(ctx.from.id, { files: inspected.files, expiresAt: Date.now() + 10 * 60 * 1000 });
    await ctx.reply(
      `⚠️ Точно восстановить бота из файла «${doc.file_name || 'бэкап'}» (${(buffer.length / 1024).toFixed(0)} КБ)?\n\n` +
        `Все текущие данные (игроки, турниры, рейтинг, активные столы) будут ЗАМЕНЕНЫ содержимым архива. Действие необратимо (кроме как восстановлением из другого бэкапа). Перед заменой бот на всякий случай пришлёт бэкап текущего состояния тебе в личку. Бот перезапустится сразу после.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да, восстановить', 'restore:confirm'), Markup.button.callback('❌ Отмена', 'restore:cancel')]
      ])
    );
  } catch (err) {
    console.error('Ошибка обработки файла восстановления:', err);
    ctx.reply('❌ Не удалось обработать файл: ' + err.message);
  }
});

bot.action('restore:confirm', async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Только для владельца');
  const candidate = restoreCandidates.get(ctx.from.id);
  if (!candidate || candidate.expiresAt < Date.now()) {
    restoreCandidates.delete(ctx.from.id);
    return ctx.answerCbQuery('Файл больше не актуален, пришли заново через /restore', { show_alert: true });
  }
  restoreCandidates.delete(ctx.from.id);
  ctx.answerCbQuery();
  await ctx.editMessageText('⏳ Восстанавливаю и перезапускаюсь…').catch(() => {});

  try {
    const safetyPath = await createBackupArchive();
    await ctx.telegram
      .sendDocument(ctx.from.id, Input.fromLocalFile(safetyPath), {
        caption: '🛟 Автосохранение текущего состояния прямо перед восстановлением (на всякий случай)'
      })
      .catch(() => {});
    if (fs.existsSync(safetyPath)) fs.unlinkSync(safetyPath);
  } catch (err) {
    console.error('Не удалось сделать safety-бэкап перед восстановлением:', err);
  }

  applyBackupArchive(candidate.files);
  await ctx.reply('✅ Данные восстановлены. Перезапускаюсь…').catch(() => {});
  setTimeout(() => process.exit(0), 500);
});

bot.action('restore:cancel', ctx => {
  restoreCandidates.delete(ctx.from.id);
  ctx.answerCbQuery('Отменено');
  ctx.editMessageText('Восстановление отменено.').catch(() => {});
});

bot.command('help', ctx => {
  const lines = [
    `📊 /rating — общий рейтинг`,
    `👤 /me — моя статистика`,
    `📜 /history — мои последние игры`
  ];
  if (canOrganize(ctx)) {
    lines.push('', `🔧 ${b('Организатору:')}`, `🎮 /newgame — начать турнир`);
  }
  if (isAdmin(ctx)) {
    lines.push(
      '',
      `👑 ${b('Владельцу:')}`,
      `Подтверждение турниров, редактирование и удаление — кнопками в соответствующих разделах.`,
      `🗄 /backup — скачать полный бэкап данных бота`,
      `📥 /restore — восстановить из файла бэкапа`
    );
  }
  showPanel(ctx, lines.join('\n'), replyKb(menuRows(ctx)));
});

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('ru-RU');
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// rows: [{place, name, total, rebuys, knockouts}], buyIn в рублях (0 если бесплатно)
// хронология: кто кого выбил / кто докупился, со временем и минутами от старта турнира
function eventsLogHtml(events, startedAt, nameById, maxRebuys) {
  if (!events || !events.length) return '';
  const start = new Date(startedAt).getTime();
  const nameOf = id => esc(nameById[id] || 'Игрок');
  const rebuyCount = {};
  const rows = events
    .filter(e => (e.type === 'BUST' || e.type === 'REBUY') && e.at)
    .map(e => {
      const mins = Math.max(0, Math.round((new Date(e.at).getTime() - start) / 60000));
      const timeLabel = `${fmtTime(e.at)} (+${mins} мин)`;
      let text;
      if (e.type === 'BUST') {
        text = `☠️ ${nameOf(e.by)} выбивает ${nameOf(e.id)}`;
      } else {
        rebuyCount[e.id] = (rebuyCount[e.id] || 0) + 1;
        text = `💰 ${nameOf(e.id)} докупается (${rebuyCount[e.id]}/${maxRebuys})`;
      }
      return `<tr><td>${timeLabel}</td><td>${text}</td></tr>`;
    })
    .join('');
  if (!rows) return '';
  return `<h3>📜 Хронология</h3><table><tr><th>Время</th><th>Событие</th></tr>${rows}</table>`;
}

function protocolTableHtml({ gameNo, startedAt, endedAt, N, buyIn, chipStack, rows, events, nameById, maxRebuys = 2 }) {
  const title = gameNo ? `🏆 Протокол турнира №${gameNo}` : '🏆 Протокол турнира';
  const dateLine = endedAt
    ? `${fmtDate(startedAt)}, ${fmtTime(startedAt)}–${fmtTime(endedAt)}`
    : `${fmtDate(startedAt)}, ${fmtTime(startedAt)}`;

  // в платной игре банк реальный (₽), в бесплатной — реальный стартовый стек этой игры (фишки)
  const stake = buyIn || chipStack || NOMINAL_CHIP_STACK;
  const unit = buyIn ? '₽' : 'фишек';
  const initialBank = stake * N;
  const rebuyAdded = rows.reduce((sum, r) => sum + stake * r.rebuys, 0);
  const bank = initialBank + rebuyAdded;
  const bankLine = rebuyAdded > 0 ? `${initialBank} + ${rebuyAdded} = ${bank} ${unit}` : `${bank} ${unit}`;

  const metaLines = [
    `<b>Дата:</b> ${dateLine}`,
    `<b>Игроки:</b> ${N}`,
    `<b>Тип игры:</b> ${buyIn ? 'Платная' : 'Бесплатная'}`,
    `<b>Бай-ин:</b> ${stake} ${unit}`,
    `<b>Банк:</b> ${bankLine}`
  ];

  const headerRow =
    '<tr><th>Место</th><th>Игрок</th><th>Очки</th><th>Выигрыш</th><th>Рейтинг</th><th>Докупки</th><th>Выбивания</th></tr>';

  const body = rows
    .map(r => {
      const medal = r.place === 1 ? '🥇' : r.place === 2 ? '🥈' : r.place === 3 ? '🥉' : String(r.place);
      const prize = prizeForPlace(r.place, bank, N);
      const player = getPlayerByTelegramId(r.telegramId);
      const careerTotal = player ? player.total_points : r.total;
      const pointsSign = r.total > 0 ? '+' : '';
      const rankDelta = r.rankDelta;
      const rankLabel = rankDelta == null ? '—' : rankDelta > 0 ? `▲${rankDelta}` : rankDelta < 0 ? `▼${Math.abs(rankDelta)}` : '0';
      const cells = [
        `<td>${medal}</td>`,
        `<td>${levelBadgeShort(careerTotal)} ${playerLink(r.telegramId, r.name)}</td>`,
        `<td><b>${pointsSign}${r.total}</b> (${careerTotal})</td>`,
        `<td>${buyIn ? `${prize} ₽` : prize}</td>`,
        `<td>${rankLabel}</td>`,
        `<td>${r.rebuys}/${maxRebuys}</td>`,
        `<td>${r.knockouts}</td>`
      ];
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');

  return (
    `<h2>${title}</h2>` +
    `<p>${metaLines.join('<br>')}</p>` +
    `<h3>🏆 Турнирная таблица</h3>` +
    `<table>${headerRow}${body}</table>` +
    eventsLogHtml(events, startedAt, nameById || {}, maxRebuys)
  );
}

function formatProtocolHtml(state, results, N) {
  return protocolTableHtml({
    startedAt: state.date,
    endedAt: state.endedAt,
    N,
    buyIn: state.buyIn,
    chipStack: state.chipStack,
    events: state.log,
    nameById: state.players,
    maxRebuys: maxRebuysConfigured(state),
    rows: results.map(r => ({
      place: r.place,
      name: r.name,
      telegramId: r.telegramId,
      total: r.total,
      rebuys: r.rebuys,
      knockouts: r.knockouts
    }))
  });
}

// та же таблица, но из сохранённых в БД данных (для истории игр)
function protocolHtmlFromDb({ game, results }) {
  const nameById = {};
  results.forEach(r => {
    nameById[String(r.telegram_id)] = r.player_name;
  });
  return protocolTableHtml({
    gameNo: game.game_no,
    startedAt: game.date,
    endedAt: game.ended_at,
    N: game.num_players,
    buyIn: game.buy_in || 0,
    chipStack: game.chip_stack,
    events: game.events_log ? JSON.parse(game.events_log) : [],
    nameById,
    rows: results.map(r => ({
      place: r.place,
      name: r.player_name,
      telegramId: r.telegram_id,
      total: r.total_points,
      rebuys: r.rebuys,
      knockouts: r.knockouts,
      rankDelta: r.rank_before != null && r.rank_after != null ? r.rank_before - r.rank_after : null
    }))
  });
}

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('⚠️ Внутренняя ошибка: ' + err.message).catch(() => {});
});

// заявки на подтверждение, которые владелец не разобрал за 24 часа, удаляются сами
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

async function sweepExpiredApprovals() {
  const approvals = getAllPendingApprovals();
  const now = Date.now();
  for (const [id, approval] of Object.entries(approvals)) {
    if (now - approval.createdAt < APPROVAL_TTL_MS) continue;
    removePendingApproval(id);
    await bot.telegram
      .sendMessage(
        approval.requestedBy,
        '⌛ Прошло 24 часа без подтверждения — протокол турнира удалён, в статистику он не попал. Уточни детали у владельца лиги.'
      )
      .catch(() => {});
    for (const adminId of ADMIN_IDS) {
      await bot.telegram
        .sendMessage(adminId, `⌛ Заявка от ${approval.requestedByName} автоматически удалена — прошло 24 часа без ответа.`)
        .catch(() => {});
    }
  }
}

// unref — иначе этот таймер сам по себе держит event loop живым, и процесс не завершается по
// SIGTERM (bot.stop() останавливает только поллинг), а systemd приходится добивать SIGKILL по таймауту
setInterval(() => {
  sweepExpiredApprovals().catch(err => console.error('Approval sweep failed:', err.message));
}, 30 * 60 * 1000).unref(); // раз в 30 минут

(async () => {
  const me = await bot.telegram.getMe();
  BOT_USERNAME = me.username;
  console.log(`Poker bot started (long polling) as @${BOT_USERNAME}`);
  sweepExpiredApprovals().catch(err => console.error('Initial approval sweep failed:', err.message));
  bot.launch(); // не await — промис резолвится только после остановки поллинга
})();

function shutdown(signal) {
  bot.stop(signal);
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
