const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ROOT_ALLOWED_FILES = new Set([
  'main.js',
  'preload.js',
  'package.json',
  'backend/package.json',
]);
const TEXT_FILE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.json',
  '.sql',
  '.md',
  '.txt',
  '.css',
  '.html',
  '.yml',
  '.yaml',
]);

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function makeRepoError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function getRepoRoot() {
  return REPO_ROOT;
}

function pathExists(absPath) {
  try {
    fs.accessSync(absPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isDeniedByPath(relPath) {
  const rel = toPosix(relPath).toLowerCase();
  if (!rel) return true;

  if (
    rel.startsWith('.git/') ||
    rel.includes('/.git/') ||
    rel.startsWith('node_modules/') ||
    rel.includes('/node_modules/') ||
    rel.startsWith('dist/') ||
    rel.includes('/dist/') ||
    rel.startsWith('frontend/dist/') ||
    rel.startsWith('logs/') ||
    rel.includes('/logs/') ||
    rel.startsWith('backups/') ||
    rel.includes('/backups/')
  ) {
    return true;
  }

  if (rel.startsWith('backend/models/data/')) return true;

  const fileName = rel.split('/').pop() || '';
  if (
    fileName === '.env' ||
    fileName.startsWith('.env.') ||
    fileName.endsWith('.db') ||
    fileName.endsWith('.sqlite') ||
    fileName.endsWith('.sqlite3') ||
    fileName.endsWith('.pem') ||
    fileName.endsWith('.key')
  ) {
    return true;
  }

  return false;
}

function isAllowedByScope(scope, relPath) {
  const rel = toPosix(relPath);
  const normalizedScope = String(scope || 'project').toLowerCase();
  if (normalizedScope === 'backend') {
    return rel === 'backend' || rel.startsWith('backend/');
  }
  if (normalizedScope === 'frontend') {
    return rel === 'frontend/src' || rel.startsWith('frontend/src/');
  }
  return (
    rel === 'backend' ||
    rel.startsWith('backend/') ||
    rel === 'frontend/src' ||
    rel.startsWith('frontend/src/') ||
    ROOT_ALLOWED_FILES.has(rel)
  );
}

function enforceScope(scope, relPath) {
  const rel = toPosix(relPath);
  if (!isAllowedByScope(scope, rel)) {
    throw makeRepoError(
      'ERR_SCOPE_NOT_ALLOWED',
      `Path fora do escopo permitido (${scope}): ${rel}`
    );
  }
  if (isDeniedByPath(rel)) {
    throw makeRepoError('ERR_PATH_DENIED', `Path bloqueado por seguranca: ${rel}`);
  }
}

function normalizeAndAssertSafePath(relPath, scope = 'project') {
  const input = String(relPath || '').trim();
  if (!input) {
    throw makeRepoError('ERR_PATH_INVALID', 'Path vazio.');
  }
  if (path.isAbsolute(input)) {
    throw makeRepoError('ERR_PATH_TRAVERSAL', 'Path absoluto nao permitido.');
  }

  const absPath = path.resolve(REPO_ROOT, input);
  const rel = toPosix(path.relative(REPO_ROOT, absPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw makeRepoError('ERR_PATH_TRAVERSAL', 'Path fora do repositorio.');
  }

  enforceScope(scope, rel);
  if (!pathExists(absPath)) {
    throw makeRepoError('ERR_NOT_FOUND', `Path nao encontrado: ${rel}`);
  }

  return {
    absPath,
    relPath: rel,
  };
}

function getScopeRoots(scope = 'project') {
  const normalizedScope = String(scope || 'project').toLowerCase();
  if (normalizedScope === 'backend') {
    return [path.join(REPO_ROOT, 'backend')].filter(pathExists);
  }
  if (normalizedScope === 'frontend') {
    return [path.join(REPO_ROOT, 'frontend', 'src')].filter(pathExists);
  }

  const roots = [
    path.join(REPO_ROOT, 'backend'),
    path.join(REPO_ROOT, 'frontend', 'src'),
    path.join(REPO_ROOT, 'main.js'),
    path.join(REPO_ROOT, 'preload.js'),
    path.join(REPO_ROOT, 'package.json'),
    path.join(REPO_ROOT, 'backend', 'package.json'),
  ];
  return roots.filter(pathExists);
}

function isTextFilePath(filePath) {
  const rel = toPosix(path.relative(REPO_ROOT, filePath));
  if (!rel || rel.startsWith('..')) return false;
  if (isDeniedByPath(rel)) return false;
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_FILE_EXTENSIONS.has(ext);
}

function redactSensitiveText(text) {
  let out = String(text || '');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_SECRET]');
  out = out.replace(
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    '[REDACTED_TOKEN]'
  );
  out = out.replace(
    /(\b(api[_-]?key|token|secret)\b\s*[:=]\s*)(['"]?)[^'" \n\r]+(\3)/gi,
    '$1$3[REDACTED]$4'
  );
  return out;
}

module.exports = {
  getRepoRoot,
  getScopeRoots,
  normalizeAndAssertSafePath,
  enforceScope,
  redactSensitiveText,
  isTextFilePath,
};
