const fs = require('fs');
const path = require('path');

function incrementPatch(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/);
  if (!match) {
    throw new Error(`Versão inválida no package.json: ${version}`);
  }

  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function bumpVersionBeforePublish(projectRoot = path.resolve(__dirname, '..')) {
  const packagePath = path.join(projectRoot, 'package.json');
  const lockPath = path.join(projectRoot, 'package-lock.json');
  const packageJson = readJson(packagePath);
  const nextVersion = incrementPatch(packageJson.version);

  packageJson.version = nextVersion;
  writeJson(packagePath, packageJson);

  if (fs.existsSync(lockPath)) {
    const lock = readJson(lockPath);
    lock.version = nextVersion;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = nextVersion;
    }
    writeJson(lockPath, lock);
  }

  return nextVersion;
}

if (require.main === module) {
  const previousVersion = readJson(path.resolve(__dirname, '..', 'package.json')).version;
  const nextVersion = bumpVersionBeforePublish();
  console.log(`[publish:win] Versão atualizada: ${previousVersion} → ${nextVersion}`);
}

module.exports = {
  incrementPatch,
  bumpVersionBeforePublish,
};
