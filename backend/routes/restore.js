const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// Base gravável
const APP_DATA_DIR = (process.env.APP_DATA_DIR && process.env.APP_DATA_DIR.trim())
  ? process.env.APP_DATA_DIR
  : path.join(__dirname, '..', 'models', 'data'); // fallback dev

const dataDir     = path.join(APP_DATA_DIR, 'emprestimos-data');
const uploadsDir  = path.join(dataDir, 'uploads');
const backupsDir  = path.join(dataDir, 'backups');
try { fs.mkdirSync(dataDir,    { recursive: true }); } catch {}
try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch {}
try { fs.mkdirSync(backupsDir, { recursive: true }); } catch {}

const DB_FILE_PATH = path.join(dataDir, 'database.db');

function verificarBackupKey(req, res, next) {
  const key = process.env.BACKUP_KEY;
  if (!key) return next();
  const provided = req.headers['x-backup-key'];
  if (!provided || provided !== key) {
    return res.status(401).json({ erro: 'Chave de backup inválida' });
  }
  next();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `restore-${ts}-${file.originalname || 'database.db'}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

router.post('/', verificarBackupKey, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado (campo "file").' });

    const uploadedPath = req.file.path;

    // valida SQLite
    const fd = fs.openSync(uploadedPath, 'r');
    const headerBuf = Buffer.alloc(16);
    fs.readSync(fd, headerBuf, 0, 16, 0);
    fs.closeSync(fd);
    if (headerBuf.toString('utf8', 0, 15) !== 'SQLite format 3') {
      fs.unlink(uploadedPath, () => {});
      return res.status(400).json({ erro: 'Arquivo não parece ser um banco SQLite válido.' });
    }

    // backup do atual
    const now = new Date().toISOString().replace(/[:.]/g, '-');
    const backupCurrentPath = path.join(backupsDir, `before-restore-${now}.db`);
    if (fs.existsSync(DB_FILE_PATH)) {
      fs.copyFileSync(DB_FILE_PATH, backupCurrentPath);
    }

    // substitui
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

module.exports = router;