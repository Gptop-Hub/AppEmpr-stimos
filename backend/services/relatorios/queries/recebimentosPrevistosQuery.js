function parseIsoDateUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function getDiasPagamentoCorrespondentes(de, ate) {
  const inicio = parseIsoDateUtc(de);
  const fim = parseIsoDateUtc(ate);
  if (!inicio || !fim || inicio > fim) return [];

  const umDiaMs = 24 * 60 * 60 * 1000;
  const quantidadeDias = Math.floor((fim - inicio) / umDiaMs) + 1;
  if (quantidadeDias >= 31) {
    return Array.from({ length: 31 }, (_, index) => index + 1);
  }

  const dias = new Set();
  for (let cursorMs = inicio.getTime(); cursorMs <= fim.getTime(); cursorMs += umDiaMs) {
    const cursor = new Date(cursorMs);
    const dia = cursor.getUTCDate();
    const ultimoDiaDoMes = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)
    ).getUTCDate();

    dias.add(dia);
    if (dia === ultimoDiaDoMes) {
      for (let diaContratual = dia + 1; diaContratual <= 31; diaContratual += 1) {
        dias.add(diaContratual);
      }
    }
  }

  return [...dias].sort((left, right) => left - right);
}

function buildRecebimentosPrevistosSql({ baseCte, diasPagamentoCorrespondentes = [] } = {}) {
  if (!baseCte) {
    throw new Error('baseCte e obrigatoria para calcular recebimentos previstos.');
  }

  const dias = [...new Set(diasPagamentoCorrespondentes)]
    .map(Number)
    .filter((dia) => Number.isInteger(dia) && dia >= 1 && dia <= 31);
  const filtroDiaPagamento = dias.length
    ? `COALESCE(
        NULLIF(CAST(dia_pagamento AS INTEGER), 0),
        CAST(strftime('%d', vencimento) AS INTEGER)
      ) IN (${dias.map(() => '?').join(', ')})`
    : '0 = 1';

  return `
    ${baseCte},
    parcelas_classificadas AS (
      SELECT
        *,
        CASE
          WHEN DATE(vencimento) BETWEEN DATE(?) AND DATE(?) THEN 'PERIODO'
          WHEN is_paga_defensiva = 0
            AND DATE(vencimento) < DATE(?)
            AND ${filtroDiaPagamento}
            THEN 'ATRASADO'
          ELSE NULL
        END AS faixa_previsao
      FROM base_parcelas
    )
    SELECT
      COALESCE(SUM(CASE
        WHEN faixa_previsao = 'PERIODO' THEN COALESCE(total_devido_calculado, 0)
        ELSE 0
      END), 0) AS periodo_total,
      COALESCE(SUM(CASE
        WHEN faixa_previsao = 'PERIODO' THEN COALESCE(valor_capital, 0)
        ELSE 0
      END), 0) AS periodo_capital,
      COALESCE(SUM(CASE
        WHEN faixa_previsao = 'PERIODO' THEN (
          COALESCE(valor_juros, 0) +
          COALESCE(juros_adicionais, 0) +
          COALESCE(juros_pendentes, 0)
        )
        ELSE 0
      END), 0) AS periodo_juros,
      COALESCE(SUM(CASE
        WHEN faixa_previsao = 'ATRASADO' THEN COALESCE(total_devido_calculado, 0)
        ELSE 0
      END), 0) AS atrasados_total,
      COALESCE(SUM(CASE
        WHEN faixa_previsao = 'ATRASADO' THEN COALESCE(valor_capital, 0)
        ELSE 0
      END), 0) AS atrasados_capital,
      COALESCE(SUM(CASE
        WHEN faixa_previsao = 'ATRASADO' THEN (
          COALESCE(valor_juros, 0) +
          COALESCE(juros_adicionais, 0) +
          COALESCE(juros_pendentes, 0)
        )
        ELSE 0
      END), 0) AS atrasados_juros
    FROM parcelas_classificadas
  `;
}

module.exports = {
  getDiasPagamentoCorrespondentes,
  buildRecebimentosPrevistosSql,
};
