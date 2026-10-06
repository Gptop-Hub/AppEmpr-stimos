const { allAsync, getAsync } = require('../utils/sqliteAsync');
const {
  iniciarAcao,
  registrarEntidade,
  registrarSnapshot,
  finalizarAcaoAplicada,
} = require('./actionService');

async function capturarEstadoCliente(clienteId, { dbHandle } = {}) {
  const cliente = await getAsync(dbHandle, 'SELECT * FROM clientes WHERE id = ?', [clienteId]);
  if (!cliente) return { cliente: null, telefones: [] };
  const telefones = await allAsync(
    dbHandle,
    'SELECT * FROM clientes_telefones WHERE cliente_id = ? ORDER BY id ASC',
    [clienteId]
  );
  return { cliente, telefones };
}

async function registrarAcaoCliente({ tipo, clienteId, antes, depois, resumo, metadata = {} }, { dbHandle } = {}) {
  const cliente = depois?.cliente || antes?.cliente || null;
  const action = await iniciarAcao({
    tipo,
    origem: 'interface',
    cliente_id: clienteId,
    resumo,
    metadata: { contract: 'cliente_action_v1', ...metadata },
  }, { dbHandle });
  await registrarEntidade(action, {
    entidade: 'clientes',
    entidade_id: clienteId,
    entidade_uid: cliente?.cliente_uid || null,
    papel: 'afetado',
  });
  await registrarSnapshot(action, {
    momento: 'antes', entidade: 'clientes', entidade_id: clienteId,
    dados: antes || { cliente: null, telefones: [] },
  });
  await registrarSnapshot(action, {
    momento: 'depois', entidade: 'clientes', entidade_id: clienteId,
    dados: depois || { cliente: null, telefones: [] },
  });
  return finalizarAcaoAplicada(action);
}

module.exports = { capturarEstadoCliente, registrarAcaoCliente };
