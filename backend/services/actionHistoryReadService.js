const { allAsync, getAsync } = require('../utils/sqliteAsync');
const { canonicalActionType, compatibleActionTypes } = require('./actionTypeContract');

const ACTION_PRESENTATION = Object.freeze({
  PARCELAS_REAGENDADAS: { nome: 'Vencimento reagendado', categoria: 'emprestimos' },
  DESPESA_CRIADA: { nome: 'Despesa criada', categoria: 'financeiro' },
  DESPESA_EXCLUIDA: { nome: 'Despesa excluída', categoria: 'financeiro' },
  EMPRESTIMO_CRIADO: { nome: 'Empréstimo criado', categoria: 'emprestimos' },
  EMPRESTIMO_EDITADO: { nome: 'Empréstimo editado', categoria: 'emprestimos' },
  CAPITAL_ADICIONADO: { nome: 'Capital adicionado', categoria: 'financeiro' },
  EMPRESTIMO_RENEGOCIADO: { nome: 'Empréstimo renegociado', categoria: 'emprestimos' },
  PAGAMENTO_NORMAL_REGISTRADO: { nome: 'Pagamento registrado', categoria: 'pagamentos' },
  PAGAMENTO_MANUAL_REGISTRADO: { nome: 'Pagamento manual registrado', categoria: 'pagamentos' },
  PAGAMENTO_MANUAL_RENEGOCIADO: { nome: 'Pagamento e renegociação', categoria: 'pagamentos' },
  JUROS_REGISTRADOS: { nome: 'Juros registrados', categoria: 'pagamentos' },
  JUROS_PARCIAIS_REGISTRADOS: { nome: 'Juros parciais registrados', categoria: 'pagamentos' },
  EMPRESTIMO_QUITADO: { nome: 'Empréstimo quitado', categoria: 'pagamentos' },
  CLIENTE_CRIADO: { nome: 'Cliente criado', categoria: 'clientes' },
  CLIENTE_EDITADO: { nome: 'Cliente editado', categoria: 'clientes' },
  CLIENTE_EXCLUIDO: { nome: 'Cliente excluído', categoria: 'clientes' },
  CLIENTE_TELEFONE_ADICIONADO: { nome: 'Telefone adicionado', categoria: 'clientes' },
  CLIENTE_FOTO_ATUALIZADA: { nome: 'Foto do cliente atualizada', categoria: 'clientes' },
  CLIENTE_MAL_PAGADOR_ATUALIZADO: { nome: 'Status de mal pagador alterado', categoria: 'clientes' },
  CLIENTE_PREFERENCIA_COBRANCA_ATUALIZADA: { nome: 'Preferência de cobrança atualizada', categoria: 'clientes' },
  JUROS_ADICIONAIS_ADICIONADOS: { nome: 'Juros adicionais incluídos', categoria: 'pagamentos' },
  EMPRESTIMO_EXCLUIDO: { nome: 'Empréstimo excluído', categoria: 'emprestimos' },
  NOTIFICACOES_GERADAS: { nome: 'Notificações atualizadas', categoria: 'secundarias', secundaria: true },
  NOTIFICACAO_MARCADA_LIDA: { nome: 'Notificação marcada como lida', categoria: 'secundarias', secundaria: true },
  CONFIG_NOTIFICACOES_ATUALIZADA: { nome: 'Configuração de notificações atualizada', categoria: 'secundarias', secundaria: true },
});

const CATEGORY_TYPES = Object.freeze({
  clientes: Object.keys(ACTION_PRESENTATION).filter((type) => ACTION_PRESENTATION[type].categoria === 'clientes'),
  emprestimos: [
    'EMPRESTIMO_CRIADO', 'EMPRESTIMO_EDITADO', 'EMPRESTIMO_RENEGOCIADO',
    'EMPRESTIMO_QUITADO', 'EMPRESTIMO_EXCLUIDO', 'PARCELAS_REAGENDADAS',
  ],
  pagamentos: [
    'PAGAMENTO_NORMAL_REGISTRADO', 'PAGAMENTO_MANUAL_REGISTRADO',
    'PAGAMENTO_MANUAL_RENEGOCIADO', 'JUROS_REGISTRADOS',
    'JUROS_PARCIAIS_REGISTRADOS', 'JUROS_ADICIONAIS_ADICIONADOS',
    'EMPRESTIMO_QUITADO',
  ],
  financeiro: [
    'DESPESA_CRIADA', 'DESPESA_EXCLUIDA', 'CAPITAL_ADICIONADO',
    'PAGAMENTO_NORMAL_REGISTRADO', 'PAGAMENTO_MANUAL_REGISTRADO',
    'PAGAMENTO_MANUAL_RENEGOCIADO', 'JUROS_REGISTRADOS',
    'JUROS_PARCIAIS_REGISTRADOS', 'JUROS_ADICIONAIS_ADICIONADOS',
    'EMPRESTIMO_QUITADO',
  ],
});

const STATUS_LABELS = Object.freeze({
  aplicada: 'Ativa',
  desfeita: 'Desfeita',
  falhou: 'Falhou',
  bloqueada: 'Bloqueada',
});

function inputError(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ACTION_HISTORY_QUERY', status: 400 });
}

function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw inputError('Parâmetros de paginação inválidos.');
  }
  return number;
}

function normalizeSearch(value) {
  const text = String(value || '').trim();
  if (text.length > 120) throw inputError('A pesquisa deve ter no máximo 120 caracteres.');
  return text;
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function humanizeType(type) {
  const text = String(type || '').trim().toLowerCase().replace(/_/g, ' ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Ação registrada';
}

function presentationFor(type) {
  const canonical = canonicalActionType(type);
  const configured = ACTION_PRESENTATION[canonical];
  return {
    tipo_canonico: canonical,
    nome: configured?.nome || humanizeType(canonical),
    categoria: configured?.categoria || 'outras',
    secundaria: Boolean(configured?.secundaria),
  };
}

function finiteMoney(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function valueFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const source = metadata.parametros && typeof metadata.parametros === 'object'
    ? metadata.parametros
    : metadata;
  for (const key of [
    'valor', 'valor_pago', 'valor_pagamento', 'valor_adicionado',
    'valor_despesa', 'capital_adicionado', 'total_pago',
  ]) {
    const value = finiteMoney(source[key]);
    if (value != null) return value;
  }
  return null;
}

function clientNameFromSnapshot(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 4) return null;
  if (!Array.isArray(data)) {
    if (data.cliente && typeof data.cliente === 'object' && data.cliente.nome) {
      return String(data.cliente.nome);
    }
    if (data.cliente_nome) return String(data.cliente_nome);
  }
  const values = Array.isArray(data) ? data : Object.values(data);
  for (const value of values) {
    const found = clientNameFromSnapshot(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function actionView(row, snapshotRows = []) {
  const presentation = presentationFor(row.tipo);
  const metadata = parseJson(row.metadata_json);
  let clienteNome = row.cliente_nome || null;
  if (!clienteNome) {
    for (const snapshot of snapshotRows) {
      clienteNome = clientNameFromSnapshot(parseJson(snapshot.dados_json));
      if (clienteNome) break;
    }
  }
  return {
    acao_uid: row.acao_uid,
    tipo: row.tipo,
    ...presentation,
    created_at: row.created_at,
    status: row.status,
    status_nome: STATUS_LABELS[row.status] || humanizeType(row.status),
    resumo: row.resumo || presentation.nome,
    origem: row.origem,
    cliente: row.cliente_id == null && !clienteNome
      ? null
      : { nome: clienteNome, disponivel: Boolean(row.cliente_nome) },
    emprestimo: row.emprestimo_id == null
      ? null
      : {
          referencia: `Empréstimo #${row.emprestimo_id}`,
          valor: finiteMoney(row.emprestimo_valor),
          disponivel: row.emprestimo_valor != null,
        },
    valor: valueFromMetadata(metadata),
  };
}

function categorySql(category, params) {
  if (!category || category === 'todas') return null;
  const configured = CATEGORY_TYPES[category];
  if (!configured) throw inputError('Filtro de categoria inválido.');
  const compatible = [...new Set(configured.flatMap((type) => compatibleActionTypes(type)))];
  params.push(...compatible);
  return `a.tipo IN (${compatible.map(() => '?').join(', ')})`;
}

async function listActionHistory(query = {}, { dbHandle } = {}) {
  if (!dbHandle) throw Object.assign(new Error('dbHandle é obrigatório.'), { code: 'DB_REQUIRED' });
  const page = positiveInteger(query.page, 1);
  const limit = positiveInteger(query.limit, 20, { max: 50 });
  const search = normalizeSearch(query.search);
  const params = [];
  const where = [];
  const categoryClause = categorySql(String(query.category || 'todas').trim().toLowerCase(), params);
  if (categoryClause) where.push(categoryClause);
  if (search) {
    const term = `%${search.toLocaleLowerCase('pt-BR')}%`;
    where.push(`(
      lower(COALESCE(c.nome, '')) LIKE ?
      OR lower(COALESCE(a.tipo, '')) LIKE ?
      OR lower(COALESCE(a.resumo, '')) LIKE ?
    )`);
    params.push(term, term, term);
  }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const joins = `
    LEFT JOIN clientes c ON c.id = a.cliente_id
    LEFT JOIN emprestimos e ON e.id = a.emprestimo_id`;
  const totalRow = await getAsync(
    dbHandle,
    `SELECT COUNT(*) AS total FROM acoes a${joins}${whereSql}`,
    params
  );
  const offset = (page - 1) * limit;
  const rows = await allAsync(
    dbHandle,
    `SELECT a.*, c.nome AS cliente_nome,
      COALESCE(e.valor_atual, e.valor_emprestado, e.valor) AS emprestimo_valor
     FROM acoes a${joins}${whereSql}
     ORDER BY a.created_at DESC, a.origin_device_id ASC, a.origin_sequence DESC, a.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const snapshotsByAction = new Map();
  if (rows.length) {
    const ids = rows.map((row) => Number(row.id));
    const snapshots = await allAsync(
      dbHandle,
      `SELECT acao_id, dados_json FROM acao_snapshots
       WHERE acao_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id ASC`,
      ids
    );
    for (const snapshot of snapshots) {
      const list = snapshotsByAction.get(Number(snapshot.acao_id)) || [];
      list.push(snapshot);
      snapshotsByAction.set(Number(snapshot.acao_id), list);
    }
  }
  const total = Number(totalRow?.total || 0);
  return {
    items: rows.map((row) => actionView(row, snapshotsByAction.get(Number(row.id)) || [])),
    pagination: {
      page,
      limit,
      total,
      total_pages: total === 0 ? 0 : Math.ceil(total / limit),
      has_more: offset + rows.length < total,
    },
  };
}

async function getActionHistoryDetail(actionUid, { dbHandle } = {}) {
  if (!dbHandle) throw Object.assign(new Error('dbHandle é obrigatório.'), { code: 'DB_REQUIRED' });
  const uid = String(actionUid || '').trim();
  if (!uid || uid.length > 100) throw inputError('Identificador da ação inválido.');
  const row = await getAsync(
    dbHandle,
    `SELECT a.*, c.nome AS cliente_nome,
      COALESCE(e.valor_atual, e.valor_emprestado, e.valor) AS emprestimo_valor
     FROM acoes a
     LEFT JOIN clientes c ON c.id = a.cliente_id
     LEFT JOIN emprestimos e ON e.id = a.emprestimo_id
     WHERE a.acao_uid = ?`,
    [uid]
  );
  if (!row) return null;
  const [entities, snapshotRows] = await Promise.all([
    allAsync(
      dbHandle,
      'SELECT entidade, entidade_uid, papel FROM acao_entidades WHERE acao_id = ? ORDER BY id ASC',
      [row.id]
    ),
    allAsync(
      dbHandle,
      `SELECT momento, entidade, dados_json
       FROM acao_snapshots WHERE acao_id = ? ORDER BY id ASC`,
      [row.id]
    ),
  ]);
  return {
    ...actionView(row, snapshotRows),
    metadata: parseJson(row.metadata_json),
    entidades: entities,
    snapshots: snapshotRows.map((snapshot) => ({
      momento: snapshot.momento,
      entidade: snapshot.entidade,
      dados: parseJson(snapshot.dados_json),
    })),
  };
}

module.exports = {
  ACTION_PRESENTATION,
  CATEGORY_TYPES,
  presentationFor,
  listActionHistory,
  getActionHistoryDetail,
};
