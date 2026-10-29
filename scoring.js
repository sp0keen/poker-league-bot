// очки за место — фиксированная таблица на 4-10 игроков. Награда растёт с размером стола:
// 1-е место = N + 2, промежуточные места — round((N + 2) * r^1.3), r = (N - 1 - место) / (N - 2),
// так что верх лестницы ценится сильнее низа. Штраф тоже растёт: последнее место -1 (4-5 игроков),
// -2 (6-8), -3 (9-10); предпоследнее 0, а на 9-10 игроках -1, чтобы шаг внизу не был резче, чем
// наверху. Соседние места всегда различаются минимум на 1 очко
const PLACEMENT_POINTS = {
  4: [6, 2, 0, -1],
  5: [7, 4, 2, 0, -1],
  6: [8, 6, 3, 1, 0, -2],
  7: [9, 7, 5, 3, 1, 0, -2],
  8: [10, 8, 6, 4, 2, 1, 0, -2],
  9: [11, 9, 7, 5, 4, 2, 1, -1, -3],
  10: [12, 10, 8, 7, 5, 3, 2, 1, -1, -3]
};

function placementPoints(place, N) {
  return PLACEMENT_POINTS[N][place - 1];
}

// коэффициент очков по схеме уровней: турбо-турнир идёт в разы быстрее, и без скидки несколько
// турбо подряд обгоняли бы по очкам обычные турниры. Схемы без записи здесь — ×1
const POINTS_MULTIPLIER_BY_SCHEDULE = { fast5: 0.5 };

function pointsMultiplier(schedule) {
  return POINTS_MULTIPLIER_BY_SCHEDULE[schedule] || 1;
}

// итог умножается целиком и округляется до целого, ровно .5 — вверх: 5 → 3, −3 → −1.
// Минус в ноль не превращается: −1 остаётся −1, иначе вылет первым в турбо ничего бы не стоил
function applyMultiplier(points, multiplier = 1) {
  if (multiplier === 1) return points;
  const rounded = Math.floor(points * multiplier + 0.5);
  if (points < 0 && rounded >= 0) return -1;
  return rounded || 0; // || 0 — без −0
}

// очки игрока за игру: место − 2 за каждый re-entry + 1 за каждый knockout, затем коэффициент
function gamePoints({ place, N, rebuys, knockouts, multiplier = 1 }) {
  const placementPts = placementPoints(place, N);
  return { placementPts, total: applyMultiplier(placementPts - 2 * rebuys + knockouts, multiplier) };
}

module.exports = { placementPoints, PLACEMENT_POINTS, pointsMultiplier, applyMultiplier, gamePoints };
