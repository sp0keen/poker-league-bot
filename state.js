const fs = require('fs');
const path = require('path');

// несколько одновременных столов: файл хранит { [ownerId]: gameState }
const GAMES_FILE = path.join(__dirname, 'active_games.json');

function loadGames() {
  if (!fs.existsSync(GAMES_FILE)) return {};
  return JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8'));
}

function saveGames(games) {
  fs.writeFileSync(GAMES_FILE, JSON.stringify(games, null, 2));
}

function getState(ownerId) {
  const games = loadGames();
  return games[ownerId] || null;
}

function setState(ownerId, state) {
  const games = loadGames();
  games[ownerId] = state;
  saveGames(games);
}

function clearState(ownerId) {
  const games = loadGames();
  delete games[ownerId];
  saveGames(games);
}

// [{ ownerId: Number, state }] — для панели "Активные игры" у владельца
function getActiveGames() {
  const games = loadGames();
  return Object.keys(games).map(ownerId => ({ ownerId: Number(ownerId), state: games[ownerId] }));
}

function hasActiveGames() {
  const games = loadGames();
  return Object.keys(games).length > 0;
}

// турниры, ожидающие подтверждения владельца, прежде чем попасть в статистику
const APPROVALS_FILE = path.join(__dirname, 'pending_approvals.json');

function getApprovals() {
  if (!fs.existsSync(APPROVALS_FILE)) return {};
  return JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf8'));
}

function saveApprovals(approvals) {
  fs.writeFileSync(APPROVALS_FILE, JSON.stringify(approvals, null, 2));
}

function addPendingApproval(id, data) {
  const approvals = getApprovals();
  approvals[id] = { ...data, createdAt: data.createdAt || Date.now() };
  saveApprovals(approvals);
}

function getPendingApproval(id) {
  return getApprovals()[id] || null;
}

function getAllPendingApprovals() {
  return getApprovals();
}

function removePendingApproval(id) {
  const approvals = getApprovals();
  delete approvals[id];
  saveApprovals(approvals);
}

module.exports = {
  getState,
  setState,
  clearState,
  getActiveGames,
  hasActiveGames,
  addPendingApproval,
  getPendingApproval,
  getAllPendingApprovals,
  removePendingApproval,
  GAMES_FILE,
  APPROVALS_FILE
};
