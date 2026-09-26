// Калькулятор структуры турнира по заданному набору фишек (номинал -> количество в наличии).
// Всё здесь — эвристики, подобранные по образцу ручной раскладки: 5/10 старт, удвоение
// блайндов, докупки 2 стека -> 1 стек -> запрещены по третям уровней, отработавший номинал
// уходит из игры и возвращается позже как ×100 от своего исходного значения.

const STANDARD_CHIPSET = [
  { value: 5, count: 120 },
  { value: 10, count: 120 },
  { value: 25, count: 120 },
  { value: 50, count: 120 },
  { value: 100, count: 120 }
];

// эталонная раскладка стартового стека для дефолтного набора 5/10/25/50/100 (проверенная,
// подобранная руками для удобной игры — не выводится по формуле, поэтому просто зашита как есть).
// Цель — 100бб (SB/BB стартового уровня всегда равны младшим двум номиналам, см. computeBlindLevels),
// а не голая сумма: довесок сверх прежних 500 намеренно взят сотками и полтинниками, а не крупными
// номиналами — младшие чипы и так уже станут блайндами на ранних уровнях, а не будут лежать мёртвым
// грузом, как лежала бы, например, фишка 500 при блайндах 5/10
const REFERENCE_STACK = { 5: 10, 10: 5, 25: 8, 50: 4, 100: 5 }; // итого 1000, 32 фишки

function isReferenceChipset(denoms) {
  const values = denoms.map(d => d.value).sort((a, b) => a - b);
  const ref = Object.keys(REFERENCE_STACK).map(Number).sort((a, b) => a - b);
  return values.length === ref.length && values.every((v, i) => v === ref[i]);
}

// темп турнира — влияет на то, сколько фишек уходит в стартовые стеки, а сколько остаётся в
// резерве на докупки/размен. Для бесплатных игр темп ещё и двигает саму целевую сумму стека
// (медленный — глубже в резерв, быстрый — крупнее стеки сразу), для платных целевая сумма — это
// бай-ин, темп там только меняет агрессивность использования остатка (reserveFactor)
// smallestMult/largestMult подобраны так, чтобы на дефолтном наборе (SB/BB = 5/10) обычный темп
// давал 100бб (было 50бб) — остальные темпы масштабированы от него в тех же пропорциях, что и раньше
// (медленный — 0.6×, быстрый — 1.6× от обычного), чтобы соотношение темпов не поменялось
const TEMPO_PRESETS = {
  slow: { label: 'Медленный', reserveFactor: 0.6, smallestMult: 120, largestMult: 6 },
  normal: { label: 'Обычный', reserveFactor: 0.8, smallestMult: 200, largestMult: 10 },
  fast: { label: 'Быстрый', reserveFactor: 0.95, smallestMult: 320, largestMult: 16 }
};

// прежние (до перехода на 100бб) множители — запасной вариант для наборов, которым физически не
// хватает фишек на новую глубину (например тонкий 5/10/20/50×24: на нём и старая цель 500 не всегда
// набиралась полностью, а новая 1000 недобирает уже сотнями). Раз набор не тянет 100бб — тянем
// столько, сколько тянул раньше, вместо того чтобы молча выдавать урезанный обрубок от новой цели
const LEGACY_TEMPO_PRESETS = {
  slow: { reserveFactor: 0.6, smallestMult: 60, largestMult: 3 },
  normal: { reserveFactor: 0.8, smallestMult: 100, largestMult: 5 },
  fast: { reserveFactor: 0.95, smallestMult: 160, largestMult: 8 }
};

// бесплатная игра / свой набор без суммы бай-ина: фиксированный стартовый стек на игрока
// (не зависит от N — как в реальном домашнем турнире, где стек задаётся набором фишек, а не
// количеством участников). Для дефолтного набора на обычном темпе — эталонная раскладка (она
// откалибрована именно под него); на медленном/быстром темпе, как и для своего набора, целевая
// сумма = максимум из (младший номинал × mult) и (старший номинал × mult) по темпу. Одного
// младшего номинала недостаточно: если в наборе большой разброс (например 1 и 100), "младший
// × 100" даёт смехотворно маленький стек и вообще не трогает старшие номиналы, хотя набор
// спокойно тянет больше — берём то из двух, что даёт более щедрый стек.
function computeStandardStack(denoms, N, tempo = 'normal') {
  if (tempo === 'normal' && isReferenceChipset(denoms)) {
    const cap = Math.min(...denoms.map(d => Math.floor(d.count / N)));
    const needsMost = Math.max(...Object.values(REFERENCE_STACK));
    if (cap >= needsMost) {
      const perPlayer = Object.entries(REFERENCE_STACK)
        .map(([value, take]) => ({ value: Number(value), take }))
        .sort((a, b) => a.value - b.value);
      const totalValue = perPlayer.reduce((s, d) => s + d.value * d.take, 0);
      const totalPieces = perPlayer.reduce((s, d) => s + d.take, 0);
      return { perPlayer, totalValue, totalPieces, shortfall: 0 };
    }
  }
  const preset = TEMPO_PRESETS[tempo] || TEMPO_PRESETS.normal;
  const values = denoms.map(d => d.value);
  const smallest = Math.min(...values);
  const largest = Math.max(...values);
  const target = Math.max(smallest * preset.smallestMult, largest * preset.largestMult);
  const attempt = computeTargetStack(denoms, N, target, preset.reserveFactor);
  if (attempt.shortfall === 0) return attempt;
  // набора не хватает на новую (100бб-эквивалентную) глубину — откатываемся на старую цель для
  // этого темпа, а не отдаём молча урезанный стек от новой. Если не хватает и на неё — вернётся
  // её собственный (меньший) shortfall, как и было устроено до перехода на 100бб
  const legacy = LEGACY_TEMPO_PRESETS[tempo] || LEGACY_TEMPO_PRESETS.normal;
  const legacyTarget = Math.max(smallest * legacy.smallestMult, largest * legacy.largestMult);
  return computeTargetStack(denoms, N, legacyTarget, legacy.reserveFactor);
}

// платная игра: набираем стек как можно ближе к targetValue (бай-ин в рублях).
// Сначала пробуем набрать сумму, используя не больше reserveFactor запаса каждого номинала —
// это специально оставляет резерв в банке на докупки и размен фишек по ходу игры (по умолчанию
// 80%, темп турнира может сделать его мягче или жёстче). Если такой мягкий лимит не даёт набрать
// нужную сумму — пересчитываем без ограничения: сумма стартового стека важнее резерва,
// недобирать её ради докупок нельзя.
const RESERVE_FACTOR = 0.8;

// точный подбор суммы (ограниченный "рюкзак"): жадный перебор от старшего номинала к младшему
// не гарантирует точное попадание в цель даже когда оно есть и легко достижимо (например, цель
// 100 при номиналах 1/5/10/25 жадно даёт 96, хотя 4×25=100 очевидно). DP находит максимально
// достижимую сумму ≤ target при заданных лимитах по каждому номиналу и восстанавливает состав.
// Для разумных сумм (бай-ины/стеки домашней игры) считается за миллисекунды; на экзотически
// большие суммы включается бюджетная защита с откатом на прежнюю быструю эвристику.
function bestExactFill(ascending, caps, target) {
  const k = ascending.length;
  const dp = Array.from({ length: k + 1 }, () => new Uint8Array(target + 1));
  const use = Array.from({ length: k + 1 }, () => new Int32Array(target + 1).fill(-1));
  dp[0][0] = 1;
  for (let i = 0; i < k; i++) {
    const d = ascending[i].value;
    const cap = caps[i];
    for (let v = 0; v <= target; v++) {
      if (!dp[i][v]) continue;
      for (let kk = 0; kk <= cap && v + kk * d <= target; kk++) {
        const nv = v + kk * d;
        if (!dp[i + 1][nv]) {
          dp[i + 1][nv] = 1;
          use[i + 1][nv] = kk;
        }
      }
    }
  }
  let best = 0;
  for (let v = target; v >= 0; v--) {
    if (dp[k][v]) {
      best = v;
      break;
    }
  }
  const perPlayer = [];
  let v = best;
  for (let i = k; i >= 1; i--) {
    const kk = use[i][v];
    if (kk > 0) perPlayer.push({ value: ascending[i - 1].value, take: kk });
    v -= kk * ascending[i - 1].value;
  }
  return { perPlayer, totalValue: best };
}

// быстрая эвристика для подстраховки — используется только когда точный DP слишком дорог
function greedyFill(ascending, caps, target) {
  const order = ascending.map((d, i) => ({ d, cap: caps[i] })).sort((a, b) => b.d.value - a.d.value);
  const perPlayer = [];
  let remaining = target;
  for (const { d, cap } of order) {
    const take = Math.min(cap, Math.floor(remaining / d.value));
    if (take > 0) {
      perPlayer.push({ value: d.value, take });
      remaining -= take * d.value;
    }
  }
  return { perPlayer, totalValue: target - remaining };
}

function canAffordExactSolver(target, caps) {
  if (target <= 0 || target > 200000) return target === 0;
  const totalCap = caps.reduce((s, c) => s + c, 0);
  return target * (totalCap + caps.length) <= 5_000_000;
}

function fillStack(denoms, N, targetValue, capFactor, forceSmallReserve = true) {
  const ascending = [...denoms].sort((a, b) => a.value - b.value);
  const smallest = ascending[0];

  const smallHardCap = Math.floor(smallest.count / N);
  const smallCap = Math.floor(smallHardCap * capFactor);
  // на маленьком бай-ине 10% округляются в 0 — тогда без резерва можно набрать сумму одной
  // крупной фишкой и оставить игрока вообще без мелких, которыми нечем ставить SB. Если сумма
  // вообще позволяет одну мелкую фишку — резервируем хотя бы одну. Резерв ограничен половиной
  // доступного лимита — иначе он может забрать вообще весь запас младшего номинала и оставить
  // точному подбору нечем дотянуть сумму до цели (см. случай 1/5/10/25 на цель 100). forceSmallReserve
  // — аварийный выключатель: если пул уже тонкий (например, при подсчёте резерва на докупки),
  // сама эта бронь может сделать цель недостижимой даже при полном запасе — тогда computeTargetStack
  // пересчитывает совсем без брони, приоритет — попасть в сумму, а не гранулярность
  const wantSmall =
    forceSmallReserve && targetValue >= smallest.value
      ? Math.max(1, Math.floor((targetValue * 0.1) / smallest.value))
      : 0;
  const smallReserve = Math.min(Math.ceil(smallCap / 2), wantSmall);

  const perPlayer = [];
  if (smallReserve > 0) perPlayer.push({ value: smallest.value, take: smallReserve });
  const remaining = targetValue - smallReserve * smallest.value;

  const caps = ascending.map((d, i) => {
    const cap = Math.floor(Math.floor(d.count / N) * capFactor);
    return i === 0 ? cap - smallReserve : cap; // у младшего номинала часть лимита уже забронирована резервом
  });

  const fillResult = canAffordExactSolver(remaining, caps)
    ? bestExactFill(ascending, caps, remaining)
    : greedyFill(ascending, caps, remaining);

  fillResult.perPlayer.forEach(p => {
    const already = perPlayer.find(x => x.value === p.value);
    if (already) already.take += p.take;
    else perPlayer.push(p);
  });

  perPlayer.sort((a, b) => a.value - b.value);
  const totalValue = smallReserve * smallest.value + fillResult.totalValue;
  const totalPieces = perPlayer.reduce((s, d) => s + d.take, 0);
  return { perPlayer, totalValue, totalPieces, shortfall: targetValue - totalValue };
}

function computeTargetStack(denoms, N, targetValue, reserveFactor = RESERVE_FACTOR) {
  const soft = fillStack(denoms, N, targetValue, reserveFactor);
  if (soft.shortfall === 0) return soft;
  const hard = fillStack(denoms, N, targetValue, 1);
  if (hard.shortfall === 0) return hard;
  // даже с полным запасом не хватило — возможно, виновата сама бронь мелкого номинала
  // (см. forceSmallReserve выше). Последняя попытка — вообще без неё
  return fillStack(denoms, N, targetValue, 1, false);
}

// ---------- блайнды (игра по времени) ----------

// эталонная сетка малых блайндов для набора 5/10/25/50/100 (BB = 2×SB) — подобрана руками, как и
// REFERENCE_STACK: рост ×1.25–2 за уровень (а не удвоение), и каждый блайнд ставится одной-двумя
// фишками. 20/40 пропущен намеренно — ставить удобно, но между 15/30 и 25/50 он почти ничего не
// меняет. Пятёрки нужны до 15/30 включительно, поэтому до 25/50 их не разменивают
const REFERENCE_SB_LADDER = [5, 10, 15, 25, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000];

// "круглые" мантиссы для своего набора фишек — блайнд всегда вида m×10^k
const NICE_MANTISSAS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8];
const MIN_LEVEL_GROWTH = 1.25;
// сетка тянется до SB = 600× младший номинал (на эталонном наборе это 3000/6000) — с запасом,
// чтобы турнир при любом составе доигрывался раньше, чем она кончится
const LADDER_SPAN = 600;

function nextNiceMultiple(min, step) {
  for (let exp = Math.floor(Math.log10(min)) - 1; ; exp++) {
    for (const m of NICE_MANTISSAS) {
      const v = Math.round(m * 10 ** exp * 1000) / 1000;
      if (v >= min && Number.isInteger(v / step)) return v;
    }
  }
}

// свой набор: от младшего номинала вверх, каждый следующий SB — ближайшее круглое число не меньше
// ×1.25 от предыдущего, кратное младшему номиналу (иначе его физически нечем поставить)
function generateSbLadder(d) {
  const ladder = [d[0]];
  while (ladder[ladder.length - 1] < d[0] * LADDER_SPAN) {
    ladder.push(nextNiceMultiple(ladder[ladder.length - 1] * MIN_LEVEL_GROWTH, d[0]));
  }
  return ladder;
}

// длина уровня: ровные — всегда 20 мин; с ускорением — ур. 1–4 по 20, 5–8 по 15, дальше по 12
const LEVEL_SCHEDULES = {
  flat: { label: 'Ровные 20 мин', minutes: () => 20 },
  turbo: { label: 'С ускорением', minutes: i => (i < 4 ? 20 : i < 8 ? 15 : 12) }
};

// { ante, schedule } — настройки турнира. Анте = большой блайнд, платит его игрок на BB (BB ante).
// С анте первый уровень повторяется дважды: сначала без анте, потом те же блайнды с анте, а дальше
// анте на всех уровнях — как в офлайн-структуре. Без анте этого повтора нет
function computeBlindLevels(denoms, { ante = false, schedule = 'flat' } = {}) {
  const d = [...denoms].map(x => x.value).sort((a, b) => a - b);
  const sbs = isReferenceChipset(denoms) ? REFERENCE_SB_LADDER : generateSbLadder(d);
  let levels = sbs.map(sb => ({ sb, bb: sb * 2, ante: 0 }));
  if (ante) levels = [levels[0], ...levels.map(lv => ({ ...lv, ante: lv.bb }))];
  const minutes = (LEVEL_SCHEDULES[schedule] || LEVEL_SCHEDULES.flat).minutes;
  return levels.map((lv, i) => ({ ...lv, minutes: minutes(i) }));
}

// "50/100" или "50/100/100" с анте
function blindsLabel(lv) {
  return lv.ante ? `${lv.sb}/${lv.bb}/${lv.ante}` : `${lv.sb}/${lv.bb}`;
}

// re-entry открыт, пока BB не больше 30 стартовых BB (на эталонном наборе — до конца 150/300):
// дальше стек re-entry — это 3 BB и меньше, докупка на пару раздач. Не запрещаем её раньше
// намеренно: кто хочет рискнуть на короткий стек — пусть рискует
const REBUY_CLOSE_BB_MULT = 30;
const REBUY_OPEN = '✅ Открыт';
const REBUY_CLOSED = '❌ Запрещены';

function computeRebuySchedule(levels) {
  const limit = levels[0].bb * REBUY_CLOSE_BB_MULT;
  return levels.map(lv => (lv.bb <= limit ? REBUY_OPEN : REBUY_CLOSED));
}

// можно ли набрать amount фишками номиналов values (без ограничения по количеству). Свой набор
// может быть с дробными номиналами (0.5) — считаем в сотых долях
function representable(amount, values) {
  const toInt = x => Math.round(x * 100);
  const target = toInt(amount);
  const coins = values.map(toInt);
  const can = new Uint8Array(target + 1);
  can[0] = 1;
  for (let v = 1; v <= target; v++) {
    can[v] = coins.some(x => x <= v && can[v - x]) ? 1 : 0;
  }
  return can[target] === 1;
}

// когда номинал уходит из игры и когда возвращается повышенным. Уходит — с первого уровня, после
// которого он больше ни разу не нужен: любой блайнд/анте этого и всех следующих уровней набирается
// более крупными номиналами (стандартное правило разменов в турнирах — фишку убирают, когда она не
// нужна для блайндов). Возвращается — как ×100 (или ×1000, если ×100 занято/не крупнее старшего
// номинала) с первого уровня, где BB дорос до её новой ценности. Старший номинал — якорь, всегда в игре
// activeDenomsAtLevel зовётся в циклах подсчёта резерва re-entry (на каждый уровень, на каждую
// пробную докупку) — сам расчёт не дешёвый, а входные данные у одной игры всегда одни и те же
const lifecycleCache = new Map();

function denomLifecycle(d, levels) {
  const key = JSON.stringify([d, levels.map(lv => [lv.sb, lv.bb, lv.ante || 0])]);
  if (!lifecycleCache.has(key)) lifecycleCache.set(key, computeDenomLifecycle(d, levels));
  return lifecycleCache.get(key);
}

function computeDenomLifecycle(d, levels) {
  const k = d.length;
  const largest = d[k - 1];
  const amountsAt = lv => [lv.sb, lv.bb, lv.ante].filter(a => a > 0);
  const usedPromoted = new Set(d);
  return d.map((value, j) => {
    if (j === k - 1) return { value, retireAt: Infinity };
    const larger = d.slice(j + 1);
    let lastNeeded = -1;
    levels.forEach((lv, i) => {
      if (amountsAt(lv).some(a => !representable(a, larger))) lastNeeded = i;
    });
    // пока номинал не меньше SB, он и так в ходу — раньше этого не убираем даже "ненужный"
    const firstBelowSb = levels.findIndex(lv => lv.sb > value);
    const retireAt = Math.max(lastNeeded + 1, firstBelowSb === -1 ? Infinity : firstBelowSb);
    if (retireAt >= levels.length) return { value, retireAt: Infinity };
    let promotedValue = value * 100;
    while (promotedValue <= largest || usedPromoted.has(promotedValue)) promotedValue *= 10;
    usedPromoted.add(promotedValue);
    const returnIdx = levels.findIndex((lv, i) => i > retireAt && lv.bb >= promotedValue);
    return { value, retireAt, promoteAt: returnIdx === -1 ? Infinity : returnIdx, promotedValue };
  });
}

// какие номиналы в игре на уровне i, каждый — {value, effectiveValue}: value — печатный номинал
// (по нему считается физический остаток фишек в наборе), effectiveValue — принимаемая сейчас
// ценность (совпадает с value, пока номинал не был выведен и возвращён с повышенным значением)
function activeDenomsAtLevel(denoms, levels, i) {
  const d = [...denoms].map(x => x.value).sort((a, b) => a - b);
  const active = [];
  denomLifecycle(d, levels).forEach(c => {
    if (i < c.retireAt) active.push({ value: c.value, effectiveValue: c.value });
    else if (i >= c.promoteAt) active.push({ value: c.value, effectiveValue: c.promotedValue });
  });
  return active.sort((a, b) => a.value - b.value);
}

function computeDenomSchedule(denoms, levels) {
  return levels.map((_, i) =>
    activeDenomsAtLevel(denoms, levels, i)
      .map(a => (a.value === a.effectiveValue ? `${a.value}` : `${a.value}=${a.effectiveValue}`))
      .join(', ')
  );
}

// призовых мест — примерно половина от числа игроков: 4 игрока -> 2 места, 5-8 -> 3 места.
// Округление до сотни. Возвращает массив [{place, amount}, ...].
// округление каждого места до сотни по отдельности может дать сумму больше банка (например,
// 3500 при 7 игроках: 1750->1800 и 1050->1100 в сумме уже 2900, а с 3-м местом — 3600).
// Поэтому последнее призовое место — остаток от банка, а не независимое округление
function prizeBreakdown(bank, N) {
  const round100 = v => Math.round(v / 100) * 100;
  const shares = N <= 4 ? [0.65, 0.35] : [0.5, 0.3, 0.2];
  const amounts = shares.slice(0, -1).map(share => round100(bank * share));
  let last = bank - amounts.reduce((s, a) => s + a, 0);
  // на маленьком банке остаток может перевесить предыдущее место (напр. банк 490 на 5 игроков:
  // 1е=200, 2е=100, а остаток на 3е получался бы 190 — больше второго места). Такое не отдаём:
  // остаток не больше предыдущего места, а разницу оставляем на первом
  const prevAmount = amounts[amounts.length - 1];
  if (last > prevAmount) {
    amounts[0] += last - prevAmount;
    last = prevAmount;
  }
  amounts.push(last);
  return amounts.map((amount, i) => ({ place: i + 1, amount }));
}

// парсер пользовательского набора: "5=120,10=120,25=60"
function parseChipSet(text) {
  const parts = text.split(',').map(s => s.trim()).filter(Boolean);
  const denoms = [];
  for (const part of parts) {
    const m = part.match(/^(\d+(?:\.\d+)?)\s*=\s*(\d+)$/);
    if (!m) return null;
    denoms.push({ value: Number(m[1]), count: Number(m[2]) });
  }
  if (!denoms.length) return null;
  return denoms.sort((a, b) => a.value - b.value);
}

module.exports = {
  STANDARD_CHIPSET,
  computeStandardStack,
  computeTargetStack,
  computeBlindLevels,
  blindsLabel,
  LEVEL_SCHEDULES,
  REBUY_CLOSED,
  computeRebuySchedule,
  computeDenomSchedule,
  activeDenomsAtLevel,
  prizeBreakdown,
  parseChipSet
};
