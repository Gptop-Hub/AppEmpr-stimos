const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertReleaseNotesNotReused,
  currentSourceSnapshot,
  prepareDesktopReleaseNotesForPublish,
  recordPublishedReleaseNotes,
  specificReleaseItems,
  validateDesktopReleaseNotes,
} = require('./desktop-release-notes');

function git(projectRoot, args) {
  childProcess.execFileSync('git', args, { cwd: projectRoot, stdio: 'ignore' });
}

function fixture(version, body = '- Correção importante de estabilidade no aplicativo desktop.') {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-release-notes-'));
  fs.mkdirSync(path.join(projectRoot, 'build'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'package.json'), `${JSON.stringify({ version })}\n`);
  fs.writeFileSync(path.join(projectRoot, 'build', 'desktop-release-notes.md'), `${body}\n`);
  return { projectRoot, cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true }) };
}

test('injeta a versão alvo 0.6.21 sem marcador manual nas novidades', () => {
  const data = fixture('0.6.20');
  try {
    const notes = validateDesktopReleaseNotes({ projectRoot: data.projectRoot, expectedVersion: '0.6.21' });
    assert.equal(notes.version, '0.6.21');
    assert.match(notes.markdown, /^<!-- desktop-release-version: 0\.6\.21 -->\n## Versão 0\.6\.21\n/m);
    assert.doesNotMatch(notes.body, /desktop-release-version/i);
    const restore = prepareDesktopReleaseNotesForPublish(notes);
    assert.match(fs.readFileSync(notes.notesPath, 'utf8'), /^<!-- desktop-release-version: 0\.6\.21 -->\n## Versão 0\.6\.21\n/m);
    restore();
    assert.equal(fs.readFileSync(notes.notesPath, 'utf8'), '- Correção importante de estabilidade no aplicativo desktop.\n');
  } finally {
    data.cleanup();
  }
});

test('gera nota específica e agrupada a partir do snapshot publicado', () => {
  const data = fixture('0.6.21');
  try {
    const paymentPath = path.join(data.projectRoot, 'frontend', 'src', 'componentes');
    const testPath = path.join(data.projectRoot, 'frontend', 'tests');
    fs.mkdirSync(paymentPath, { recursive: true });
    fs.mkdirSync(testPath, { recursive: true });
    fs.writeFileSync(path.join(paymentPath, 'pagamentoBuscaUtils.js'), 'export function filtrarEmprestimosParaPagamento() { return []; }\n');
    fs.writeFileSync(path.join(testPath, 'pagamentoBuscaUtils.test.js'), 'test("cliente com dois ativos", () => {});\n');
    git(data.projectRoot, ['init']);
    git(data.projectRoot, ['config', 'user.email', 'teste@example.com']);
    git(data.projectRoot, ['config', 'user.name', 'Teste']);
    git(data.projectRoot, ['add', '.']);
    git(data.projectRoot, ['commit', '-m', 'base']);

    recordPublishedReleaseNotes({
      projectRoot: data.projectRoot,
      version: '0.6.21',
      body: '- Novidades da versao publicada.',
      sourceSnapshot: currentSourceSnapshot(data.projectRoot),
    });
    fs.writeFileSync(path.join(paymentPath, 'pagamentoBuscaUtils.js'), 'export function filtrarEmprestimosParaPagamento() { return [1, 2]; }\n');
    fs.writeFileSync(path.join(testPath, 'pagamentoBuscaUtils.test.js'), 'test("cliente com dois ativos", () => { /* regressão */ });\n');

    const notes = validateDesktopReleaseNotes({ projectRoot: data.projectRoot, expectedVersion: '0.6.22' });
    assert.match(notes.body, /busca por id do cliente.*todos os empr.stimos ativos/i);
    assert.equal((notes.body.match(/busca por id do cliente/gi) || []).length, 1);
    assert.doesNotMatch(notes.body, /melhorias gerais|corre..es diversas|estabilidade/i);
    assert.match(notes.body, /desktop-release-source: [a-f0-9]{64}/i);
  } finally {
    data.cleanup();
  }
});

test('regras conhecidas priorizam dinheiro e agrupam arquivos relacionados sem duplicar nota', () => {
  const items = specificReleaseItems([
    'backend/utils/gerarParcelas.js',
    'backend/tests/gerarParcelas.test.js',
    'frontend/src/componentes/pagamentoBuscaUtils.js',
    'frontend/tests/pagamentoBuscaUtils.test.js',
  ], 'reconciliarCapital arredondamento filtrarEmprestimosParaPagamento');
  assert.deepEqual(items, [
    'Corrigido o cálculo de parcelas para concentrar os centavos de arredondamento na última parcela.',
    'Corrigida a busca por ID do cliente na tela de Pagamentos para mostrar todos os empréstimos ativos.',
  ]);
});

test('bloqueia release com mudança sem contexto público específico', () => {
  const data = fixture('0.6.21');
  try {
    const sourcePath = path.join(data.projectRoot, 'backend', 'interno.js');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, 'module.exports = 1;\n');
    git(data.projectRoot, ['init']);
    git(data.projectRoot, ['config', 'user.email', 'teste@example.com']);
    git(data.projectRoot, ['config', 'user.name', 'Teste']);
    git(data.projectRoot, ['add', '.']);
    git(data.projectRoot, ['commit', '-m', 'base']);
    recordPublishedReleaseNotes({
      projectRoot: data.projectRoot,
      version: '0.6.21',
      body: '- Nota anterior específica.',
      sourceSnapshot: currentSourceSnapshot(data.projectRoot),
    });
    fs.writeFileSync(sourcePath, 'module.exports = 2;\n');
    assert.throws(
      () => validateDesktopReleaseNotes({ projectRoot: data.projectRoot, expectedVersion: '0.6.22' }),
      /não possuem informação suficiente/i
    );
  } finally {
    data.cleanup();
  }
});

test('injeta a versão alvo 0.6.22 sem editar as novidades entre releases', () => {
  const data = fixture('0.6.21');
  try {
    const notes = validateDesktopReleaseNotes({ projectRoot: data.projectRoot, expectedVersion: '0.6.22' });
    assert.equal(notes.version, '0.6.22');
    assert.match(notes.markdown, /^## Versão 0\.6\.22\n/m);
  } finally {
    data.cleanup();
  }
});

test('recusa novidades vazias e reutilização acidental de conteúdo publicado', () => {
  const empty = fixture('0.6.20', '');
  try {
    assert.throws(() => validateDesktopReleaseNotes({ projectRoot: empty.projectRoot, expectedVersion: '0.6.21' }), /Informe novidades públicas/);
  } finally {
    empty.cleanup();
  }

  const data = fixture('0.6.20');
  try {
    const notes = validateDesktopReleaseNotes({ projectRoot: data.projectRoot, expectedVersion: '0.6.21' });
    recordPublishedReleaseNotes({ projectRoot: data.projectRoot, version: notes.version, body: notes.body, publishedAt: '2026-01-01T00:00:00.000Z' });
    assert.throws(() => assertReleaseNotesNotReused({ projectRoot: data.projectRoot, body: notes.body }), /já foram publicadas na versão 0\.6\.21/);
  } finally {
    data.cleanup();
  }
});
