const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3').verbose();

const {
  BUNDLE_MAGIC,
  createBackupBundle,
  extractBackupBundle,
  inspectBackupFile,
  sha256File,
} = require('../services/backupBundleService');

function openDb(filePath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, (error) => error ? reject(error) : resolve(db));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => error ? reject(error) : resolve());
  });
}

function closeDb(db) {
  return new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
}

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-fotos-'));
  const dbPath = path.join(directory, 'database.db');
  const photosDir = path.join(directory, 'client-photos');
  fs.mkdirSync(photosDir);
  const names = [
    'cliente-1-11111111-1111-4111-8111-111111111111.jpg',
    'cliente-2-22222222-2222-4222-8222-222222222222.png',
  ];
  const contents = [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6])];
  for (let index = 0; index < names.length; index += 1) {
    fs.writeFileSync(path.join(photosDir, names[index]), contents[index]);
  }
  const db = await openDb(dbPath);
  await run(db, 'CREATE TABLE clientes(id INTEGER PRIMARY KEY, nome TEXT, foto_cliente TEXT)');
  await run(db, 'CREATE TABLE emprestimos(id INTEGER PRIMARY KEY, cliente_id INTEGER)');
  await run(db, 'INSERT INTO clientes VALUES(1, ?, ?)', ['Cliente 1', names[0]]);
  await run(db, 'INSERT INTO clientes VALUES(2, ?, ?)', ['Cliente 2', names[1]]);
  await closeDb(db);
  return {
    directory, dbPath, photosDir, names, contents,
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

test('pacote completo preserva banco e fotos byte a byte', async () => {
  const data = await fixture();
  try {
    const bundlePath = path.join(data.directory, 'completo.emprestimos-backup');
    const result = await createBackupBundle({
      dbPath: data.dbPath,
      clientPhotosDir: data.photosDir,
      outputPath: bundlePath,
      referencedPhotoNames: [...data.names].reverse(),
      createdAt: '2026-09-15T12:00:00.000Z',
    });
    assert.equal(result.photoCount, 2);
    assert.equal(result.sha256, await sha256File(bundlePath));
    const inspection = await inspectBackupFile(bundlePath);
    assert.equal(inspection.type, 'bundle');
    assert.equal(inspection.manifest.version, 2);
    assert.deepEqual(
      inspection.manifest.files.map((entry) => entry.path),
      ['database.db', `photos/${data.names[0]}`, `photos/${data.names[1]}`]
    );

    const extraction = path.join(data.directory, 'extraido');
    const extracted = await extractBackupBundle({ backupPath: bundlePath, destinationDir: extraction });
    assert.equal(await sha256File(extracted.dbPath), await sha256File(data.dbPath));
    for (let index = 0; index < data.names.length; index += 1) {
      assert.deepEqual(
        fs.readFileSync(path.join(extracted.photosDir, data.names[index])),
        data.contents[index]
      );
    }
  } finally {
    data.cleanup();
  }
});

test('foto ausente não bloqueia backup: preserva banco e fotos disponíveis', async () => {
  const data = await fixture();
  try {
    fs.unlinkSync(path.join(data.photosDir, data.names[1]));
    const output = path.join(data.directory, 'incompleto.emprestimos-backup');
    const result = await createBackupBundle({
      dbPath: data.dbPath,
      clientPhotosDir: data.photosDir,
      outputPath: output,
      referencedPhotoNames: data.names,
    });
    assert.equal(result.photoCount, 1);
    const inspected = await inspectBackupFile(output);
    assert.equal(inspected.manifest.photoCount, 1);
    const extracted = await extractBackupBundle({ backupPath: output, destinationDir: path.join(data.directory, 'parcial-extraido') });
    assert.equal(await sha256File(extracted.dbPath), await sha256File(data.dbPath));
    assert.deepEqual(fs.readFileSync(path.join(extracted.photosDir, data.names[0])), data.contents[0]);
    assert.equal(fs.existsSync(path.join(extracted.photosDir, data.names[1])), false);
  } finally {
    data.cleanup();
  }
});

test('restauracao rejeita pacote corrompido e caminho malicioso', async () => {
  const data = await fixture();
  try {
    const bundlePath = path.join(data.directory, 'corrompido.emprestimos-backup');
    await createBackupBundle({
      dbPath: data.dbPath,
      clientPhotosDir: data.photosDir,
      outputPath: bundlePath,
      referencedPhotoNames: data.names,
    });
    const bytes = fs.readFileSync(bundlePath);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(bundlePath, bytes);
    const extraction = path.join(data.directory, 'nao-deve-sobrar');
    await assert.rejects(
      extractBackupBundle({ backupPath: bundlePath, destinationDir: extraction }),
      { code: 'BACKUP_HASH_MISMATCH' }
    );
    assert.equal(fs.existsSync(extraction), false);

    const maliciousPath = path.join(data.directory, 'malicioso.emprestimos-backup');
    const manifest = {
      format: 'app-emprestimos-backup', version: 2, database: 'database.db',
      photosDirectory: 'photos', photoCount: 1,
      files: [
        { path: 'database.db', size: 0, sha256: crypto.createHash('sha256').update('').digest('hex') },
        { path: 'photos/../fora.jpg', size: 0, sha256: crypto.createHash('sha256').update('').digest('hex') },
      ],
    };
    const header = Buffer.from(JSON.stringify(manifest));
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(header.length));
    fs.writeFileSync(maliciousPath, Buffer.concat([BUNDLE_MAGIC, length, header]));
    await assert.rejects(inspectBackupFile(maliciousPath), { code: 'INVALID_BACKUP_ENTRY' });
  } finally {
    data.cleanup();
  }
});

test('arquivo SQLite antigo continua sendo reconhecido', async () => {
  const data = await fixture();
  try {
    const inspection = await inspectBackupFile(data.dbPath);
    assert.equal(inspection.type, 'legacy-sqlite');
  } finally {
    data.cleanup();
  }
});
