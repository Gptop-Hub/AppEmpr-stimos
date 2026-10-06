const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fase2f-actions-'));
process.env.APP_DATA_DIR = tempDir;

const express = require('express');
const db = require('../models/database');
const { getAsync, runAsync } = require('../utils/sqliteAsync');
const actions = require('../services/actionService');

const PNG_MINIMO = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0000004010200cfa9c36d0000000049454e44ae426082',
  'hex'
);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForSchema() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const action = await getAsync(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='acoes'");
    const client = await getAsync(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='clientes'");
    if (action && client) return;
    await wait(10);
  }
  assert.fail('Schema do Motor de Acoes nao ficou pronto.');
}

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/clientes', require('../routes/cliente'));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function jsonRequest(baseUrl, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function uploadPhoto(baseUrl, clienteId) {
  const form = new FormData();
  form.append('foto', new Blob([PNG_MINIMO], { type: 'image/png' }), 'cliente.png');
  const response = await fetch(`${baseUrl}/clientes/${clienteId}/foto`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}

async function resetData() {
  await runAsync(db, 'DELETE FROM acao_entidades; DELETE FROM acao_snapshots; DELETE FROM acoes;');
  await runAsync(db, 'DELETE FROM clientes_telefones; DELETE FROM clientes;');
}

async function criarCliente() {
  await runAsync(
    db,
    "INSERT INTO clientes (id, nome, cpf, telefone, criadoEm) VALUES (1, 'Cliente Fase 2F', '11122233344', '(11) 99999-0000', '2026-09-28')"
  );
  return getAsync(db, 'SELECT id, cliente_uid FROM clientes WHERE id = 1');
}

test.after(async () => {
  await require('../services/segurancaService').getSegurancaService().fechar();
  await db.closeConnection();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Fase 2F registra uma acao por mutacao, snapshots e rollback SQLite', async (t) => {
  await waitForSchema();
  await resetData();
  const cliente = await criarCliente();
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const telefone = await jsonRequest(baseUrl, '/clientes/1/telefones', {
    method: 'POST', body: { telefone: '11988887777' },
  });
  assert.equal(telefone.status, 201);
  const telefoneAction = (await actions.listarAcoes({ tipo: 'CLIENTE_TELEFONE_ADICIONADO' }, { dbHandle: db }))[0];
  const telefoneDetail = await actions.buscarAcaoPorId(telefoneAction.id, { dbHandle: db });
  assert.equal(telefoneDetail.entidades[0].entidade_uid, cliente.cliente_uid);
  assert.equal(telefoneDetail.snapshots.find((item) => item.momento === 'antes').dados.telefone_adicionado, null);
  assert.equal(telefoneDetail.snapshots.find((item) => item.momento === 'depois').dados.telefone_adicionado.telefone, '(11) 98888-7777');

  assert.equal((await jsonRequest(baseUrl, '/clientes/1/mal-pagador', { method: 'PATCH', body: { mal_pagador: true } })).status, 200);
  assert.equal((await jsonRequest(baseUrl, '/clientes/1/mal-pagador', { method: 'PATCH', body: { mal_pagador: false } })).status, 200);
  const malActions = await actions.listarAcoes({ tipo: 'CLIENTE_MAL_PAGADOR_ATUALIZADO' }, { dbHandle: db });
  assert.equal(malActions.length, 2);
  const malDetail = await actions.buscarAcaoPorId(malActions[1].id, { dbHandle: db });
  assert.equal(malDetail.snapshots.find((item) => item.momento === 'antes').dados.entrada.mal_pagador, 1);
  assert.equal(malDetail.snapshots.find((item) => item.momento === 'depois').dados.estado.mal_pagador, 1);

  assert.equal((await jsonRequest(baseUrl, '/clientes/1/notificacoes-cobranca', {
    method: 'PATCH', body: { receber_notificacoes_cobranca: false, motivo_notificacoes_cobranca: 'Acordo externo' },
  })).status, 200);
  const preferenciaAction = (await actions.listarAcoes({ tipo: 'CLIENTE_PREFERENCIA_COBRANCA_ATUALIZADA' }, { dbHandle: db }))[0];
  const preferenciaDetail = await actions.buscarAcaoPorId(preferenciaAction.id, { dbHandle: db });
  assert.deepEqual(preferenciaDetail.snapshots.find((item) => item.momento === 'depois').dados.estado, {
    receber_notificacoes_cobranca: 0,
    motivo_notificacoes_cobranca: 'Acordo externo',
  });

  const primeiraFoto = await uploadPhoto(baseUrl, 1);
  assert.equal(primeiraFoto.status, 200);
  const segundaFoto = await uploadPhoto(baseUrl, 1);
  assert.equal(segundaFoto.status, 200);
  assert.notEqual(primeiraFoto.body.foto_cliente, segundaFoto.body.foto_cliente);
  assert.equal((await jsonRequest(baseUrl, '/clientes/1/foto', { method: 'DELETE' })).status, 200);
  const fotos = await actions.listarAcoes({ tipo: 'CLIENTE_FOTO_ATUALIZADA' }, { dbHandle: db });
  assert.equal(fotos.length, 3);
  const fotoRemovida = await actions.buscarAcaoPorId(fotos[0].id, { dbHandle: db });
  assert.equal(fotoRemovida.metadata.operacao, 'remover');
  assert.equal(fotoRemovida.snapshots.find((item) => item.momento === 'depois').dados.foto.referencia, null);
  assert.equal(JSON.stringify(fotoRemovida.snapshots).includes(PNG_MINIMO.toString('base64')), false);

  const acoesAntesDaFalha = await actions.listarAcoes({}, { dbHandle: db });
  await runAsync(db, "CREATE TRIGGER falha_acao_fase2f BEFORE INSERT ON acao_snapshots WHEN NEW.momento = 'depois' BEGIN SELECT RAISE(ABORT, 'falha auditoria'); END;");
  try {
    const falha = await jsonRequest(baseUrl, '/clientes/1/mal-pagador', { method: 'PATCH', body: { mal_pagador: true } });
    assert.equal(falha.status, 500);
    assert.equal((await getAsync(db, 'SELECT mal_pagador FROM clientes WHERE id = 1')).mal_pagador, 0);
    assert.equal((await actions.listarAcoes({}, { dbHandle: db })).length, acoesAntesDaFalha.length);
  } finally {
    await runAsync(db, 'DROP TRIGGER falha_acao_fase2f');
  }
});
