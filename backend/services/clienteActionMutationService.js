const sqlite3 = require('sqlite3').verbose();
const { allAsync, getAsync, runAsync } = require('../utils/sqliteAsync');
const { ensureActionContractReady } = require('./actionIdentityService');
const { ensureEntityIdentityV1 } = require('./entityIdentityService');
const { registrarAcaoCliente } = require('./clienteActionService');
const { ACTION_TYPES } = require('./actionTypeContract');

function erro(status, message) {
  return Object.assign(new Error(message), { status });
}

function identidadeCliente(cliente) {
  return { id: Number(cliente.id), cliente_uid: cliente.cliente_uid || null };
}

function estadoCobranca(cliente) {
  return {
    receber_notificacoes_cobranca: Number(cliente.receber_notificacoes_cobranca ?? 1) === 1 ? 1 : 0,
    motivo_notificacoes_cobranca: cliente.motivo_notificacoes_cobranca || null,
  };
}

async function emTransacao(dbPath, trabalho) {
  const connection = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE);
  connection.configure('busyTimeout', 5000);
  let aberta = false;
  try {
    await runAsync(connection, 'PRAGMA foreign_keys = ON');
    await ensureEntityIdentityV1(connection);
    await ensureActionContractReady(connection);
    await runAsync(connection, 'BEGIN IMMEDIATE');
    aberta = true;
    const resultado = await trabalho(connection);
    await runAsync(connection, 'COMMIT');
    aberta = false;
    return resultado;
  } catch (error) {
    if (aberta) await runAsync(connection, 'ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await new Promise((resolve, reject) => connection.close((error) => error ? reject(error) : resolve()));
  }
}

async function buscarCliente(connection, clienteId) {
  const cliente = await getAsync(connection, 'SELECT * FROM clientes WHERE id = ?', [clienteId]);
  if (!cliente) throw erro(404, 'Cliente nao encontrado.');
  return cliente;
}

async function adicionarTelefoneCliente({ dbPath, clienteId, telefone, normalizarTelefone }) {
  return emTransacao(dbPath, async (connection) => {
    const cliente = await buscarCliente(connection, clienteId);
    const telefoneNormalizado = normalizarTelefone(telefone);
    if (normalizarTelefone(cliente.telefone) === telefoneNormalizado) {
      throw erro(409, 'Telefone ja cadastrado para este cliente.');
    }

    const extras = await allAsync(
      connection,
      'SELECT id, telefone FROM clientes_telefones WHERE cliente_id = ? ORDER BY id ASC',
      [clienteId]
    );
    if (extras.some((item) => normalizarTelefone(item.telefone) === telefoneNormalizado)) {
      throw erro(409, 'Telefone ja cadastrado para este cliente.');
    }

    const antes = {
      cliente: identidadeCliente(cliente),
      telefones_extras: extras.map((item) => ({ id: Number(item.id), telefone: item.telefone })),
      telefone_adicionado: null,
    };
    const inserted = await runAsync(
      connection,
      'INSERT INTO clientes_telefones (cliente_id, telefone) VALUES (?, ?)',
      [clienteId, telefone]
    );
    const telefoneAdicionado = {
      id: Number(inserted.lastID), cliente_id: Number(clienteId), telefone,
    };
    const depois = {
      cliente: identidadeCliente(cliente),
      telefones_extras: [...antes.telefones_extras, { id: telefoneAdicionado.id, telefone }],
      telefone_adicionado: telefoneAdicionado,
    };
    await registrarAcaoCliente({
      tipo: ACTION_TYPES.CLIENTE_TELEFONE_ADICIONADO,
      clienteId,
      antes,
      depois,
      resumo: `Telefone adicional do cliente ${clienteId}`,
      metadata: { telefone_adicionado: telefoneAdicionado },
    }, { dbHandle: connection });
    return telefoneAdicionado;
  });
}

async function atualizarMalPagadorCliente({ dbPath, clienteId, malPagador }) {
  return emTransacao(dbPath, async (connection) => {
    const clienteAntes = await buscarCliente(connection, clienteId);
    const antes = {
      cliente: identidadeCliente(clienteAntes),
      estado: { mal_pagador: Number(clienteAntes.mal_pagador || 0) === 1 ? 1 : 0 },
      entrada: { mal_pagador: malPagador },
    };
    const update = await runAsync(
      connection, 'UPDATE clientes SET mal_pagador = ? WHERE id = ?', [malPagador, clienteId]
    );
    if (update.changes !== 1) throw erro(404, 'Cliente nao encontrado.');
    const clienteDepois = await buscarCliente(connection, clienteId);
    const depois = {
      cliente: identidadeCliente(clienteDepois),
      estado: { mal_pagador: Number(clienteDepois.mal_pagador || 0) === 1 ? 1 : 0 },
    };
    await registrarAcaoCliente({
      tipo: ACTION_TYPES.CLIENTE_MAL_PAGADOR_ATUALIZADO,
      clienteId,
      antes,
      depois,
      resumo: `Mal pagador do cliente ${clienteId} atualizado`,
      metadata: { entrada: antes.entrada },
    }, { dbHandle: connection });
    return clienteDepois;
  });
}

async function atualizarPreferenciaCobrancaCliente({ dbPath, clienteId, receber, temMotivo, motivo }) {
  return emTransacao(dbPath, async (connection) => {
    const clienteAntes = await buscarCliente(connection, clienteId);
    const entrada = {
      receber_notificacoes_cobranca: receber,
      ...(temMotivo ? { motivo_notificacoes_cobranca: motivo } : {}),
    };
    const antes = {
      cliente: identidadeCliente(clienteAntes), estado: estadoCobranca(clienteAntes), entrada,
    };
    const sql = temMotivo
      ? 'UPDATE clientes SET receber_notificacoes_cobranca = ?, motivo_notificacoes_cobranca = ? WHERE id = ?'
      : 'UPDATE clientes SET receber_notificacoes_cobranca = ? WHERE id = ?';
    const update = await runAsync(connection, sql, temMotivo ? [receber, motivo, clienteId] : [receber, clienteId]);
    if (update.changes !== 1) throw erro(404, 'Cliente nao encontrado.');
    const clienteDepois = await buscarCliente(connection, clienteId);
    const depois = { cliente: identidadeCliente(clienteDepois), estado: estadoCobranca(clienteDepois) };
    await registrarAcaoCliente({
      tipo: ACTION_TYPES.CLIENTE_PREFERENCIA_COBRANCA_ATUALIZADA,
      clienteId,
      antes,
      depois,
      resumo: `Preferencia de cobranca do cliente ${clienteId} atualizada`,
      metadata: { entrada },
    }, { dbHandle: connection });
    return clienteDepois;
  });
}

async function atualizarFotoCliente({ dbPath, clienteId, fotoCliente }) {
  return emTransacao(dbPath, async (connection) => {
    const clienteAntes = await buscarCliente(connection, clienteId);
    const referenciaAnterior = clienteAntes.foto_cliente || null;
    const update = await runAsync(connection, 'UPDATE clientes SET foto_cliente = ? WHERE id = ?', [fotoCliente, clienteId]);
    if (update.changes !== 1) throw erro(404, 'Cliente nao encontrado.');
    const clienteDepois = await buscarCliente(connection, clienteId);
    const referenciaPosterior = clienteDepois.foto_cliente || null;
    const operacao = !referenciaAnterior ? 'adicionar' : !referenciaPosterior ? 'remover' : 'trocar';
    await registrarAcaoCliente({
      tipo: ACTION_TYPES.CLIENTE_FOTO_ATUALIZADA,
      clienteId,
      antes: { cliente: identidadeCliente(clienteAntes), foto: { referencia: referenciaAnterior } },
      depois: { cliente: identidadeCliente(clienteDepois), foto: { referencia: referenciaPosterior } },
      resumo: `Foto do cliente ${clienteId}: ${operacao}`,
      metadata: { operacao, foto_anterior: referenciaAnterior, foto_posterior: referenciaPosterior },
    }, { dbHandle: connection });
    return { clienteAntes, clienteDepois, operacao };
  });
}

module.exports = {
  adicionarTelefoneCliente,
  atualizarMalPagadorCliente,
  atualizarPreferenciaCobrancaCliente,
  atualizarFotoCliente,
};
