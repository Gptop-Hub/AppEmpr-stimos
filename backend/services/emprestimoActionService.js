const { allAsync, getAsync } = require('../utils/sqliteAsync');
const {
  iniciarAcao,
  registrarEntidade,
  registrarSnapshot,
  finalizarAcaoAplicada,
} = require('./actionService');

const TABLES = [
  'parcelas', 'parcelas_originais', 'pagamentos', 'caixa_movimentos',
  'renegociacoes_historico', 'notificacoes', 'recalculos_atraso',
];

async function tableExists(dbHandle, table) {
  return Boolean(await getAsync(
    dbHandle,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table]
  ));
}

async function rowsForLoan(dbHandle, table, emprestimoId) {
  if (!await tableExists(dbHandle, table)) return [];
  return allAsync(dbHandle, `SELECT * FROM ${table} WHERE emprestimo_id = ? ORDER BY id ASC`, [emprestimoId]);
}

async function renegotiationsForLoan(dbHandle, emprestimoId) {
  if (!await tableExists(dbHandle, 'renegociacoes')) return [];
  return allAsync(
    dbHandle,
    'SELECT * FROM renegociacoes WHERE antigo_id = ? OR novo_id = ? ORDER BY id ASC',
    [emprestimoId, emprestimoId]
  );
}

/**
 * A representação é intencionalmente composta somente por registros já
 * existentes. IDs SQLite ficam como referências locais, enquanto a identidade
 * transportável pertence ao cabeçalho da ação V1.
 */
async function capturarEstadoEmprestimo(emprestimoId, { dbHandle } = {}) {
  const emprestimo = await getAsync(dbHandle, 'SELECT * FROM emprestimos WHERE id = ?', [emprestimoId]);
  const cliente = emprestimo
    ? await getAsync(dbHandle, 'SELECT * FROM clientes WHERE id = ?', [emprestimo.cliente_id])
    : null;
  const related = await Promise.all(TABLES.map(async (table) => [table, await rowsForLoan(dbHandle, table, emprestimoId)]));
  return {
    emprestimo: emprestimo || null,
    cliente: cliente || null,
    ...Object.fromEntries(related),
    renegociacoes: await renegotiationsForLoan(dbHandle, emprestimoId),
  };
}

function ids(rows) {
  return (rows || []).map((row) => Number(row.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
}

async function registrarAcaoEmprestimo({
  tipo,
  origem,
  emprestimoId,
  clienteId,
  antes,
  depois,
  parametros = {},
  resumo,
}, { dbHandle } = {}) {
  // Os parâmetros de UI podem omitir campos opcionais; no contrato de
  // snapshots, ausência é registrada de forma estável como null.
  const parametrosNormalizados = JSON.parse(JSON.stringify(parametros, (_key, value) => (
    value === undefined ? null : value
  )));
  const action = await iniciarAcao({
    tipo,
    origem,
    emprestimo_id: emprestimoId,
    cliente_id: clienteId,
    resumo,
    metadata: { contract: 'emprestimo_action_v1', parametros: parametrosNormalizados },
  }, { dbHandle });

  const entities = new Set();
  const addEntity = async (entidade, entidadeId, papel, entidadeUid = null) => {
    const id = Number(entidadeId);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const key = `${entidade}:${id}:${papel}`;
    if (entities.has(key)) return;
    entities.add(key);
    await registrarEntidade(action, { entidade, entidade_id: id, entidade_uid: entidadeUid, papel });
  };

  const emprestimo = depois?.emprestimo || antes?.emprestimo || null;
  const cliente = depois?.cliente || antes?.cliente || null;
  await addEntity('emprestimos', emprestimoId, 'afetado', emprestimo?.emprestimo_uid || null);
  await addEntity('clientes', clienteId, 'relacionado', cliente?.cliente_uid || null);
  for (const [table, role] of [
    ['parcelas', 'afetada'],
    ['parcelas_originais', 'afetada'],
    ['pagamentos', 'relacionado'],
    ['caixa_movimentos', 'gerado'],
    ['renegociacoes_historico', 'gerado'],
    ['renegociacoes', 'relacionada'],
    ['notificacoes', 'relacionada'],
    ['recalculos_atraso', 'relacionado'],
  ]) {
    const rows = [...(antes?.[table] || []), ...(depois?.[table] || [])];
    for (const id of new Set(ids(rows))) {
      const row = rows.find((item) => Number(item.id) === id) || null;
      await addEntity(table, id, role, table === 'parcelas' ? row?.parcela_uid || null : null);
    }
  }

  // Um único snapshot agregado por momento conserva o contrato, cronograma,
  // caixa e histórico, sem multiplicar ações por efeitos derivados.
  await registrarSnapshot(action, {
    momento: 'antes',
    entidade: 'emprestimos',
    entidade_id: emprestimoId,
    dados: { estado: antes || null, parametros: parametrosNormalizados },
  });
  await registrarSnapshot(action, {
    momento: 'depois',
    entidade: 'emprestimos',
    entidade_id: emprestimoId,
    dados: { estado: depois || null, parametros: parametrosNormalizados },
  });
  return finalizarAcaoAplicada(action);
}

module.exports = { capturarEstadoEmprestimo, registrarAcaoEmprestimo };
