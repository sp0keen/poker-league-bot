// Ачивки — в отличие от титулов (titles.js), разблокируются один раз и остаются навсегда.
// Проверяются в db.js#checkAndUnlockAchievements сразу после сохранения результатов игры.
const ACHIEVEMENTS = [
  { id: 'debut', emoji: '🎉', name: 'Дебютант', description: 'Первая сыгранная игра' },
  { id: 'firstWin', emoji: '🏆', name: 'С почином!', description: 'Первая победа в турнире' },
  { id: 'phoenix', emoji: '🧟', name: 'Восстание из пепла', description: 'Выбыл, докупился и всё равно выиграл турнир' },
  { id: 'skillOnly', emoji: '🧠', name: 'На скилле', description: 'Выиграл турнир без единой докупки' },
  { id: 'hatTrick', emoji: '🔥', name: 'Хет-трик', description: '3 победы подряд' },
  { id: 'rockBottom', emoji: '🕳', name: 'Пробил дно', description: '3 турнира подряд на последнем месте' },
  { id: 'solo', emoji: '🦾', name: 'Соло', description: 'Лично выбил вообще всех соперников за столом в одной игре' },
  { id: 'veteran', emoji: '🎖', name: 'Ветеран', description: '50 сыгранных турниров' },
  { id: 'round100', emoji: '💯', name: 'Круглая цифра', description: 'Общий счёт очков в лиге ровно кратен 100' },
  { id: 'peacemaker', emoji: '🤝', name: 'Миротворец', description: 'Сыграл турнир вообще без единого нокаута' }
];

module.exports = { ACHIEVEMENTS };
