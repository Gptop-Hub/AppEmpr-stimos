// backend/utils/paths.js
const fs = require('fs');
const path = require('path');

const APP_DIR_ASCII  = 'App Emprestimos';
const APP_DIR_ACCENT = 'App Empréstimos'; // ✅ acento correto

function stripDiacritics(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Normaliza segmentos tipo "App Empréstimos" -> "App Emprestimos"
function sanitizePath(p) {
  if (!p) return p;
  const root  = path.parse(p).root;
  const parts = p.slice(root.length).split(/[\\/]+/).filter(Boolean);

  const fixed = parts.map(seg => {
    const ascii = stripDiacritics(seg).trim();

    // Se o segmento (sem acento) for igual ao nome ASCII esperado, força para ASCII
    if (ascii.toLowerCase() === APP_DIR_ASCII.toLowerCase()) return APP_DIR_ASCII;

    // Se o segmento for exatamente o com acento correto, troca para ASCII também
    if (seg.trim().toLowerCase() === APP_DIR_ACCENT.toLowerCase()) return APP_DIR_ASCII;

    return seg;
  });

  return root ? path.join(root, ...fixed) : path.join(...fixed);
}

function ensureDirSync(dir) {
  if (!dir) throw new Error('[paths] ensureDirSync called without dir');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let _computed = false;
let _appDataDir, _dataDir, _backupsDir, _uploadsDir, _clientPhotosDir, _logsDir;

function migrateLegacy(appDataDir) {
  const parent = path.dirname(appDataDir);
  const legacy = path.join(parent, APP_DIR_ACCENT); // pasta antiga com acento correto

  if (!fs.existsSync(legacy)) return;

  const legacyData = path.join(legacy, 'emprestimos-data');
  const legacyDb   = path.join(legacyData, 'database.db');

  const targetData = ensureDirSync(path.join(appDataDir, 'emprestimos-data'));
  const targetDb   = path.join(targetData, 'database.db');

  if (fs.existsSync(targetDb)) {
    console.warn('[paths] MigraÃ§Ã£o legado ignorada: target jÃ¡ existe:', targetDb);
    return;
  }

  if (fs.existsSync(legacyDb)) {
    try {
      fs.copyFileSync(legacyDb, targetDb);
      console.info('[paths] Migrou banco da pasta com acento:', legacyDb, '->', targetDb);
    } catch (e) {
      console.warn('[paths] Falha ao migrar legado:', e.message);
    }
  }
}

function compute() {
  if (_computed) return;

  let appData = (process.env.APP_DATA_DIR || '').trim();

  if (!appData) {
    // DEV: usa ./backend/models/data
    _appDataDir = ensureDirSync(path.join(__dirname, '..', 'models', 'data'));
    _dataDir    = _appDataDir;
  } else {
    appData = sanitizePath(appData);
    if (appData !== process.env.APP_DATA_DIR) process.env.APP_DATA_DIR = appData;

    _appDataDir = ensureDirSync(appData);
    migrateLegacy(_appDataDir);
    _dataDir    = ensureDirSync(path.join(_appDataDir, 'emprestimos-data'));
  }

  _backupsDir = ensureDirSync(path.join(_dataDir, 'backups'));
  _uploadsDir = ensureDirSync(path.join(_dataDir, 'uploads'));
  _clientPhotosDir = ensureDirSync(path.join(_uploadsDir, 'client-photos'));
  _logsDir    = ensureDirSync(path.join(_appDataDir, 'logs'));

  console.info('[paths] db dir =', _dataDir);
  console.info('[paths] backups dir =', _backupsDir);

  _computed = true;
}

function getAppDataDir(){ compute(); return _appDataDir; }
function getDataDir(){ compute(); return _dataDir; }
function getDbPath(){ compute(); return path.join(_dataDir, 'database.db'); }
function getSecurityDbPath(){ compute(); return path.join(_dataDir, 'seguranca.db'); }
function getBackupsDir(){ compute(); return _backupsDir; }
function getUploadsDir(){ compute(); return _uploadsDir; }
function getClientPhotosDir(){ compute(); return _clientPhotosDir; }
function getLogsDir(){ compute(); return _logsDir; }

module.exports = {
  sanitizePath, ensureDirSync,
  getAppDataDir, getDataDir, getDbPath, getSecurityDbPath,
  getBackupsDir, getUploadsDir, getClientPhotosDir, getLogsDir,
};
