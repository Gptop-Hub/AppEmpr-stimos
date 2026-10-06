const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const fsp = fs.promises;
const OVERWRITE_CHUNK_SIZE = 1024 * 1024;

function escapeIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function allAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function execAsync(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function passwordMatches(provided, expected) {
  const providedDigest = crypto.createHash('sha256').update(String(provided || '')).digest();
  const expectedDigest = crypto.createHash('sha256').update(String(expected || '')).digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

function buildPurgeSql(tableNames) {
  const deleteStatements = tableNames.map(
    (tableName) => `DELETE FROM ${escapeIdentifier(tableName)};`
  );

  return [
    'PRAGMA secure_delete = ON;',
    'PRAGMA foreign_keys = OFF;',
    'BEGIN IMMEDIATE TRANSACTION;',
    ...deleteStatements,
    'DELETE FROM sqlite_sequence;',
    'COMMIT;',
    'PRAGMA foreign_keys = ON;',
    'PRAGMA wal_checkpoint(TRUNCATE);',
    'VACUUM;',
    'PRAGMA wal_checkpoint(TRUNCATE);',
  ].join('\n');
}

async function purgeDatabase(db) {
  const rows = await allAsync(
    db,
    `SELECT name
       FROM sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        -- A identidade desta instalacao nao e historico financeiro. Mantem-se
        -- para que um reset de dados nao reutilize sequencias deste dispositivo.
        AND name <> 'action_origin_state'
      ORDER BY name`
  );
  const tableNames = rows.map((row) => row && row.name).filter(Boolean);

  try {
    await execAsync(db, buildPurgeSql(tableNames));
  } catch (error) {
    try {
      await execAsync(db, 'ROLLBACK; PRAGMA foreign_keys = ON;');
    } catch (_) {}
    throw error;
  }

  return tableNames;
}

async function overwriteAndRemoveFile(filePath) {
  let handle;
  try {
    const stat = await fsp.stat(filePath);
    handle = await fsp.open(filePath, 'r+');
    const zeroes = Buffer.alloc(Math.min(OVERWRITE_CHUNK_SIZE, Math.max(1, stat.size)));
    let offset = 0;

    while (offset < stat.size) {
      const bytesToWrite = Math.min(zeroes.length, stat.size - offset);
      await handle.write(zeroes, 0, bytesToWrite, offset);
      offset += bytesToWrite;
    }

    await handle.sync();
  } finally {
    if (handle) await handle.close().catch(() => {});
  }

  await fsp.unlink(filePath);
}

async function removeEntrySecurely(entryPath, preservedPaths, failures) {
  const resolvedPath = path.resolve(entryPath);
  if (preservedPaths.has(resolvedPath)) return;

  let stat;
  try {
    stat = await fsp.lstat(entryPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    failures.push({ path: resolvedPath, error: error.message || String(error) });
    return;
  }

  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    const children = await fsp.readdir(entryPath).catch((error) => {
      failures.push({ path: resolvedPath, error: error.message || String(error) });
      return [];
    });
    for (const child of children) {
      await removeEntrySecurely(path.join(entryPath, child), preservedPaths, failures);
    }
    await fsp.rmdir(entryPath).catch((error) => {
      if (error && error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') {
        failures.push({ path: resolvedPath, error: error.message || String(error) });
      }
    });
    return;
  }

  try {
    if (stat.isFile()) await overwriteAndRemoveFile(entryPath);
    else await fsp.unlink(entryPath);
  } catch (error) {
    failures.push({ path: resolvedPath, error: error.message || String(error) });
  }
}

async function cleanDirectoryContents(directory, preservedPaths, failures) {
  const children = await fsp.readdir(directory).catch((error) => {
    if (error && error.code !== 'ENOENT') {
      failures.push({ path: path.resolve(directory), error: error.message || String(error) });
    }
    return [];
  });

  for (const child of children) {
    await removeEntrySecurely(path.join(directory, child), preservedPaths, failures);
  }
}

async function purgeStoredFiles(pathsApi) {
  const dbPath = path.resolve(pathsApi.getDbPath());
  const dataDir = path.resolve(pathsApi.getDataDir());
  const logsDir = path.resolve(pathsApi.getLogsDir());
  const backupsDir = path.resolve(pathsApi.getBackupsDir());
  const uploadsDir = path.resolve(pathsApi.getUploadsDir());
  const preservedPaths = new Set([dbPath, `${dbPath}-wal`, `${dbPath}-shm`]);
  // Configurações de acesso não são dados financeiros e não devem voltar à senha legada.
  const securityDbPath = path.resolve(pathsApi.getSecurityDbPath ? pathsApi.getSecurityDbPath() : path.join(dataDir, 'seguranca.db'));
  for (const suffix of ['', '-wal', '-shm', '-journal']) preservedPaths.add(`${securityDbPath}${suffix}`);
  const failures = [];

  await cleanDirectoryContents(dataDir, preservedPaths, failures);
  if (logsDir !== dataDir && !logsDir.startsWith(`${dataDir}${path.sep}`)) {
    await cleanDirectoryContents(logsDir, preservedPaths, failures);
  }

  await Promise.all([
    fsp.mkdir(backupsDir, { recursive: true }),
    fsp.mkdir(uploadsDir, { recursive: true }),
    fsp.mkdir(logsDir, { recursive: true }),
  ]);

  if (failures.length) {
    const error = new Error(
      'Os dados do banco foram apagados, mas alguns arquivos internos nao puderam ser removidos.'
    );
    error.code = 'PURGE_FILES_INCOMPLETE';
    error.failures = failures;
    throw error;
  }
}

async function purgeAllSystemData({ database, pathsApi }) {
  const db = database.getConnection ? database.getConnection() : database;
  const tables = await purgeDatabase(db);
  await purgeStoredFiles(pathsApi);
  return { tablesCleared: tables.length };
}

module.exports = {
  buildPurgeSql,
  passwordMatches,
  purgeAllSystemData,
  purgeDatabase,
  purgeStoredFiles,
};
