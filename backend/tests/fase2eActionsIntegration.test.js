const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fase2e-actions-'));
process.env.APP_DATA_DIR = tempDir;

const express = require('express');
const db = require('../models/database');
const { runAsync, getAsync, allAsync } = require('../utils/sqliteAsync');
const actions = require('../services/actionService');

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForSchema() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const action = await getAsync(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='acoes'");
    const columns = await allAsync(db, 'PRAGMA table_info(clientes)');
    if (action && columns.some((column) => column.name === 'cliente_uid')) return;
    await wait(10);
  }
  assert.fail('Schema da Fase 2E nao ficou pronto.');
}

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/clientes', require('../routes/cliente'));
  app.use('/parcelas', require('../routes/parcelas'));
  app.use('/emprestimos', require('../routes/emprestimo'));
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

function execSql(sql) {
  return new Promise((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()));
}

async function resetData() {
  await execSql('DELETE FROM acao_entidades; DELETE FROM acao_snapshots; DELETE FROM acoes;');
  for (const table of ['notificacoes', 'caixa_movimentos', 'recalculos_atraso', 'renegociacoes_historico', 'renegociacoes', 'pagamentos', 'parcelas_originais', 'parcelas', 'emprestimos', 'clientes_telefones', 'clientes']) {
    const found = await getAsync(db, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]);
    if (found) await runAsync(db, `DELETE FROM ${table}`);
  }
}

function clientPayload(overrides = {}) {
  return {
    nome: 'Cliente Fase 2E', cpf: '11122233344', telefone: '11999990000',
    endereco: 'Rua Teste', trabalho: 'Teste', categoria_trabalho: 'outros',
    referencia: 'Ref', observacao: 'Obs', criadoEm: '2026-09-28',
    ...overrides,
  };
}

test.after(async () => {
  await require('../services/segurancaService').getSegurancaService().fechar();
  await db.closeConnection();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('clientes criam, editam e excluem uma unica acao com UID e snapshots completos', async (t) => {
  await waitForSchema();
  await resetData();
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const created = await request(baseUrl, '/clientes', { method: 'POST', body: clientPayload() });
  assert.equal(created.status, 201);
  const clienteId = Number(created.body.id);
  assert.equal((await actions.listarAcoes({ tipo: 'CLIENTE_CRIADO' }, { dbHandle: db })).length, 1);

  await runAsync(db, 'INSERT INTO clientes_telefones (cliente_id, telefone) VALUES (?, ?)', [clienteId, '11888880000']);
  const edited = await request(baseUrl, `/clientes/${clienteId}`, {
    method: 'PUT', body: clientPayload({ nome: 'Cliente Editado', password: '1otimodia' }),
  });
  assert.equal(edited.status, 200);
  const editedAction = (await actions.listarAcoes({ tipo: 'CLIENTE_EDITADO' }, { dbHandle: db }))[0];
  const editedDetail = await actions.buscarAcaoPorId(editedAction.id, { dbHandle: db });
  assert.equal(editedDetail.snapshots.length, 2);
  assert.equal(editedDetail.snapshots.find((item) => item.momento === 'antes').dados.cliente.nome, 'Cliente Fase 2E');
  assert.equal(editedDetail.snapshots.find((item) => item.momento === 'depois').dados.cliente.nome, 'Cliente Editado');

  const clienteUid = (await getAsync(db, 'SELECT cliente_uid FROM clientes WHERE id = ?', [clienteId])).cliente_uid;
  const deleted = await request(baseUrl, `/clientes/${clienteId}`, {
    method: 'DELETE', body: { password: '1otimodia' },
  });
  assert.equal(deleted.status, 200);
  const deletedAction = (await actions.listarAcoes({ tipo: 'CLIENTE_EXCLUIDO' }, { dbHandle: db }))[0];
  const deletedDetail = await actions.buscarAcaoPorId(deletedAction.id, { dbHandle: db });
  assert.equal(deletedDetail.entidades[0].entidade_uid, clienteUid);
  assert.equal(deletedDetail.snapshots.find((item) => item.momento === 'antes').dados.telefones.length, 1);
  assert.equal((await actions.listarAcoes({ status: 'aplicada' }, { dbHandle: db })).length, 3);
});

test('juros adicionais gera uma unica acao com UIDs e rollback da acao mantem parcela intacta', async (t) => {
  await waitForSchema();
  await resetData();
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await runAsync(db, "INSERT INTO clientes (id,nome,cpf,telefone,criadoEm) VALUES (10,'Juros','22233344455','11999990001','2026-09-28')");
  await runAsync(db, 'INSERT INTO emprestimos (id,cliente_id,valor,versao_atual) VALUES (20,10,100,1)');
  await runAsync(db, 'INSERT INTO parcelas (id,emprestimo_id,numero,valor_total,pago,versao) VALUES (30,20,1,110,0,1)');
  const parcelaUid = (await getAsync(db, 'SELECT parcela_uid FROM parcelas WHERE id=30')).parcela_uid;

  const response = await request(baseUrl, '/parcelas/30/juros-adicionais', {
    method: 'POST', body: { valor: 12.5, motivo: 'Ajuste confirmado', data: '2026-09-28' },
  });
  assert.equal(response.status, 200);
  const action = (await actions.listarAcoes({ tipo: 'JUROS_ADICIONAIS_ADICIONADOS' }, { dbHandle: db }))[0];
  const detail = await actions.buscarAcaoPorId(action.id, { dbHandle: db });
  assert.equal(detail.entidades.find((item) => item.entidade === 'parcelas').entidade_uid, parcelaUid);
  assert.equal(detail.snapshots.length, 2);
  assert.equal(detail.snapshots.find((item) => item.momento === 'antes').dados.estado.parcelas[0].juros_adicionais || 0, 0);
  assert.equal(detail.snapshots.find((item) => item.momento === 'depois').dados.estado.parcelas[0].juros_adicionais, 12.5);
  assert.equal(detail.snapshots.find((item) => item.momento === 'depois').dados.parametros.explicacao, 'Ajuste confirmado');

  await runAsync(db, 'INSERT INTO parcelas (id,emprestimo_id,numero,valor_total,pago,versao) VALUES (31,20,2,110,0,1)');
  await runAsync(db, "CREATE TRIGGER falha_acao_juros BEFORE INSERT ON acao_snapshots WHEN NEW.momento = 'depois' BEGIN SELECT RAISE(ABORT, 'falha auditoria'); END;");
  try {
    const failed = await request(baseUrl, '/parcelas/31/juros-adicionais', {
      method: 'POST', body: { valor: 9, motivo: 'Nao persistir', data: '2026-09-28', password: '1otimodia' },
    });
    assert.equal(failed.status, 500);
    assert.equal((await getAsync(db, 'SELECT juros_adicionais FROM parcelas WHERE id=31')).juros_adicionais, null);
    assert.equal((await actions.listarAcoes({ tipo: 'JUROS_ADICIONAIS_ADICIONADOS' }, { dbHandle: db })).length, 1);
  } finally {
    await runAsync(db, 'DROP TRIGGER falha_acao_juros');
  }
});

test('exclusao individual preserva snapshot completo antes e uma acao EMPRESTIMO_EXCLUIDO', async (t) => {
  await waitForSchema();
  await resetData();
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await runAsync(db, "INSERT INTO clientes (id,nome,cpf,telefone,criadoEm) VALUES (40,'Exclusao','33344455566','11999990002','2026-09-28')");
  await runAsync(db, 'INSERT INTO emprestimos (id,cliente_id,valor,versao_atual) VALUES (50,40,200,1)');
  await runAsync(db, 'INSERT INTO parcelas (id,emprestimo_id,numero,valor_total,pago,versao) VALUES (60,50,1,220,0,1)');
  await runAsync(db, "INSERT INTO pagamentos (emprestimo_id,valor,data,tipo_pagamento) VALUES (50,20,'2026-09-28','normal')");
  await runAsync(db, "INSERT INTO caixa_movimentos (tipo,categoria,data,emprestimo_id,valor_total) VALUES ('ENTRADA','PAGAMENTO','2026-09-28',50,20)");
  if (await getAsync(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='renegociacoes'")) {
    await runAsync(db, 'INSERT INTO renegociacoes (antigo_id,novo_id) VALUES (50,50)');
  }
  const emprestimoUid = (await getAsync(db, 'SELECT emprestimo_uid FROM emprestimos WHERE id=50')).emprestimo_uid;

  const response = await request(baseUrl, '/emprestimos/50', { method: 'DELETE', body: { password: '1otimodia' } });
  assert.equal(response.status, 200);
  const action = (await actions.listarAcoes({ tipo: 'EMPRESTIMO_EXCLUIDO' }, { dbHandle: db }))[0];
  const detail = await actions.buscarAcaoPorId(action.id, { dbHandle: db });
  const before = detail.snapshots.find((item) => item.momento === 'antes').dados.estado;
  assert.equal(detail.entidades.find((item) => item.entidade === 'emprestimos').entidade_uid, emprestimoUid);
  assert.equal(before.parcelas.length, 1);
  assert.equal(before.pagamentos.length, 1);
  assert.equal(before.caixa_movimentos.length, 1);
  assert.equal(before.renegociacoes.length, 1);
  assert.equal((await getAsync(db, 'SELECT id FROM emprestimos WHERE id=50')), undefined);
});
