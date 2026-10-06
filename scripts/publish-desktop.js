const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');
const { bumpVersionBeforePublish, incrementPatch } = require('./bump-version-before-publish');
const {
  normalizeVersion,
  validateDesktopReleaseNotes,
  prepareDesktopReleaseNotesForPublish,
  assertReleaseNotesNotReused,
  recordPublishedReleaseNotes,
} = require('./desktop-release-notes');

const projectRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(projectRoot, 'package.json');
const GITHUB_OWNER = 'Gptop-Hub';
const GITHUB_REPOSITORY = 'app-emprestimos';

function readPackageVersion() {
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} terminou com código ${result.status}.`);
}

function resolveNpmCli() {
  const cliFromNpm = String(process.env.npm_execpath || '').trim();
  if (cliFromNpm && fs.existsSync(cliFromNpm)) return cliFromNpm;

  const bundledCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(bundledCli)) {
    throw new Error('Nao foi possivel localizar o executavel do npm para preparar a publicacao.');
  }
  return bundledCli;
}

function resolveElectronBuilderCli() {
  const cli = path.join(projectRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  if (!fs.existsSync(cli)) {
    throw new Error('electron-builder nao esta instalado. Execute npm install antes de publicar.');
  }
  return cli;
}

function githubRequest({ token, method, requestPath, body }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const request = https.request({
      hostname: 'api.github.com',
      path: requestPath,
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'app-emprestimos-release-publisher',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub respondeu com status ${response.statusCode} ao atualizar as notas da release.`));
          return;
        }
        try { resolve(text ? JSON.parse(text) : null); } catch { resolve(null); }
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function publishGitHubReleaseNotes({ version, body, token }) {
  const releases = await githubRequest({
    token,
    method: 'GET',
    requestPath: `/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases?per_page=100`,
  });
  const release = Array.isArray(releases) && releases.find(
    (item) => normalizeVersion(item && item.tag_name) === normalizeVersion(version)
  );
  if (!release || !release.id) {
    throw new Error(`A release ${version} não foi encontrada no GitHub após a publicação.`);
  }
  await githubRequest({
    token,
    method: 'PATCH',
    requestPath: `/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases/${release.id}`,
    body: { body },
  });
}

async function main() {
  const currentVersion = readPackageVersion();
  const nextVersion = incrementPatch(currentVersion);
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN ou GITHUB_TOKEN é necessário para publicar a release desktop.');

  const notes = validateDesktopReleaseNotes({ projectRoot, expectedVersion: nextVersion });
  assertReleaseNotesNotReused({ projectRoot, body: notes.body });
  const restoreReleaseNotes = prepareDesktopReleaseNotesForPublish(notes);
  try {
    bumpVersionBeforePublish(projectRoot);
    run(process.execPath, [resolveNpmCli(), 'run', 'build:renderer']);
    run(process.execPath, [resolveElectronBuilderCli(), '--windows', '--publish', 'always']);
    await publishGitHubReleaseNotes({ version: nextVersion, body: notes.markdown, token });
    recordPublishedReleaseNotes({ projectRoot, version: nextVersion, body: notes.body });
  } finally {
    restoreReleaseNotes();
  }
  console.log(`[publish:win] Release ${nextVersion} publicada com as novidades configuradas.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[publish:win] ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  resolveNpmCli,
  resolveElectronBuilderCli,
};
