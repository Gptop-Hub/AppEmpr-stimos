function normalizeStatus(value) {
  const raw = String(value || 'todos').trim().toLowerCase();
  if (raw === 'vencidas' || raw === 'vencendo' || raw === 'todos') return raw;
  return 'todos';
}

function buildCobrancaWhereAndParams({
  status = 'todos',
  de,
  ate,
  hoje,
  incluirPagas = false,
  clienteId = null,
  clienteNome = '',
} = {}) {
  const filters = [];
  const params = [];

  if (!incluirPagas) {
    filters.push('bp.is_paga_defensiva = 0');
  }

  if (status === 'vencidas') {
    filters.push('DATE(bp.vencimento) < DATE(?)');
    params.push(hoje);
  } else if (status === 'vencendo') {
    filters.push('DATE(bp.vencimento) BETWEEN DATE(?) AND DATE(?)');
    params.push(de, ate);
  } else {
    filters.push('(DATE(bp.vencimento) < DATE(?) OR DATE(bp.vencimento) BETWEEN DATE(?) AND DATE(?))');
    params.push(hoje, de, ate);
  }

  if (Number.isFinite(Number(clienteId)) && Number(clienteId) > 0) {
    filters.push('CAST(bp.cliente_id AS TEXT) LIKE ?');
    params.push(`${Math.trunc(Number(clienteId))}%`);
  }

  const clienteNomeFinal = String(clienteNome || '').trim().toLowerCase();
  if (clienteNomeFinal) {
    filters.push('LOWER(COALESCE(bp.cliente_nome, \'\')) LIKE ?');
    params.push(`${clienteNomeFinal}%`);
  }

  return {
    whereSql: filters.length ? filters.join(' AND ') : '1=1',
    whereParams: params,
    status: normalizeStatus(status),
  };
}

function buildCobrancaCountSql({ baseCte, whereSql }) {
  return `
    ${baseCte}
    SELECT COUNT(1) AS total
    FROM base_parcelas bp
    WHERE ${whereSql}
  `;
}

function buildCobrancaDataSql({
  baseCte,
  whereSql,
  hasTelefone = false,
  hasParcelaObservacao = false,
  paginated = true,
} = {}) {
  const telefoneExpr = hasTelefone ? 'c.telefone' : 'NULL';
  const observacaoExpr = hasParcelaObservacao ? 'p.observacao' : 'NULL';

  return `
    ${baseCte}
    SELECT
      bp.parcela_id,
      bp.emprestimo_id,
      bp.cliente_id,
      bp.cliente_nome,
      ${telefoneExpr} AS telefone,
      bp.numero AS parcela_numero,
      bp.vencimento,
      COALESCE(bp.valor_total, 0) AS valor_total,
      CASE
        WHEN DATE(bp.vencimento) < DATE(?)
          THEN CAST(julianday(DATE(?)) - julianday(DATE(bp.vencimento)) AS INTEGER)
        ELSE 0
      END AS dias_em_atraso,
      ${observacaoExpr} AS observacao
    FROM base_parcelas bp
    LEFT JOIN clientes c ON c.id = bp.cliente_id
    LEFT JOIN parcelas p ON p.id = bp.parcela_id
    WHERE ${whereSql}
    ORDER BY
      dias_em_atraso DESC,
      DATE(bp.vencimento) ASC,
      bp.cliente_nome COLLATE NOCASE ASC,
      bp.emprestimo_id ASC,
      COALESCE(bp.numero, 0) ASC,
      bp.parcela_id ASC
    ${paginated ? 'LIMIT ? OFFSET ?' : ''}
  `;
}

module.exports = {
  normalizeStatus,
  buildCobrancaWhereAndParams,
  buildCobrancaCountSql,
  buildCobrancaDataSql,
};
