function buildVersionFilter(parcelAlias, emprestimoAlias, parcelasCols, emprestimosCols) {
  if (parcelasCols.has('versao') && emprestimosCols.has('versao_atual')) {
    return `(${parcelAlias}.versao = ${emprestimoAlias}.versao_atual OR ${parcelAlias}.versao IS NULL)`;
  }
  return '1=1';
}

function buildLatestParcelaFilter(parcelasCols, emprestimosCols) {
  if (!parcelasCols.has('numero')) return '1=1';

  const versionFilterP2 = buildVersionFilter('p2', 'e', parcelasCols, emprestimosCols);
  return `
    p.id = (
      SELECT MAX(p2.id)
      FROM parcelas p2
      WHERE p2.emprestimo_id = p.emprestimo_id
        AND (
          p2.numero = p.numero
          OR (p2.numero IS NULL AND p.numero IS NULL)
        )
        AND ${versionFilterP2}
    )
  `;
}

function buildParcelasSqlParts(parcelasCols, emprestimosCols, clientesCols) {
  const has = (set, col) => set.has(col);

  const numeroExpr = has(parcelasCols, 'numero') ? 'p.numero' : 'NULL';
  const vencimentoExpr = has(parcelasCols, 'vencimento') ? 'p.vencimento' : 'NULL';
  const valorTotalExpr = has(parcelasCols, 'valor_total') ? 'COALESCE(p.valor_total, 0)' : '0';
  const valorCapitalExpr = has(parcelasCols, 'valor_capital') ? 'COALESCE(p.valor_capital, 0)' : '0';
  const valorJurosExpr = has(parcelasCols, 'valor_juros') ? 'COALESCE(p.valor_juros, 0)' : '0';
  const jurosAdExpr = has(parcelasCols, 'juros_adicionais') ? 'COALESCE(p.juros_adicionais, 0)' : '0';
  const jurosPendExpr = has(parcelasCols, 'juros_pendentes') ? 'COALESCE(p.juros_pendentes, 0)' : '0';
  const valorPagoExpr = has(parcelasCols, 'valor_pago') ? 'COALESCE(p.valor_pago, 0)' : '0';
  const pagoFlagExpr = has(parcelasCols, 'pago') ? 'COALESCE(p.pago, 0)' : '0';
  const versaoExpr = has(parcelasCols, 'versao') ? 'p.versao' : 'NULL';

  const clienteNomeExpr = has(clientesCols, 'nome') ? 'c.nome' : 'NULL';
  const modalidadeExpr = has(emprestimosCols, 'modalidade') ? 'e.modalidade' : 'NULL';
  const diaPagamentoExpr = has(emprestimosCols, 'dia_pagamento')
    ? 'e.dia_pagamento'
    : 'NULL';
  const valorEmprestadoExpr = has(emprestimosCols, 'valor_emprestado')
    ? 'e.valor_emprestado'
    : has(emprestimosCols, 'valor')
      ? 'e.valor'
      : 'NULL';
  const valorAtualExpr = has(emprestimosCols, 'valor_atual')
    ? 'e.valor_atual'
    : has(emprestimosCols, 'valor')
      ? 'e.valor'
      : 'NULL';

  const baseCapitalJurosExpr = `(${valorCapitalExpr} + ${valorJurosExpr})`;
  const totalDevidoExpr = has(parcelasCols, 'valor_total')
    ? `
      (
        CASE
          WHEN COALESCE(p.valor_total, 0) > 0
            THEN COALESCE(p.valor_total, 0) + ${jurosAdExpr}
          ELSE ${baseCapitalJurosExpr} + ${jurosAdExpr} + ${jurosPendExpr}
        END
      )
    `
    : `(${baseCapitalJurosExpr} + ${jurosAdExpr} + ${jurosPendExpr})`;

  const isPagaExpr = `((${pagoFlagExpr} = 1) OR (${valorPagoExpr} >= ${totalDevidoExpr}))`;
  const versionFilter = buildVersionFilter('p', 'e', parcelasCols, emprestimosCols);
  const latestFilter = buildLatestParcelaFilter(parcelasCols, emprestimosCols);
  const numeroOperacionalFilter = has(parcelasCols, 'numero') ? '(p.numero IS NULL OR p.numero != -1)' : '1=1';

  const baseCte = `
    WITH base_parcelas AS (
      SELECT
        p.id AS parcela_id,
        p.emprestimo_id AS emprestimo_id,
        e.cliente_id AS cliente_id,
        ${clienteNomeExpr} AS cliente_nome,
        ${numeroExpr} AS numero,
        ${vencimentoExpr} AS vencimento,
        ${valorTotalExpr} AS valor_total,
        ${valorCapitalExpr} AS valor_capital,
        ${valorJurosExpr} AS valor_juros,
        ${jurosAdExpr} AS juros_adicionais,
        ${jurosPendExpr} AS juros_pendentes,
        ${valorPagoExpr} AS valor_pago,
        ${pagoFlagExpr} AS pago_flag,
        ${totalDevidoExpr} AS total_devido_calculado,
        CASE WHEN ${isPagaExpr} THEN 1 ELSE 0 END AS is_paga_defensiva,
        ${modalidadeExpr} AS modalidade,
        ${diaPagamentoExpr} AS dia_pagamento,
        ${valorEmprestadoExpr} AS valor_emprestado,
        ${valorAtualExpr} AS valor_atual,
        ${versaoExpr} AS versao
      FROM parcelas p
      JOIN emprestimos e
        ON e.id = p.emprestimo_id
      LEFT JOIN clientes c
        ON c.id = e.cliente_id
      WHERE ${numeroOperacionalFilter}
        AND ${versionFilter}
        AND ${latestFilter}
    )
  `;

  return {
    baseCte,
    hasNumero: has(parcelasCols, 'numero'),
  };
}

module.exports = {
  buildVersionFilter,
  buildLatestParcelaFilter,
  buildParcelasSqlParts,
};
