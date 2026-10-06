const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caixa-actions-'));
process.env.APP_DATA_DIR = tempDir;

const express = require('express');
const db = require('../models/database');
const { runAsync, getAsync } = require('../utils/sqliteAsync');
const actions = require('../services/actionService');

async function waitForActionSchema() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = await getAsync(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='acoes'");
    if (row) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Migration das acoes nao terminou.');
}

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/caixa', require('../routes/caixa'));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/caixa` };
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  return { status: response.status, body: await response.json() };
}

function execSql(sql) {
  return new Promise((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()));
}

async function resetData() {
  await execSql('DELETE FROM acao_entidades; DELETE FROM acao_snapshots; DELETE FROM acoes; DELETE FROM caixa_movimentos;');
}

test.after(async () => {
  await require('../services/segurancaService').getSegurancaService().fechar();
  await db.closeConnection();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('criar e excluir despesa preserva duas acoes e o snapshot anterior completo', async (t) => {
  await waitForActionSchema();
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await resetData();

  const created = await request(baseUrl, '/despesa', {
    method: 'POST', body: JSON.stringify({ data: '2026-10-21', valor: 85, descricao: 'Combustivel' }),
  });
  assert.equal(created.status, 200);
  const movimentoId = created.body.movimento_id;
  const actionCreated = (await actions.listarAcoes({ tipo: 'despesa_criada', status: 'aplicada' }, { dbHandle: db }))[0];
  const detailCreated = await actions.buscarAcaoPorId(actionCreated.id, { dbHandle: db });
  assert.equal(detailCreated.entidades[0].entidade_id, movimentoId);
  assert.equal(detailCreated.snapshots.length, 1);
  assert.equal(detailCreated.snapshots[0].momento, 'depois');
  assert.equal(detailCreated.snapshots[0].dados.descricao, 'Combustivel');

  const deleted = await request(baseUrl, `/despesa/${movimentoId}`, {
    method: 'DELETE', body: JSON.stringify({ password: '1otimodia' }),
  });
  assert.equal(deleted.status, 200);
  assert.equal((await getAsync(db, 'SELECT id FROM caixa_movimentos WHERE id=?', [movimentoId])), undefined);
  const actionDeleted = (await actions.listarAcoes({ tipo: 'despesa_excluida', status: 'aplicada' }, { dbHandle: db }))[0];
  const detailDeleted = await actions.buscarAcaoPorId(actionDeleted.id, { dbHandle: db });
  assert.equal((await actions.listarAcoes({}, { dbHandle: db })).length, 2);
  assert.equal(detailDeleted.snapshots.length, 1);
  assert.equal(detailDeleted.snapshots[0].momento, 'antes');
  assert.deepEqual(detailDeleted.snapshots[0].dados, detailCreated.snapshots[0].dados);
});

test('falha no registro da acao de criacao nao deixa despesa no caixa', async (t) => {
  await waitForActionSchema();
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await resetData();
  await runAsync(db, "CREATE TRIGGER falha_snapshot_despesa BEFORE INSERT ON acao_snapshots BEGIN SELECT RAISE(ABORT, 'falha auditoria'); END;");
  try {
    const response = await request(baseUrl, '/despesa', {
      method: 'POST', body: JSON.stringify({ data: '2026-10-21', valor: 10, descricao: 'Falha' }),
    });
    assert.equal(response.status, 500);
    assert.equal((await getAsync(db, 'SELECT COUNT(*) AS total FROM caixa_movimentos')).total, 0);
    assert.equal((await getAsync(db, 'SELECT COUNT(*) AS total FROM acoes')).total, 0);
  } finally {
    await runAsync(db, 'DROP TRIGGER falha_snapshot_despesa');
  }
});

test('falha durante exclusao conserva despesa e nao grava acao parcial', async (t) => {
  await waitForActionSchema();
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await resetData();
  const create = await request(baseUrl, '/despesa', {
    method: 'POST', body: JSON.stringify({ data: '2026-10-21', valor: 30, descricao: 'Nao apagar' }),
  });
  const movimentoId = create.body.movimento_id;
  await runAsync(db, "CREATE TRIGGER falha_delete_despesa BEFORE DELETE ON caixa_movimentos BEGIN SELECT RAISE(ABORT, 'falha delete'); END;");
  try {
    const response = await request(baseUrl, `/despesa/${movimentoId}`, {
      method: 'DELETE', body: JSON.stringify({ password: '1otimodia' }),
    });
    assert.equal(response.status, 500);
    assert.ok(await getAsync(db, 'SELECT id FROM caixa_movimentos WHERE id=?', [movimentoId]));
    assert.equal((await actions.listarAcoes({ tipo: 'despesa_excluida' }, { dbHandle: db })).length, 0);
  } finally {
    await runAsync(db, 'DROP TRIGGER falha_delete_despesa');
  }
});
