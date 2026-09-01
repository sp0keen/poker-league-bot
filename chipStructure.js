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
// подобранная руками для удобной игры — не выводится по формуле, поэтому просто зашита как есть)
const REFERENCE_STACK = { 5: 10, 10: 5, 25: 8, 50: 2, 100: 1 }; // итого 500, 26 фишек

function isReferenceChipset(denoms) {
  const values = denoms.map(d => d.value).sort((a, b) => a - b);
  const ref = Object.keys(REFERENCE_STACK).map(Number).sort((a, b) => a - b);
  return values.length === ref.length && values.every((v, i) => v === ref[i]);
}

// темп турнира — влияет на то, сколько фишек уходит в стартовые стеки, а сколько остаётся в
// резерве на докупки/размен. Для бесплатных игр темп ещё и двигает саму целевую сумму стека
// (медленный — глубже в резерв, быстрый — крупнее стеки сразу), для платных целевая сумма — это
// бай-ин, темп там только меняет агрессивность использования остатка (reserveFactor)
const TEMPO_PRESETS = {
  slow: { label: 'Медленный', reserveFactor: 0.6, smallestMult: 60, largestMult: 3 },
  normal: { label: 'Обычный', reserveFactor: 0.8, smallestMult: 100, largestMult: 5 },
  fast: { label: 'Быстрый', reserveFactor: 0.95, smallestMult: 160, largestMult: 8 }
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
  return computeTargetStack(denoms, N, target, preset.reserveFactor);
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

// блайнды — свойство набора фишек, а не стека: по одному уровню на каждый номинал (SB = сам
// номинал), затем уровень на удвоенный старший номинал, затем уровни на номиналы, вернувшиеся
// в игру ×100 (см. computeDenomSchedule) — тот же порядок, что и их возврат в оборот.
// Для эталонного набора 5/10/25/50/100 даёт ровно 5/10, 10/20, 25/50, 50/100, 100/200, 200/400,
// 500/1000 — как в исходной ручной раскладке.
// наименьший множитель вида 10^k (10, 100, 1000, ...), при котором value×множитель не меньше
// floor. Раньше возврат номинала в игру был жёстко ×100, но если естественное удвоение уже
// обогнало эту сотню (например, младший номинал 1 при якоре 100), фишка возвращалась каким-то
// некруглым числом вроде 400 — вместо этого сразу перескакиваем на следующий круглый разряд (1000)
function nicePromotionMultiplier(value, floor) {
  let mult = 10;
  while (value * mult < floor) mult *= 10;
  return mult;
}

function computeBlindLevels(denoms) {
  const d = [...denoms].map(x => x.value).sort((a, b) => a - b);
  const k = d.length;
  // k номиналов + уровень удвоенного якоря + один уровень возврата номиналов — ровно столько
  // показывает исходная ручная раскладка для 5/10/25/50/100 (5+1+1=7 уровней)
  const maxLevels = Math.min(k + 2, 12);
  const levels = [];
  let sb = 0;
  for (let i = 0; i < maxLevels; i++) {
    if (i < k) sb = d[i];
    else if (i === k) sb = 2 * d[k - 1];
    else {
      const j = i - k - 1;
      const floor = 2 * sb;
      sb = d[j] * nicePromotionMultiplier(d[j], floor);
    }
    levels.push({ sb, bb: sb * 2 });
  }
  return levels;
}

// докупки: первая треть уровней — до 2 стеков, средняя треть — 1 стек, последняя — запрещены
function computeRebuySchedule(levels) {
  const n = levels.length;
  return levels.map((_, i) => {
    if (i < Math.ceil(n / 3)) return 'До 2 стеков';
    if (i < Math.ceil((2 * n) / 3)) return 'Только 1 стек';
    return '❌ Запрещены';
  });
}

// структурная версия: какие номиналы в игре на уровне i, каждый — {value, effectiveValue}, где
// value — печатный номинал (по нему считается физический остаток фишек в наборе), effectiveValue
// — принимаемая сейчас ценность (совпадает с value, пока номинал не был выведён и возвращён с
// повышенным значением). Старший номинал — якорь, всегда в игре. Остальные — каждый уходит из
// игры через 2 уровня после своего собственного (стал слишком мелким для блайндов) и
// возвращается через ещё 3 уровня, уже как ×100 от исходного значения (см. computeBlindLevels —
// там он ровно на этом уровне и становится значением блайнда)
function activeDenomsAtLevel(denoms, levels, i) {
  const d = [...denoms].map(x => x.value).sort((a, b) => a - b);
  const k = d.length;
  const active = [{ value: d[k - 1], effectiveValue: d[k - 1] }];
  for (let j = 0; j < k - 1; j++) {
    const retireAt = j + 2;
    // становится видно на уровень раньше, чем его номинал реально станет блайндом
    // (тот уровень — k+1+j в computeBlindLevels, см. индекс promoIdx = i-k-1 там)
    const promoteAt = k + j;
    if (i < retireAt) {
      active.push({ value: d[j], effectiveValue: d[j] });
    } else if (i >= promoteAt) {
      const resolvedLevel = levels[k + 1 + j];
      // если уровень, где номинал реально станет блайндом, за пределами таблицы — считаем
      // так же (следующий круглый разряд после продолжения удвоения), а не жёстко ×100
      const promotedValue = resolvedLevel
        ? resolvedLevel.sb
        : d[j] * nicePromotionMultiplier(d[j], 2 * levels[levels.length - 1].sb);
      active.push({ value: d[j], effectiveValue: promotedValue });
    }
  }
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
  TEMPO_PRESETS,
  computeStandardStack,
  computeTargetStack,
  computeBlindLevels,
  computeRebuySchedule,
  computeDenomSchedule,
  activeDenomsAtLevel,
  prizeBreakdown,
  parseChipSet
};
