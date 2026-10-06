const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fase2g-actions-'));
process.env.APP_DATA_DIR = tempDir;

const express = require('express');
const db = require('../models/database');
const { getAsync, runAsync } = require('../utils/sqliteAsync');
const actions = require('../services/actionService');
const { gerarNotificacoesParaData } = require('../services/notificacoesService');
const { getConfigPath } = require('../config/notificacoesConfig');

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForSchema() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const action = await getAsync(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='acoes'");
    if (action) return;
    await wait(10);
  }
  assert.fail('Schema do Motor de Acoes nao ficou pronto.');
}

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/notificacoes', require('../routes/notificacoes'));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function request(baseUrl, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function resetData() {
  await new Promise((resolve, reject) => db.exec(`
    DELETE FROM acao_entidades;
    DELETE FROM acao_snapshots;
    DELETE FROM acoes;
    DELETE FROM notificacoes;
    DELETE FROM parcelas;
    DELETE FROM emprestimos;
    DELETE FROM clientes;
  `, (error) => error ? reject(error) : resolve()));
  await fs.promises.unlink(getConfigPath()).catch((error) => {
    if (!error || error.code !== 'ENOENT') throw error;
  });
}

async function prepararNotificacoes() {
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE IF NOT EXISTS notificacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL, titulo TEXT NOT NULL,
      mensagem TEXT NOT NULL, data_referencia TEXT NOT NULL, emprestimo_id INTEGER,
      parcela_id INTEGER, status TEXT NOT NULL DEFAULT 'pendente', criado_em TEXT DEFAULT (datetime('now')),
      lido_em TEXT, UNIQUE (tipo, parcela_id, data_referencia)
    );
    INSERT INTO clientes (id, nome, cpf, telefone, criadoEm) VALUES
      (1, 'Cliente notificacoes', '11122233344', '11999990000', '2026-09-28');
    INSERT INTO emprestimos (id, cliente_id, versao_atual) VALUES (1, 1, 1);
    INSERT INTO parcelas (id, emprestimo_id, numero, vencimento, valor_total, pago, versao) VALUES
      (1, 1, 1, '2026-09-28', 100, 0, 1),
      (2, 1, 2, '2026-09-29', 100, 0, 1);
  `, (error) => error ? reject(error) : resolve()));
}

test.after(async () => {
  await require('../services/segurancaService').getSegurancaService().fechar();
  await db.closeConnection();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Fase 2G registra somente operacoes explicitas de notificacoes', async (t) => {
  await waitForSchema();
  await prepararNotificacoes();
  await resetData();
  await prepararNotificacoes();
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  assert.equal((await request(baseUrl, '/notificacoes')).status, 200);
  assert.equal((await actions.listarAcoes({}, { dbHandle: db })).length, 0);

  const geracao = await request(baseUrl, '/notificacoes/run', {
    method: 'POST', body: { data: '2026-09-28' },
  });
  assert.equal(geracao.status, 200);
  assert.equal(geracao.body.criadas, 2);
  const geradas = await actions.listarAcoes({ tipo: 'NOTIFICACOES_GERADAS' }, { dbHandle: db });
  assert.equal(geradas.length, 1);
  const detalheGeracao = await actions.buscarAcaoPorId(geradas[0].id, { dbHandle: db });
  assert.equal(detalheGeracao.entidades.length, 0);
  assert.match(detalheGeracao.acao_uid, /^[0-9a-f-]{36}$/i);
  assert.match(detalheGeracao.origin_device_id, /^[0-9a-f-]{36}$/i);
  assert.ok(detalheGeracao.origin_sequence > 0);
  assert.equal(detalheGeracao.metadata_version, 1);
  assert.equal(detalheGeracao.snapshots.find((item) => item.momento === 'antes').dados.estado.total, 0);
  const resultado = detalheGeracao.snapshots.find((item) => item.momento === 'depois').dados.resultado;
  assert.equal(resultado.contagens.criadas, 2);
  assert.equal(resultado.criadas.length, 2);

  assert.equal((await request(baseUrl, '/notificacoes?incluirDesligadas=1')).status, 200);
  assert.equal((await actions.listarAcoes({ tipo: 'NOTIFICACOES_GERADAS' }, { dbHandle: db })).length, 1);
  await gerarNotificacoesParaData('2026-09-28');
  assert.equal((await actions.listarAcoes({ tipo: 'NOTIFICACOES_GERADAS' }, { dbHandle: db })).length, 1);

  const salva = await request(baseUrl, '/notificacoes/config', {
    method: 'POST', body: { venceEmBreveDias: 5 },
  });
  assert.equal(salva.status, 200);
  const restaura = await request(baseUrl, '/notificacoes/config/default', { method: 'POST' });
  assert.equal(restaura.status, 200);
  const configuracoes = await actions.listarAcoes({ tipo: 'CONFIG_NOTIFICACOES_ATUALIZADA' }, { dbHandle: db });
  assert.equal(configuracoes.length, 2);
  const detalheRestore = await actions.buscarAcaoPorId(configuracoes[0].id, { dbHandle: db });
  assert.equal(detalheRestore.metadata.operacao, 'restaurar_padrao');
  assert.deepEqual(detalheRestore.snapshots.find((item) => item.momento === 'depois').dados.configuracao, {
    venceEmBreveDias: 3,
  });

  const configAntesDaFalha = await fs.promises.readFile(getConfigPath(), 'utf8');
  const quantidadeAcoesAntesDaFalha = (await actions.listarAcoes({}, { dbHandle: db })).length;
  await runAsync(db, "CREATE TRIGGER falha_acao_fase2g BEFORE INSERT ON acao_snapshots WHEN NEW.momento = 'depois' BEGIN SELECT RAISE(ABORT, 'falha auditoria'); END;");
  try {
    const falha = await request(baseUrl, '/notificacoes/config', {
      method: 'POST', body: { venceEmBreveDias: 9 },
    });
    assert.equal(falha.status, 500);
    assert.equal(await fs.promises.readFile(getConfigPath(), 'utf8'), configAntesDaFalha);
    assert.equal((await actions.listarAcoes({}, { dbHandle: db })).length, quantidadeAcoesAntesDaFalha);
  } finally {
    await runAsync(db, 'DROP TRIGGER falha_acao_fase2g');
  }
});
