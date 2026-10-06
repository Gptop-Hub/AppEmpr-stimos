const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { incrementPatch } = require('./bump-version-before-publish');

const NOTES_FILE = path.join('build', 'desktop-release-notes.md');
const PUBLISHED_NOTES_FILE = path.join('build', '.desktop-release-notes-published.json');
const SOURCE_MARKER = 'desktop-release-source';

const SNAPSHOT_EXCLUDED_FILES = new Set([
  'build/desktop-release-notes.md',
  'build/.desktop-release-notes-published.json',
]);

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function normalizeNotesBody(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function releaseNotesFingerprint(body) {
  return crypto.createHash('sha256').update(normalizeNotesBody(body)).digest('hex');
}

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function isReleaseSourceFile(relativePath) {
  const file = normalizeRelativePath(relativePath);
  if (!file || SNAPSHOT_EXCLUDED_FILES.has(file)) return false;
  return !/^(?:node_modules|frontend\/node_modules|frontend\/dist|dist_electron|\.git)\//.test(file);
}

function gitOutput(projectRoot, args) {
  const result = childProcess.spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '');
}

function gitChangedSourceFiles(projectRoot) {
  const changed = gitOutput(projectRoot, ['diff', '--name-only', '--diff-filter=ACDMRT', 'HEAD']);
  const untracked = gitOutput(projectRoot, ['ls-files', '--others', '--exclude-standard']);
  if (changed == null || untracked == null) return null;
  return [...new Set(`${changed}\n${untracked}`.split(/\r?\n/)
    .map(normalizeRelativePath)
    .filter(isReleaseSourceFile))].sort();
}

function currentSourceSnapshot(projectRoot) {
  const filesOutput = gitOutput(projectRoot, ['ls-files', '--cached', '--others', '--exclude-standard']);
  if (filesOutput == null) return null;
  const files = filesOutput.split(/\r?\n/)
    .map(normalizeRelativePath)
    .filter(isReleaseSourceFile)
    .sort();
  const snapshot = {};
  for (const file of files) {
    const absolutePath = path.join(projectRoot, file);
    try {
      if (fs.statSync(absolutePath).isFile()) {
        snapshot[file] = crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
      }
    } catch {
      // Arquivos removidos durante a leitura nao devem impedir a publicacao.
    }
  }
  return snapshot;
}

function changedFilesFromSnapshot(previousSnapshot, nextSnapshot) {
  const previous = previousSnapshot && typeof previousSnapshot === 'object' ? previousSnapshot : {};
  const next = nextSnapshot && typeof nextSnapshot === 'object' ? nextSnapshot : {};
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((file) => previous[file] !== next[file])
    .sort();
}

function sourceFingerprint(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot || {})).digest('hex');
}

function legacyReleaseAreasForFiles(files) {
  const areas = new Set();
  const joined = files.join('\n').toLowerCase();
  if (/(emprestimo|parcelas|pagamento|renegoci|vencimento)/.test(joined)) {
    areas.add('Correções e melhorias em empréstimos, parcelas e pagamentos.');
  }
  if (/(caixa|fluxocaixa|fluxo-caixa)/.test(joined)) {
    areas.add('Ajustes no Fluxo de Caixa.');
  }
  if (/(cliente|clientes)/.test(joined)) {
    areas.add('Melhorias no cadastro e no acompanhamento de clientes.');
  }
  if (/(backup|mobile|atualizac|update|main\.js|preload\.js)/.test(joined)) {
    areas.add('Aprimoramentos em backup, sincronização e atualizações do aplicativo.');
  }
  if (files.some((file) => file.startsWith('frontend/'))) {
    areas.add('Melhorias na interface e na usabilidade do aplicativo.');
  }
  if (!areas.size) areas.add('Correções internas de estabilidade e manutenção.');
  return [...areas];
}

function changeContext(projectRoot, files) {
  return files.map((file) => {
    try {
      return `${file}\n${fs.readFileSync(path.join(projectRoot, file), 'utf8').slice(0, 120000)}`;
    } catch {
      return file;
    }
  }).join('\n').toLowerCase();
}

function hasFile(files, pattern) {
  return files.some((file) => pattern.test(normalizeRelativePath(file)));
}

// Public notes are emitted only when paths, code or tests identify a concrete effect.
function specificReleaseItems(files, context = '') {
  const items = [];
  const add = (id, priority, text, matches) => {
    if (matches && !items.some((item) => item.id === id)) items.push({ id, priority, text });
  };
  const file = (pattern) => hasFile(files, pattern);
  const text = (pattern) => pattern.test(context);

  add('parcelas-arredondamento', 10,
    'Corrigido o cálculo de parcelas para concentrar os centavos de arredondamento na última parcela.',
    file(/(?:^|\/)gerarparcelas(?:simulacao)?\.(?:js|jsx)$/i) && (text(/reconciliarcapital|arredondamento|ultima parcela/) || file(/gerarparcelas\.test\.js$/i)));
  add('caixa-data-emprestimo', 20,
    'Corrigida a saída do empréstimo no Fluxo de Caixa para usar a data contratual.',
    file(/emprestimocaixadata\.test\.js$/i) || (file(/emprestimoscontroller\.js$/i) && text(/registrarsaidaemprestimo/)));
  add('recalculo-atraso', 30,
    'Ajustado o recálculo de atraso para registrar juros pendentes e deslocar apenas o cronograma aberto.',
    file(/recalculoatraso/i) && text(/vencimento.*juros_pendentes|juros_pendentes.*vencimento/));

  add('busca-pagamento-cliente-id', 40,
    'Corrigida a busca por ID do cliente na tela de Pagamentos para mostrar todos os empréstimos ativos.',
    file(/pagamentobuscautils(?:\.test)?\.js$/i) || text(/filtraremprestimosparapagamento/));
  add('juros-parcial-vencimento', 45,
    'Corrigido o reagendamento após pagamento parcial de juros para usar a data escolhida como âncora das próximas parcelas.',
    file(/pagamentojurosparcial(?:\.test)?\.js$/i) && text(/proximovencimento|próximo vencimento/));

  add('reagendamento-vencimento', 50,
    'Reorganizada a alteração de vencimentos: a prévia mostra o resultado antes de confirmar e protege parcelas com pagamento registrado.',
    file(/reagendarvencimentomodal\.jsx$/i) || file(/reagendamentoparcelasservice\.js$/i));
  add('total-pago-detalhes', 55,
    'O Total pago na aba Quitados agora permite abrir a composição dos pagamentos.',
    file(/detalhestotalpago/i) || text(/loan-total-paid-btn|detalhestotalpago/));

  add('fluxo-caixa-periodo', 60,
    'Corrigido o filtro do Fluxo de Caixa para aplicar os períodos Hoje, Semana, Mês, Ano e personalizado corretamente.',
    file(/fluxocaixacompleto\.jsx$/i) && text(/periodocaixa|periodo personalizado|periodo: 'dia'/));
  add('backup-celular', 70,
    'Adicionada a exportação de backup para celular com escolha segura do local para salvar o arquivo.',
    file(/mobilebackup/i) || text(/mobile-backup\/save|emprestimos-para-celular/));

  add('atualizacao-silenciosa', 80,
    'Melhorado o instalador de atualização para preparar atualizações silenciosas em instalações por usuário.',
    file(/updateinstallsafety/i) || text(/getwindowsupdateinstalldecision|runupdateinstallplan/));
  add('historico-novidades', 90,
    'A tela Novidades agora exibe a versão instalada e o histórico de atualizações disponíveis.',
    file(/atualizacoesdata(?:\.test)?\.js$/i) && text(/historyreleases|updates\/history/));
  add('notas-especificas', 100,
    'As Novidades do aplicativo agora são geradas a partir das mudanças reais da versão.',
    file(/scripts\/desktop-release-notes(?:\.test)?\.js$/i));

  return items.sort((a, b) => a.priority - b.priority || a.text.localeCompare(b.text)).map((item) => item.text);
}

function automaticReleaseNotes({ projectRoot, published }) {
  const snapshot = currentSourceSnapshot(projectRoot);
  if (!snapshot) return null;

  const changedFiles = published && published.sourceSnapshot
    ? changedFilesFromSnapshot(published.sourceSnapshot, snapshot)
    : gitChangedSourceFiles(projectRoot);
  if (!changedFiles || changedFiles.length === 0) return null;

  const items = specificReleaseItems(changedFiles, changeContext(projectRoot, changedFiles));
  if (!items.length) return { body: null, changedFiles, sourceSnapshot: snapshot };

  const marker = sourceFingerprint(Object.fromEntries(changedFiles.map((file) => [file, snapshot[file] || null])));
  const body = [
    '## Novidades',
    '',
    ...items.map((item) => `- ${item}`),
    '',
    `<!-- ${SOURCE_MARKER}: ${marker} -->`,
  ].join('\n');
  return { body, changedFiles, sourceSnapshot: snapshot };
}

function renderDesktopReleaseNotes({ version, body }) {
  const normalizedVersion = normalizeVersion(version);
  return `<!-- desktop-release-version: ${normalizedVersion} -->\n## Versão ${normalizedVersion}\n\n${normalizeNotesBody(body)}\n`;
}

function publishedNotesPath(projectRoot) {
  return path.join(projectRoot, PUBLISHED_NOTES_FILE);
}

function readPublishedReleaseNotes(projectRoot = path.resolve(__dirname, '..')) {
  const statePath = publishedNotesPath(projectRoot);
  if (!fs.existsSync(statePath)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!state || typeof state !== 'object' || !/^[a-f0-9]{64}$/i.test(String(state.fingerprint || ''))) {
      throw new Error('invalid state');
    }
    return {
      version: normalizeVersion(state.version),
      fingerprint: state.fingerprint,
      publishedAt: state.publishedAt || null,
      sourceSnapshot: state.sourceSnapshot && typeof state.sourceSnapshot === 'object' ? state.sourceSnapshot : null,
    };
  } catch {
    throw new Error(`O registro de novidades publicadas é inválido: ${PUBLISHED_NOTES_FILE}. Corrija ou remova o arquivo antes de publicar.`);
  }
}

function assertReleaseNotesNotReused({ projectRoot = path.resolve(__dirname, '..'), body }) {
  const published = readPublishedReleaseNotes(projectRoot);
  if (published && published.fingerprint === releaseNotesFingerprint(body)) {
    throw new Error(
      `As novidades atuais já foram publicadas na versão ${published.version}. Escreva novidades novas em ${NOTES_FILE} antes de publicar.`
    );
  }
}

function recordPublishedReleaseNotes({ projectRoot = path.resolve(__dirname, '..'), version, body, publishedAt = new Date().toISOString(), sourceSnapshot = currentSourceSnapshot(projectRoot) }) {
  const statePath = publishedNotesPath(projectRoot);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify({
    version: normalizeVersion(version),
    fingerprint: releaseNotesFingerprint(body),
    publishedAt,
    ...(sourceSnapshot ? { sourceSnapshot } : {}),
  }, null, 2)}\n`, 'utf8');
}

function readDesktopReleaseNotes(projectRoot = path.resolve(__dirname, '..')) {
  const notesPath = path.join(projectRoot, NOTES_FILE);
  if (!fs.existsSync(notesPath)) {
    throw new Error(`Arquivo de novidades não encontrado: ${NOTES_FILE}`);
  }

  const body = normalizeNotesBody(fs.readFileSync(notesPath, 'utf8'));
  if (!body || body.length < 12) {
    throw new Error('Informe novidades públicas antes de publicar.');
  }
  return { body, notesPath };
}

function validateDesktopReleaseNotes({ projectRoot = path.resolve(__dirname, '..'), expectedVersion } = {}) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const published = readPublishedReleaseNotes(projectRoot);
  const detected = automaticReleaseNotes({ projectRoot, published });
  if (detected && !detected.body) {
    throw new Error('As mudanças detectadas não possuem informação suficiente para gerar novidades específicas. Adicione contexto em código/testes ou escreva uma nota pública concreta.');
  }
  const notes = detected
    ? { body: detected.body, notesPath: path.join(projectRoot, NOTES_FILE), sourceSnapshot: detected.sourceSnapshot, changedFiles: detected.changedFiles }
    : readDesktopReleaseNotes(projectRoot);
  const version = normalizeVersion(expectedVersion || packageJson.version);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Versão de publicação inválida: ${expectedVersion || packageJson.version}`);
  }
  return { ...notes, version, markdown: renderDesktopReleaseNotes({ version, body: notes.body }) };
}

function prepareDesktopReleaseNotesForPublish(notes) {
  const original = fs.readFileSync(notes.notesPath, 'utf8');
  fs.writeFileSync(notes.notesPath, notes.markdown, 'utf8');
  return () => fs.writeFileSync(notes.notesPath, original, 'utf8');
}

if (require.main === module) {
  const projectRoot = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const expectedVersion = process.argv.includes('--check-next')
    ? incrementPatch(packageJson.version)
    : packageJson.version;
  const notes = validateDesktopReleaseNotes({ projectRoot, expectedVersion });
  assertReleaseNotesNotReused({ projectRoot, body: notes.body });
  console.log(`[release-notes] Novidades para a versão ${notes.version} validadas.`);
}

module.exports = {
  NOTES_FILE,
  PUBLISHED_NOTES_FILE,
  normalizeVersion,
  normalizeNotesBody,
  releaseNotesFingerprint,
  currentSourceSnapshot,
  changedFilesFromSnapshot,
  automaticReleaseNotes,
  specificReleaseItems,
  renderDesktopReleaseNotes,
  readDesktopReleaseNotes,
  validateDesktopReleaseNotes,
  prepareDesktopReleaseNotesForPublish,
  readPublishedReleaseNotes,
  assertReleaseNotesNotReused,
  recordPublishedReleaseNotes,
};
