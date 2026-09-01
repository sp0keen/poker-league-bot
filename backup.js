const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { backupDatabaseTo, closeDatabase } = require('./db');
const { GAMES_FILE, APPROVALS_FILE } = require('./state');

const DB_PATH = path.join(__dirname, 'poker.db');
const TMP_SNAPSHOT_PATH = path.join(__dirname, '.backup-snapshot.db');

// ---------- минимальный tar (ustar), только обычные файлы — без внешних зависимостей ----------

function tarHeader(name, size, mtimeMs) {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, 'utf8');
  buf.write('0000644\0', 100, 8, 'utf8');
  buf.write('0000000\0', 108, 8, 'utf8');
  buf.write('0000000\0', 116, 8, 'utf8');
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  buf.write(Math.floor(mtimeMs / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'utf8');
  buf.write('        ', 148, 8, 'utf8'); // чек-сумма — временно пробелы, как того требует формат
  buf.write('0', 156, 1, 'utf8'); // typeflag: обычный файл
  buf.write('ustar', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return buf;
}

function tarEntry(name, content, mtimeMs) {
  const header = tarHeader(name, content.length, mtimeMs);
  const padLen = (512 - (content.length % 512)) % 512;
  return Buffer.concat([header, content, Buffer.alloc(padLen)]);
}

function parseTar(buffer) {
  const files = {};
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break; // два нулевых блока — конец архива
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    offset += 512;
    files[name] = Buffer.from(buffer.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

// ---------- бэкап ----------

// создаёт .tar.gz со всеми данными бота: БД (players/games/results) + файлы состояния
// (активные столы и заявки на подтверждение). Секреты (.env — токен бота и т.п.) сознательно
// не включаются: архив может уйти в телеграм-канал, куда токену попадать нельзя
async function createBackupArchive() {
  if (fs.existsSync(TMP_SNAPSHOT_PATH)) fs.unlinkSync(TMP_SNAPSHOT_PATH);
  await backupDatabaseTo(TMP_SNAPSHOT_PATH);

  const now = Date.now();
  const dbBuf = fs.readFileSync(TMP_SNAPSHOT_PATH);
  fs.unlinkSync(TMP_SNAPSHOT_PATH);
  const gamesBuf = fs.existsSync(GAMES_FILE) ? fs.readFileSync(GAMES_FILE) : Buffer.from('{}');
  const approvalsBuf = fs.existsSync(APPROVALS_FILE) ? fs.readFileSync(APPROVALS_FILE) : Buffer.from('{}');

  const tarBuffer = Buffer.concat([
    tarEntry('poker.db', dbBuf, now),
    tarEntry('active_games.json', gamesBuf, now),
    tarEntry('pending_approvals.json', approvalsBuf, now),
    Buffer.alloc(1024) // два нулевых 512-байтных блока — конец архива
  ]);
  const gz = zlib.gzipSync(tarBuffer);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(__dirname, `poker-backup-${stamp}.tar.gz`);
  fs.writeFileSync(outPath, gz);
  return outPath;
}

// ---------- восстановление ----------

// проверяет, что архив похож на настоящий бэкап (валидный gzip+tar, есть poker.db с корректной
// сигнатурой SQLite), не трогая ничего на диске — чтобы отсеять случайный/повреждённый файл
// до того, как показывать админу подтверждение перезаписи
function inspectBackupArchive(buffer) {
  let tarBuffer;
  try {
    tarBuffer = zlib.gunzipSync(buffer);
  } catch (e) {
    return { ok: false, error: 'Это не gzip-архив (или он повреждён).' };
  }
  const files = parseTar(tarBuffer);
  if (!files['poker.db']) return { ok: false, error: 'В архиве нет poker.db — это не бэкап бота.' };
  const magic = files['poker.db'].subarray(0, 16).toString('utf8');
  if (magic !== 'SQLite format 3\0') return { ok: false, error: 'poker.db в архиве повреждён (не похож на SQLite-файл).' };
  return { ok: true, files };
}

// заменяет БД и файлы состояния содержимым архива. Требует перезапуска процесса сразу после —
// открытый в этом процессе better-sqlite3 handle всё ещё смотрит на старый файл, и WAL от старой
// БД не должен наложиться на новую, поэтому закрываем БД и чистим -wal/-shm перед подменой
function applyBackupArchive(files) {
  closeDatabase();
  ['poker.db-wal', 'poker.db-shm'].forEach(suffix => {
    const p = path.join(__dirname, suffix);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  fs.writeFileSync(DB_PATH, files['poker.db']);
  fs.writeFileSync(GAMES_FILE, files['active_games.json'] || Buffer.from('{}'));
  fs.writeFileSync(APPROVALS_FILE, files['pending_approvals.json'] || Buffer.from('{}'));
}

module.exports = { createBackupArchive, inspectBackupArchive, applyBackupArchive };
