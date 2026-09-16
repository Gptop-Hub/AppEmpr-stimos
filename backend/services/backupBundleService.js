const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const BUNDLE_MAGIC = Buffer.from('EMPRESTIMOS-BACKUP-V2\n', 'utf8');
const BUNDLE_FORMAT = 'app-emprestimos-backup';
const BUNDLE_VERSION = 2;
const MAX_HEADER_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 100000;
const MAX_RESTORE_BYTES = 1024 * 1024 * 1024;
const PHOTO_NAME_RE = /^cliente-\d+-[a-f0-9-]+\.(?:jpg|png|webp)$/i;

function backupError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details != null) error.details = details;
  return error;
}

function normalizePhotoNames(names = []) {
  const result = [];
  const seen = new Set();
  for (const raw of names || []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    if (!PHOTO_NAME_RE.test(name) || path.basename(name) !== name) {
      throw backupError('INVALID_PHOTO_REFERENCE', `Nome de foto invalido no cadastro: ${name}`);
    }
    const comparable = name.toLowerCase();
    if (seen.has(comparable)) continue;
    seen.add(comparable);
    result.push(name);
  }
  return result.sort((a, b) => a.localeCompare(b, 'en'));
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function describeFile(sourcePath, archivePath) {
  const stats = await fsp.stat(sourcePath);
  if (!stats.isFile()) throw backupError('BACKUP_SOURCE_NOT_FILE', `Arquivo ausente no backup: ${archivePath}`);
  return {
    path: archivePath,
    size: stats.size,
    sha256: await sha256File(sourcePath),
    sourcePath,
  };
}

async function appendFile(outputPath, sourcePath, expected) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    fs.createReadStream(sourcePath),
    meter,
    fs.createWriteStream(outputPath, { flags: 'a' })
  );
  const actualHash = hash.digest('hex');
  if (size !== expected.size || actualHash !== expected.sha256) {
    throw backupError(
      'BACKUP_SOURCE_CHANGED',
      `O arquivo ${expected.path} mudou durante o backup. Tente novamente.`
    );
  }
}

async function createBackupBundle({
  dbPath,
  clientPhotosDir,
  outputPath,
  referencedPhotoNames = [],
  createdAt = new Date().toISOString(),
}) {
  const photoNames = normalizePhotoNames(referencedPhotoNames);
  const files = [await describeFile(dbPath, 'database.db')];

  for (const name of photoNames) {
    const photoPath = path.join(clientPhotosDir, name);
    try {
      files.push(await describeFile(photoPath, `photos/${name}`));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        // Foto ausente não impede salvar o banco nem as outras imagens disponíveis.
        continue;
      }
      throw error;
    }
  }

  const manifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt,
    database: 'database.db',
    photosDirectory: 'photos',
    photoCount: files.length - 1,
    files: files.map(({ path: archivePath, size, sha256 }) => ({
      path: archivePath,
      size,
      sha256,
    })),
  };
  const header = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (header.length > MAX_HEADER_BYTES) {
    throw backupError('BACKUP_HEADER_TOO_LARGE', 'O indice do backup excedeu o limite permitido.');
  }

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${crypto.randomUUID()}`;
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(header.length));

  try {
    await fsp.writeFile(temporaryPath, Buffer.concat([BUNDLE_MAGIC, length, header]), { flag: 'wx' });
    for (const file of files) await appendFile(temporaryPath, file.sourcePath, file);
    await fsp.rename(temporaryPath, outputPath);
  } catch (error) {
    await fsp.unlink(temporaryPath).catch(() => {});
    throw error;
  }

  const stats = await fsp.stat(outputPath);
  return {
    path: outputPath,
    size: stats.size,
    sha256: await sha256File(outputPath),
    photoCount: manifest.photoCount,
    manifest,
  };
}

async function readExactly(fileHandle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await fileHandle.read(buffer, offset, length - offset, position + offset);
    if (!result.bytesRead) throw backupError('BACKUP_TRUNCATED', 'O arquivo de backup esta incompleto.');
    offset += result.bytesRead;
  }
  return buffer;
}

function validateManifest(manifest) {
  if (!manifest || manifest.format !== BUNDLE_FORMAT || manifest.version !== BUNDLE_VERSION) {
    throw backupError('INVALID_BACKUP_FORMAT', 'Formato ou versao do pacote de backup invalido.');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > MAX_FILES) {
    throw backupError('INVALID_BACKUP_MANIFEST', 'Lista de arquivos do backup invalida.');
  }
  if (manifest.database !== 'database.db' || manifest.photosDirectory !== 'photos') {
    throw backupError('INVALID_BACKUP_MANIFEST', 'Estrutura do backup invalida.');
  }

  const seen = new Set();
  let total = 0;
  let databaseCount = 0;
  for (const entry of manifest.files) {
    const archivePath = String(entry && entry.path || '');
    const size = Number(entry && entry.size);
    const sha256 = String(entry && entry.sha256 || '').toLowerCase();
    const isDatabase = archivePath === 'database.db';
    const isPhoto = archivePath.startsWith('photos/') && PHOTO_NAME_RE.test(archivePath.slice(7));
    if (!isDatabase && !isPhoto) {
      throw backupError('INVALID_BACKUP_ENTRY', `Arquivo nao permitido no backup: ${archivePath}`);
    }
    if (isPhoto && path.basename(archivePath) !== archivePath.slice(7)) {
      throw backupError('INVALID_BACKUP_ENTRY', 'Caminho de foto invalido no backup.');
    }
    if (!Number.isSafeInteger(size) || size < 0 || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw backupError('INVALID_BACKUP_ENTRY', `Dados invalidos para ${archivePath}.`);
    }
    const comparable = archivePath.toLowerCase();
    if (seen.has(comparable)) throw backupError('DUPLICATE_BACKUP_ENTRY', `Arquivo duplicado: ${archivePath}`);
    seen.add(comparable);
    total += size;
    if (!Number.isSafeInteger(total) || total > MAX_RESTORE_BYTES) {
      throw backupError('BACKUP_TOO_LARGE', 'O conteudo do backup excede o limite permitido.');
    }
    if (isDatabase) databaseCount += 1;
  }
  if (databaseCount !== 1) throw backupError('INVALID_BACKUP_MANIFEST', 'Banco de dados ausente no pacote.');
  const photoCount = manifest.files.filter((entry) => entry.path.startsWith('photos/')).length;
  if (Number(manifest.photoCount) !== photoCount) {
    throw backupError('INVALID_BACKUP_MANIFEST', 'Contagem de fotos do backup invalida.');
  }
  return total;
}

async function inspectBackupFile(backupPath) {
  const fileHandle = await fsp.open(backupPath, 'r');
  try {
    const stats = await fileHandle.stat();
    const prefixLength = Math.max(BUNDLE_MAGIC.length, 16);
    const prefix = await readExactly(fileHandle, Math.min(prefixLength, stats.size), 0);
    if (prefix.subarray(0, 15).toString('utf8') === 'SQLite format 3') {
      return { type: 'legacy-sqlite', size: stats.size };
    }
    if (stats.size < BUNDLE_MAGIC.length + 8 || !prefix.subarray(0, BUNDLE_MAGIC.length).equals(BUNDLE_MAGIC)) {
      throw backupError('INVALID_BACKUP_FORMAT', 'O arquivo selecionado nao e um backup valido.');
    }
    const lengthBuffer = await readExactly(fileHandle, 8, BUNDLE_MAGIC.length);
    const headerLengthBig = lengthBuffer.readBigUInt64BE();
    if (headerLengthBig > BigInt(MAX_HEADER_BYTES)) {
      throw backupError('BACKUP_HEADER_TOO_LARGE', 'O indice do backup excede o limite permitido.');
    }
    const headerLength = Number(headerLengthBig);
    const dataOffset = BUNDLE_MAGIC.length + 8 + headerLength;
    if (dataOffset > stats.size) throw backupError('BACKUP_TRUNCATED', 'O arquivo de backup esta incompleto.');
    const header = await readExactly(fileHandle, headerLength, BUNDLE_MAGIC.length + 8);
    let manifest;
    try {
      manifest = JSON.parse(header.toString('utf8'));
    } catch {
      throw backupError('INVALID_BACKUP_MANIFEST', 'O indice do backup nao pode ser lido.');
    }
    const dataLength = validateManifest(manifest);
    if (dataOffset + dataLength !== stats.size) {
      throw backupError('BACKUP_SIZE_MISMATCH', 'O tamanho do backup nao corresponde ao conteudo esperado.');
    }
    return { type: 'bundle', size: stats.size, dataOffset, manifest };
  } finally {
    await fileHandle.close();
  }
}

async function extractRange(sourcePath, outputPath, start, size) {
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  if (size === 0) {
    await fsp.writeFile(outputPath, Buffer.alloc(0));
    return;
  }
  await pipeline(
    fs.createReadStream(sourcePath, { start, end: start + size - 1 }),
    fs.createWriteStream(outputPath, { flags: 'wx' })
  );
}

async function extractBackupBundle({ backupPath, destinationDir }) {
  const inspection = await inspectBackupFile(backupPath);
  if (inspection.type !== 'bundle') {
    throw backupError('BACKUP_BUNDLE_REQUIRED', 'Este arquivo e um backup antigo sem fotos.');
  }
  await fsp.mkdir(destinationDir, { recursive: true });
  let offset = inspection.dataOffset;
  const extracted = [];
  try {
    for (const entry of inspection.manifest.files) {
      const outputPath = entry.path === 'database.db'
        ? path.join(destinationDir, 'database.db')
        : path.join(destinationDir, 'photos', entry.path.slice(7));
      await extractRange(backupPath, outputPath, offset, entry.size);
      const actualHash = await sha256File(outputPath);
      if (actualHash !== entry.sha256) {
        throw backupError('BACKUP_HASH_MISMATCH', `O arquivo ${entry.path} esta corrompido.`);
      }
      extracted.push(outputPath);
      offset += entry.size;
    }
    const dbPath = path.join(destinationDir, 'database.db');
    const dbHandle = await fsp.open(dbPath, 'r');
    try {
      const header = await readExactly(dbHandle, 16, 0);
      if (header.subarray(0, 15).toString('utf8') !== 'SQLite format 3') {
        throw backupError('INVALID_SQLITE', 'O banco dentro do pacote nao e valido.');
      }
    } finally {
      await dbHandle.close();
    }
    return {
      type: 'bundle',
      dbPath,
      photosDir: path.join(destinationDir, 'photos'),
      photoCount: inspection.manifest.photoCount,
      manifest: inspection.manifest,
    };
  } catch (error) {
    await fsp.rm(destinationDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  BUNDLE_MAGIC,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  PHOTO_NAME_RE,
  createBackupBundle,
  extractBackupBundle,
  inspectBackupFile,
  normalizePhotoNames,
  sha256File,
};
