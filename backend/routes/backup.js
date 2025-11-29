// backend/routes/backup.js
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');

const database = require('../models/database');
const paths = require('../utils/paths');

const router = express.Router();
const log = (...args) => console.info('[backup]', ...args);

// Diretórios (graváveis)
const uploadsDir = paths.getUploadsDir();
const backupsDir = paths.getBackupsDir();

log(`Active SQLite path: ${paths.getDbPath()}`);
log(`Backups directory: ${backupsDir}`);
log(`Uploads directory: ${uploadsDir}`);

// ---------- Multer (uploads fora do asar) ----------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const extension = path.extname(file.originalname || '') || '.db';
    cb(null, `restore-${timestamp}${extension}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ---------- Chave opcional ----------
function verificarBackupKey(req, res, next) {
  const key = process.env.BACKUP_KEY;
  if (!key) return next();
  const provided = req.headers['x-backup-key'];
  if (!provided || provided !== key) {
    return res.status(401).json({ success: false, error: 'Backup key is invalid.' });
  }
  next();
}

// ---------- Utils ----------
async function sha1File(p) {
  const h = crypto.createHash('sha1');
  const s = fs.createReadStream(p);
  return new Promise((resolve, reject) => {
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

async function statsFile(p) {
  const st = await fsp.stat(p);
  return { size: st.size, mtime: st.mtime.toISOString() };
}

// WAL helpers
function runSql(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

async function walCheckpointTruncate() {
  const db = database.getConnection ? database.getConnection() : database;
  try {
    await runSql(db, 'PRAGMA foreign_keys=ON;');
    await runSql(db, 'PRAGMA wal_checkpoint(TRUNCATE);');
    log('WAL checkpoint (TRUNCATE) realizado.');
  } catch (e) {
    log('Falha no WAL checkpoint:', e.message);
  }
}

async function removeWalShm(dbPath) {
  const wal = dbPath + '-wal';
  const shm = dbPath + '-shm';
  await fsp.unlink(wal).catch(() => {});
  await fsp.unlink(shm).catch(() => {});
  log('Removidos arquivos WAL/SHM (se existiam).');
}

// ---------- SNAPSHOT ----------
router.get('/snapshot', async (_req, res) => {
  const source = paths.getDbPath();
  if (!fs.existsSync(source)) {
    return res.status(404).json({ success: false, error: 'Database file not found.' });
  }
  try {
    await walCheckpointTruncate(); // garante .db atualizado
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(backupsDir, `snapshot-${timestamp}.db`);
    await fsp.copyFile(source, destination);
    log(`Snapshot created: ${source} -> ${destination}`);
    return res.json({ success: true, path: destination });
  } catch (err) {
    log(`Snapshot error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Failed to create snapshot.' });
  }
});

// ---------- DOWNLOAD ----------
router.get('/download', verificarBackupKey, async (_req, res) => {
  const source = paths.getDbPath();
  if (!fs.existsSync(source)) {
    return res.status(404).json({ success: false, error: 'Database file not found.' });
  }
  try {
    await walCheckpointTruncate(); // garante .db atualizado
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tempCopy = path.join(backupsDir, `download-${timestamp}.db`);
    await fsp.copyFile(source, tempCopy);

    const filename = process.env.BACKUP_FILENAME || `emprestimos-backup-${timestamp}.db`;
    log(`Download requested: ${source} -> ${tempCopy} (as ${filename})`);
    res.download(tempCopy, filename, (err) => {
      if (err) log(`Download error: ${err.message}`);
    });
  } catch (err) {
    log(`Download error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Failed to generate backup.' });
  }
});

// ---------- REABRIR CONEXÃO (opcional/manual) ----------
router.post('/reopen', async (_req, res) => {
  try {
    await database.reopenConnection();
    return res.json({ success: true, message: 'SQLite connection reopened.' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

// ---------- ESTADO ATUAL (debug) ----------
router.get('/now', async (_req, res) => {
  try {
    const dbPath = paths.getDbPath();
    const info = fs.existsSync(dbPath) ? await statsFile(dbPath) : null;

    const db = database.getConnection ? database.getConnection() : database;

    const queryOne = (sql) =>
      new Promise((resolve) => {
        db.get(sql, (err, row) => {
          if (err) return resolve(-1);
          const val = row && Object.values(row)[0];
          resolve(typeof val === 'number' ? val : -1);
        });
      });

    const [qClientes, qEmprestimos, qParcelas, qPagamentos] = await Promise.all([
      queryOne('SELECT COUNT(*) AS n FROM clientes'),
      queryOne('SELECT COUNT(*) AS n FROM emprestimos'),
      queryOne('SELECT COUNT(*) AS n FROM parcelas'),
      queryOne('SELECT COUNT(*) AS n FROM pagamentos'),
    ]);

    return res.json({
      success: true,
      dbPath,
      file: info,
      contagens: {
        clientes: qClientes,
        emprestimos: qEmprestimos,
        parcelas: qParcelas,
        pagamentos: qPagamentos,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

// ---------- RESTORE (upload) ----------
async function handleRestore(req, res) {
  if (!req.file) return res.status(400).json({ success: false, error: 'Arquivo para restore ausente (file).' });

  const uploadedPath = req.file.path;
  let connectionClosed = false;
  let backupPath = null;

  try {
    // valida header SQLite
    const fd = await fsp.open(uploadedPath, 'r');
    try {
      const buf = Buffer.alloc(16);
      await fd.read(buf, 0, 16, 0);
      if (buf.toString('utf8', 0, 15) !== 'SQLite format 3') {
        throw Object.assign(new Error('uploaded file is not a SQLite database'), { code: 'INVALID_SQLITE' });
      }
    } finally {
      await fd.close();
    }

    const targetPath = paths.getDbPath();
    const activePath = typeof database.getDbPath === 'function' ? database.getDbPath() : targetPath;

    if (path.resolve(targetPath) !== path.resolve(activePath)) {
      const message = `Restore aborted: target ${targetPath} differs from active ${activePath}`;
      log(message);
      return res.status(409).json({ success: false, error: message });
    }

    // backup do atual
    if (fs.existsSync(targetPath)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = path.join(backupsDir, `before-restore-${ts}.db`);
      await fsp.copyFile(targetPath, backupPath);
      log(`Backup before restore: ${targetPath} -> ${backupPath}`);
    }

    // fecha → limpa WAL/SHM → copia → reabre
    await database.closeConnection();
    connectionClosed = true;
    log('SQLite connection closed for restore.');

    await removeWalShm(targetPath);
    await fsp.copyFile(uploadedPath, targetPath);
    await removeWalShm(targetPath);

    log(`Restore copy completed: ${uploadedPath} -> ${targetPath}`);

    await database.reopenConnection();
    connectionClosed = false;
    log('SQLite connection reopened after restore.');

    // hashes/stats de verificação
    const upHash = await sha1File(uploadedPath);
    const tgHash = await sha1File(targetPath);
    const upStat = await statsFile(uploadedPath);
    const tgStat = await statsFile(targetPath);

    // remove upload temporário
    await fsp.unlink(uploadedPath).catch(() => {});

    return res.json({
      success: true,
      message: 'Banco restaurado com sucesso.',
      dbPath: targetPath,
      backupOfPreviousDb: backupPath,
      uploaded: { path: req.file.originalname, size: upStat.size, sha1: upHash },
      target: { size: tgStat.size, sha1: tgHash },
    });
  } catch (err) {
    log(`Restore error: ${err.message}`);
    if (connectionClosed) {
      try {
        await database.reopenConnection();
        log('SQLite connection reopened after error.');
      } catch (reopenErr) {
        log(`Failed to reopen SQLite after error: ${reopenErr.message}`);
      }
    }
    await fsp.unlink(uploadedPath).catch(() => {});
    if (err.code === 'INVALID_SQLITE') {
      return res.status(400).json({ success: false, error: 'Arquivo enviado nao e um banco SQLite valido.' });
    }
    return res.status(500).json({ success: false, error: 'Erro ao restaurar backup.' });
  }
}

// Monta a rota com pipeline exportável
const restoreMiddlewares = [verificarBackupKey, upload.single('file'), handleRestore];
router.post('/restore', ...restoreMiddlewares);

// Exports
module.exports = router;
module.exports.restoreMiddlewares = restoreMiddlewares;