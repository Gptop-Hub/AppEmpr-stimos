// backend/routes/backup.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');

/**
 * Diretórios graváveis
 * - Em produção (empacotado): usamos APP_DATA_DIR (ex.: %APPDATA%\app-emprestimos)
 * - Em dev: fallback para backend/models/data
 */
const APP_DATA_DIR = (process.env.APP_DATA_DIR && process.env.APP_DATA_DIR.trim())
  ? process.env.APP_DATA_DIR
  : path.join(__dirname, '..', 'models', 'data'); // fallback dev

const dataDir    = path.join(APP_DATA_DIR, 'emprestimos-data');
const uploadsDir = path.join(dataDir, 'uploads');
const backupsDir = path.join(dataDir, 'backups');
try { fs.mkdirSync(dataDir,    { recursive: true }); } catch {}
try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch {}
try { fs.mkdirSync(backupsDir, { recursive: true }); } catch {}

// Caminho do banco real (mesma lógica do database.js)
const DB_FILE_PATH = path.join(dataDir, 'database.db');

// Middleware opcional de verificação de chave
function verificarBackupKey(req, res, next) {
  const key = process.env.BACKUP_KEY;
  if (!key) return next(); // aberto se não tiver chave
  const provided = req.headers['x-backup-key'];
  if (!provided || provided !== key) {
    return res.status(401).json({ erro: 'Chave de backup inválida' });
  }
  next();
}

// Multer SEMPRE em diretório gravável fora do asar
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(file.originalname || '') || '.db';
    cb(null, `restore-upload-${ts}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB

/* ------------------- SNAPSHOT (usado no auto-update) ------------------- */
router.get('/snapshot', (req, res) => {
  try {
    if (!fs.existsSync(DB_FILE_PATH)) {
      return res.status(404).json({ success: false, error: 'DB não encontrado' });
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupsDir, `snapshot-${ts}.db`);
    fs.copyFileSync(DB_FILE_PATH, dest);
    return res.json({ success: true, path: dest });
  } catch (e) {
    console.error('snapshot error:', e);
    return res.status(500).json({ success: false, error: String(e) });
  }
});

/* ------------------- DOWNLOAD ------------------- */
router.get('/download', verificarBackupKey, (req, res) => {
  try {
    if (!fs.existsSync(DB_FILE_PATH)) {
      return res.status(404).json({ erro: 'Arquivo de banco não encontrado.' });
    }
    // copia para tmp dentro de backups
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const tmpPath = path.join(backupsDir, `backup-${ts}.db`);
    fs.copyFileSync(DB_FILE_PATH, tmpPath);
    const filename = process.env.BACKUP_FILENAME || `meu-banco-backup-${ts}.db`;
    res.download(tmpPath, filename, err => {
      // mantemos uma cópia no backups/ como histórico
      if (err) console.error('Erro ao enviar backup:', err);
    });
  } catch (err) {
    console.error('Erro gerando backup:', err);
    return res.status(500).json({ erro: 'Erro no servidor ao gerar backup' });
  }
});

/* ------------------- RESTORE (upload) ------------------- */
router.post('/restore', verificarBackupKey, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado (campo "file")' });
    const uploadedPath = req.file.path;

    // validação mínima: header SQLite
    const fd = fs.openSync(uploadedPath, 'r');
    const headerBuf = Buffer.alloc(16);
    fs.readSync(fd, headerBuf, 0, 16, 0);
    fs.closeSync(fd);
    if (headerBuf.toString('utf8', 0, 15) !== 'SQLite format 3') {
      fs.unlink(uploadedPath, () => {});
      return res.status(400).json({ erro: 'Arquivo não parece ser um banco SQLite válido.' });
    }

    // cria backup do DB atual
    const now = new Date().toISOString().replace(/[:.]/g, '-');
    const backupCurrentPath = path.join(backupsDir, `before-restore-${now}.db`);
    if (fs.existsSync(DB_FILE_PATH)) {
      fs.copyFileSync(DB_FILE_PATH, backupCurrentPath);
    }

    // substitui o DB
    fs.copyFileSync(uploadedPath, DB_FILE_PATH);
    fs.unlink(uploadedPath, () => {});

    return res.json({
      success: true,
      message: 'Arquivo enviado e substituiu o banco. (Reinicie o app para garantir reabertura do SQLite.)',
      backup_of_previous_db: backupCurrentPath
    });
  } catch (err) {
    console.error('Erro no restore:', err);
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    return res.status(500).json({ erro: 'Erro ao restaurar backup no servidor.' });
  }
});

/* ------------------- DEBUG OPCIONAL ------------------- */
router.get('/info', (req, res) => {
  res.json({
    APP_DATA_DIR,
    dataDir,
    uploadsDir,
    backupsDir,
    DB_FILE_PATH,
    exists: fs.existsSync(DB_FILE_PATH)
  });
});

module.exports = router;