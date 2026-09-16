const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();

const {
  passwordMatches,
  purgeDatabase,
  purgeStoredFiles,
} = require('../services/systemPurgeService');

function execSql(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => (error ? reject(error) : resolve()));
  });
}

function getSql(db, sql) {
  return new Promise((resolve, reject) => {
    db.get(sql, (error, row) => (error ? reject(error) : resolve(row)));
  });
}

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

test('passwordMatches compares the complete password', () => {
  assert.equal(passwordMatches('1otimodia', '1otimodia'), true);
  assert.equal(passwordMatches('1otimodia ', '1otimodia'), false);
  assert.equal(passwordMatches('', '1otimodia'), false);
});

test('purgeDatabase clears every user table and compacts SQLite', async () => {
  let executedSql = '';
  const db = {
    all(_sql, _params, callback) {
      callback(null, [{ name: 'clientes' }, { name: 'table"quoted' }]);
    },
    exec(sql, callback) {
      executedSql = sql;
      callback(null);
    },
  };

  const tables = await purgeDatabase(db);

  assert.deepEqual(tables, ['clientes', 'table"quoted']);
  assert.match(executedSql, /PRAGMA secure_delete = ON/);
  assert.match(executedSql, /DELETE FROM "clientes"/);
  assert.match(executedSql, /DELETE FROM "table""quoted"/);
  assert.match(executedSql, /DELETE FROM sqlite_sequence/);
  assert.match(executedSql, /PRAGMA wal_checkpoint\(TRUNCATE\)/);
  assert.match(executedSql, /VACUUM/);
});

test('purgeDatabase empties a real temporary SQLite database', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'system-purge-sqlite-'));
  const dbPath = path.join(root, 'database.db');
  const db = new sqlite3.Database(dbPath);
  t.after(async () => {
    await closeDb(db).catch(() => {});
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  await execSql(
    db,
    `PRAGMA foreign_keys = ON;
     PRAGMA journal_mode = WAL;
     CREATE TABLE clientes (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       nome TEXT NOT NULL
     );
     CREATE TABLE emprestimos (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       cliente_id INTEGER NOT NULL,
       valor REAL NOT NULL,
       FOREIGN KEY (cliente_id) REFERENCES clientes(id)
     );
     INSERT INTO clientes (nome) VALUES ('Cliente confidencial');
     INSERT INTO emprestimos (cliente_id, valor) VALUES (1, 5000);`
  );

  const tables = await purgeDatabase(db);
  const clientes = await getSql(db, 'SELECT COUNT(*) AS total FROM clientes');
  const emprestimos = await getSql(db, 'SELECT COUNT(*) AS total FROM emprestimos');
  const sequences = await getSql(db, 'SELECT COUNT(*) AS total FROM sqlite_sequence');
  const integrity = await getSql(db, 'PRAGMA integrity_check');
  const secureDelete = await getSql(db, 'PRAGMA secure_delete');

  assert.deepEqual(tables, ['clientes', 'emprestimos']);
  assert.equal(clientes.total, 0);
  assert.equal(emprestimos.total, 0);
  assert.equal(sequences.total, 0);
  assert.equal(integrity.integrity_check, 'ok');
  assert.equal(secureDelete.secure_delete, 1);
});

test('purgeStoredFiles removes internal copies and preserves the active database', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'system-purge-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));

  const dataDir = path.join(root, 'data');
  const backupsDir = path.join(dataDir, 'backups');
  const uploadsDir = path.join(dataDir, 'uploads');
  const logsDir = path.join(root, 'logs');
  const dbPath = path.join(dataDir, 'database.db');

  await Promise.all([
    fs.promises.mkdir(backupsDir, { recursive: true }),
    fs.promises.mkdir(uploadsDir, { recursive: true }),
    fs.promises.mkdir(logsDir, { recursive: true }),
  ]);
  await Promise.all([
    fs.promises.writeFile(dbPath, 'active database'),
    fs.promises.writeFile(`${dbPath}-wal`, 'active wal'),
    fs.promises.writeFile(path.join(dataDir, 'seguranca.db'), 'security settings'),
    fs.promises.writeFile(path.join(dataDir, 'seguranca.db-journal'), 'security journal'),
    fs.promises.writeFile(path.join(backupsDir, 'snapshot.db'), 'customer data'),
    fs.promises.writeFile(path.join(uploadsDir, 'restore.db'), 'customer data'),
    fs.promises.writeFile(path.join(dataDir, 'notificacoes-config.json'), '{}'),
    fs.promises.writeFile(path.join(logsDir, 'backend.log'), 'sensitive log'),
  ]);

  await purgeStoredFiles({
    getDbPath: () => dbPath,
    getDataDir: () => dataDir,
    getBackupsDir: () => backupsDir,
    getUploadsDir: () => uploadsDir,
    getLogsDir: () => logsDir,
  });

  assert.equal(await fs.promises.readFile(dbPath, 'utf8'), 'active database');
  assert.equal(await fs.promises.readFile(`${dbPath}-wal`, 'utf8'), 'active wal');
  assert.equal(await fs.promises.readFile(path.join(dataDir, 'seguranca.db'), 'utf8'), 'security settings');
  assert.equal(await fs.promises.readFile(path.join(dataDir, 'seguranca.db-journal'), 'utf8'), 'security journal');
  assert.deepEqual(await fs.promises.readdir(backupsDir), []);
  assert.deepEqual(await fs.promises.readdir(uploadsDir), []);
  assert.deepEqual(await fs.promises.readdir(logsDir), []);
  await assert.rejects(fs.promises.access(path.join(dataDir, 'notificacoes-config.json')));
});
