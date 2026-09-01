// очки за место — фиксированная таблица на 4-8 игроков (не формула): 1-е место всегда 10,
// последнее всегда -1, остальные подобраны вручную под каждое N
const PLACEMENT_POINTS = {
  4: [10, 5, 2, -1],
  5: [10, 5, 2, 1, -1],
  6: [10, 6, 3, 2, 1, -1],
  7: [10, 7, 5, 3, 2, 0, -1],
  8: [10, 7, 5, 3, 2, 1, 0, -1]
};

function placementPoints(place, N) {
  return PLACEMENT_POINTS[N][place - 1];
}

module.exports = { placementPoints, PLACEMENT_POINTS };
