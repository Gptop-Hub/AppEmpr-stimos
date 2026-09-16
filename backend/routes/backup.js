const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const database = require('../models/database');
const paths = require('../utils/paths');
const {
  createBackupBundle,
  extractBackupBundle,
  inspectBackupFile,
  normalizePhotoNames,
  sha256File,
} = require('../services/backupBundleService');

const router = express.Router();
const log = (...args) => console.info('[backup]', ...args);
const uploadsDir = paths.getUploadsDir();
const clientPhotosDir = paths.getClientPhotosDir();
const backupsDir = paths.getBackupsDir();

log(`Active SQLite path: ${paths.getDbPath()}`);
log(`Backups directory: ${backupsDir}`);
log(`Uploads directory: ${uploadsDir}`);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const extension = path.extname(file.originalname || '') || '.backup';
    cb(null, `restore-${timestamp}-${crypto.randomUUID()}${extension}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024, files: 1 } });

function verificarBackupKey(req, res, next) {
  const key = process.env.BACKUP_KEY;
  if (!key) return next();
  const provided = req.headers['x-backup-key'];
  if (!provided || provided !== key) {
    return res.status(401).json({ success: false, error: 'Backup key is invalid.' });
  }
  next();
}

function runSql(db, sql) {
  return new Promise((resolve, reject) => db.run(sql, (err) => (err ? reject(err) : resolve())));
}

function allSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function walCheckpointTruncate() {
  const db = database.getConnection ? database.getConnection() : database;
  await runSql(db, 'PRAGMA foreign_keys=ON;');
  await runSql(db, 'PRAGMA wal_checkpoint(TRUNCATE);');
  log('WAL checkpoint (TRUNCATE) realizado.');
}

async function removeWalShm(dbPath) {
  await fsp.unlink(dbPath + '-wal').catch(() => {});
  await fsp.unlink(dbPath + '-shm').catch(() => {});
}

async function referencedPhotoNames(dbHandle = null) {
  const db = dbHandle || (database.getConnection ? database.getConnection() : database);
  const rows = await allSql(
    db,
    `SELECT DISTINCT TRIM(foto_cliente) AS foto_cliente
       FROM clientes
      WHERE foto_cliente IS NOT NULL
        AND TRIM(foto_cliente) != ''
      ORDER BY foto_cliente ASC`
  );
  return normalizePhotoNames(rows.map((row) => row.foto_cliente));
}

async function createActiveBackup(destination) {
  await walCheckpointTruncate();
  const photos = await referencedPhotoNames();
  return createBackupBundle({
    dbPath: paths.getDbPath(),
    clientPhotosDir,
    outputPath: destination,
    referencedPhotoNames: photos,
  });
}

async function openReadOnly(filePath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (error) => {
      if (error) reject(error);
      else resolve(db);
    });
  });
}

function closeDb(db) {
  return new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())));
}

async function validateExtractedDatabase(extracted) {
  const db = await openReadOnly(extracted.dbPath);
  try {
    const rows = await allSql(
      db,
      `SELECT DISTINCT TRIM(foto_cliente) AS foto_cliente
         FROM clientes
        WHERE foto_cliente IS NOT NULL
          AND TRIM(foto_cliente) != ''
        ORDER BY foto_cliente ASC`
    );
    const databasePhotos = normalizePhotoNames(rows.map((row) => row.foto_cliente));
    const restoredPhotos = normalizePhotoNames(
      fs.existsSync(extracted.photosDir) ? await fsp.readdir(extracted.photosDir) : []
    );
    // Aceitar referências sem arquivo, mas continuar rejeitando imagens alheias ao cadastro.
    if (restoredPhotos.some((name) => !databasePhotos.includes(name))) {
      const error = new Error('As fotos do pacote nao correspondem aos clientes do banco.');
      error.code = 'BACKUP_PHOTO_SET_MISMATCH';
      throw error;
    }
    const integrity = await allSql(db, 'PRAGMA integrity_check');
    if (!integrity.length || integrity.some((row) => String(Object.values(row)[0]).toLowerCase() !== 'ok')) {
      const error = new Error('O banco do pacote nao passou na verificacao de integridade.');
      error.code = 'INVALID_SQLITE';
      throw error;
    }
  } finally {
    await closeDb(db);
  }
}

async function validateLegacyDatabase(filePath) {
  const db = await openReadOnly(filePath);
  try {
    const integrity = await allSql(db, 'PRAGMA integrity_check');
    if (!integrity.length || integrity.some((row) => String(Object.values(row)[0]).toLowerCase() !== 'ok')) {
      const error = new Error('O banco selecionado nao passou na verificacao de integridade.');
      error.code = 'INVALID_SQLITE';
      throw error;
    }
    const tables = await allSql(
      db,
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('clientes','emprestimos')"
    );
    if (tables.length !== 2) {
      const error = new Error('O arquivo nao possui a estrutura esperada do sistema.');
      error.code = 'INVALID_SQLITE';
      throw error;
    }
  } finally {
    await closeDb(db);
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupErrorResponse(res, error, fallback) {
  log(`${fallback}: ${error && error.message}`);
  const clientErrors = new Set([
    'INVALID_BACKUP_FORMAT',
    'INVALID_BACKUP_MANIFEST',
    'INVALID_BACKUP_ENTRY',
    'DUPLICATE_BACKUP_ENTRY',
    'BACKUP_TRUNCATED',
    'BACKUP_SIZE_MISMATCH',
    'BACKUP_HASH_MISMATCH',
    'BACKUP_PHOTO_SET_MISMATCH',
    'INVALID_SQLITE',
    'BACKUP_TOO_LARGE',
  ]);
  const status = error && error.code === 'BACKUP_PHOTOS_MISSING'
    ? 409
    : error && error.code === 'BACKUP_SOURCE_CHANGED'
      ? 409
    : clientErrors.has(error && error.code)
      ? 400
      : 500;
  return res.status(status).json({
    success: false,
    error: error && error.message ? error.message : fallback,
    code: error && error.code ? error.code : 'BACKUP_ERROR',
  });
}

router.get('/snapshot', async (_req, res) => {
  const source = paths.getDbPath();
  if (!fs.existsSync(source)) {
    return res.status(404).json({ success: false, error: 'Database file not found.' });
  }
  try {
    const destination = path.join(backupsDir, `snapshot-${timestamp()}.emprestimos-backup`);
    const result = await createActiveBackup(destination);
    log(`Snapshot completo criado: ${destination} (${result.photoCount} foto(s))`);
    return res.json({
      success: true,
      path: destination,
      photoCount: result.photoCount,
      size: result.size,
      sha256: result.sha256,
      formatVersion: 2,
    });
  } catch (error) {
    return backupErrorResponse(res, error, 'Falha ao criar snapshot completo.');
  }
});

router.get('/download', verificarBackupKey, async (_req, res) => {
  const source = paths.getDbPath();
  if (!fs.existsSync(source)) {
    return res.status(404).json({ success: false, error: 'Database file not found.' });
  }
  const destination = path.join(backupsDir, `download-${timestamp()}-${crypto.randomUUID()}.emprestimos-backup`);
  try {
    const result = await createActiveBackup(destination);
    const configuredName = String(process.env.BACKUP_FILENAME || '').trim();
    const filenameBase = configuredName || `emprestimos-backup-${timestamp()}`;
    const filename = filenameBase.toLowerCase().endsWith('.emprestimos-backup')
      ? filenameBase
      : `${filenameBase}.emprestimos-backup`;
    log(`Download completo solicitado: ${destination} (${result.photoCount} foto(s))`);
    res.set('X-Backup-Format-Version', '2');
    res.set('X-Backup-Photo-Count', String(result.photoCount));
    return res.download(destination, filename, async (error) => {
      if (error) log(`Download error: ${error.message}`);
      await fsp.unlink(destination).catch(() => {});
    });
  } catch (error) {
    await fsp.unlink(destination).catch(() => {});
    return backupErrorResponse(res, error, 'Falha ao gerar backup completo.');
  }
});

router.post('/reopen', async (_req, res) => {
  try {
    await database.reopenConnection();
    return res.json({ success: true, message: 'SQLite connection reopened.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

router.get('/now', async (_req, res) => {
  try {
    const dbPath = paths.getDbPath();
    const stats = fs.existsSync(dbPath) ? await fsp.stat(dbPath) : null;
    const db = database.getConnection ? database.getConnection() : database;
    const count = async (table) => {
      const rows = await allSql(db, `SELECT COUNT(*) AS total FROM ${table}`);
      return Number(rows[0] && rows[0].total || 0);
    };
    const [clientes, emprestimos, parcelas, pagamentos, photos] = await Promise.all([
      count('clientes'), count('emprestimos'), count('parcelas'), count('pagamentos'), referencedPhotoNames(db),
    ]);
    return res.json({
      success: true,
      dbPath,
      file: stats ? { size: stats.size, mtime: stats.mtime.toISOString() } : null,
      contagens: { clientes, emprestimos, parcelas, pagamentos, fotos: photos.length },
      backupFormatVersion: 2,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

async function restoreLegacyDatabase(uploadedPath, targetPath) {
  const rollbackDb = path.join(path.dirname(targetPath), `.restore-previous-${crypto.randomUUID()}.db`);
  const targetExisted = fs.existsSync(targetPath);
  await database.closeConnection();
  let reopened = false;
  try {
    await removeWalShm(targetPath);
    if (targetExisted) await fsp.copyFile(targetPath, rollbackDb);
    await fsp.copyFile(uploadedPath, targetPath);
    await removeWalShm(targetPath);
    await database.reopenConnection();
    reopened = true;
  } catch (error) {
    await database.closeConnection().catch(() => {});
    await removeWalShm(targetPath);
    if (targetExisted && fs.existsSync(rollbackDb)) await fsp.copyFile(rollbackDb, targetPath);
    else if (!targetExisted) await fsp.unlink(targetPath).catch(() => {});
    await database.reopenConnection().catch(() => {});
    reopened = true;
    throw error;
  } finally {
    if (!reopened) await database.reopenConnection().catch(() => {});
    await fsp.unlink(rollbackDb).catch(() => {});
  }
}

async function restoreBundleState({ extracted, targetPath, stagingDir }) {
  const rollbackDb = path.join(uploadsDir, `.restore-previous-${crypto.randomUUID()}.db`);
  const rollbackPhotos = path.join(uploadsDir, `.restore-previous-photos-${crypto.randomUUID()}`);
  const targetExisted = fs.existsSync(targetPath);
  let oldPhotosMoved = false;
  let newPhotosInstalled = false;
  let connectionClosed = false;

  await fsp.mkdir(extracted.photosDir, { recursive: true });
  try {
    await database.closeConnection();
    connectionClosed = true;
    await removeWalShm(targetPath);
    if (targetExisted) await fsp.copyFile(targetPath, rollbackDb);
    if (fs.existsSync(clientPhotosDir)) {
      await fsp.rename(clientPhotosDir, rollbackPhotos);
      oldPhotosMoved = true;
    }
    await fsp.rename(extracted.photosDir, clientPhotosDir);
    newPhotosInstalled = true;
    await fsp.copyFile(extracted.dbPath, targetPath);
    await removeWalShm(targetPath);
    await database.reopenConnection();
    connectionClosed = false;
  } catch (error) {
    if (!connectionClosed) {
      await database.closeConnection().catch(() => {});
      connectionClosed = true;
    }
    await removeWalShm(targetPath);
    if (targetExisted && fs.existsSync(rollbackDb)) await fsp.copyFile(rollbackDb, targetPath);
    else if (!targetExisted) await fsp.unlink(targetPath).catch(() => {});
    if (newPhotosInstalled) await fsp.rm(clientPhotosDir, { recursive: true, force: true }).catch(() => {});
    if (oldPhotosMoved && fs.existsSync(rollbackPhotos)) await fsp.rename(rollbackPhotos, clientPhotosDir);
    else await fsp.mkdir(clientPhotosDir, { recursive: true });
    await database.reopenConnection().catch(() => {});
    connectionClosed = false;
    throw error;
  } finally {
    if (connectionClosed) await database.reopenConnection().catch(() => {});
    await fsp.unlink(rollbackDb).catch(() => {});
    await fsp.rm(rollbackPhotos, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleRestore(req, res) {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Arquivo para restaurar ausente.' });
  }
  const uploadedPath = req.file.path;
  const stagingDir = path.join(uploadsDir, `.restore-staging-${crypto.randomUUID()}`);
  let previousBackupPath = null;

  try {
    const targetPath = paths.getDbPath();
    const activePath = typeof database.getDbPath === 'function' ? database.getDbPath() : targetPath;
    if (path.resolve(targetPath) !== path.resolve(activePath)) {
      const error = new Error('O banco ativo nao corresponde ao destino da restauracao.');
      error.code = 'ACTIVE_DB_PATH_MISMATCH';
      throw error;
    }

    const inspection = await inspectBackupFile(uploadedPath);
    let extracted = null;
    if (inspection.type === 'bundle') {
      extracted = await extractBackupBundle({ backupPath: uploadedPath, destinationDir: stagingDir });
      await validateExtractedDatabase(extracted);
    } else {
      await validateLegacyDatabase(uploadedPath);
    }

    if (fs.existsSync(targetPath)) {
      previousBackupPath = path.join(backupsDir, `before-restore-${timestamp()}.emprestimos-backup`);
      await createActiveBackup(previousBackupPath);
    }

    if (inspection.type === 'bundle') {
      await restoreBundleState({ extracted, targetPath, stagingDir });
    } else {
      await restoreLegacyDatabase(uploadedPath, targetPath);
    }

    const response = {
      success: true,
      message: inspection.type === 'bundle'
        ? `Backup restaurado com ${extracted.photoCount} foto(s).`
        : 'Backup antigo restaurado. Esse formato nao contem fotos.',
      dbPath: targetPath,
      backupOfPreviousState: previousBackupPath,
      uploaded: {
        name: req.file.originalname,
        size: req.file.size,
        sha256: await sha256File(uploadedPath),
      },
      target: {
        size: (await fsp.stat(targetPath)).size,
        sha256: await sha256File(targetPath),
      },
      formatVersion: inspection.type === 'bundle' ? 2 : 1,
      photosRestored: inspection.type === 'bundle' ? extracted.photoCount : 0,
      legacyWithoutPhotos: inspection.type === 'legacy-sqlite',
    };
    await fsp.unlink(uploadedPath).catch(() => {});
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    return res.json(response);
  } catch (error) {
    await fsp.unlink(uploadedPath).catch(() => {});
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    return backupErrorResponse(res, error, 'Erro ao restaurar backup.');
  }
}

const restoreMiddlewares = [verificarBackupKey, upload.single('file'), handleRestore];
router.post('/restore', ...restoreMiddlewares);

module.exports = router;
module.exports.restoreMiddlewares = restoreMiddlewares;
module.exports.__test = {
  referencedPhotoNames,
  validateExtractedDatabase,
  validateLegacyDatabase,
};
