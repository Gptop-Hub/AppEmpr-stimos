const db = require('../../models/database');
const { getAsync } = require('../../utils/sqliteAsync');
const { toMoney } = require('./common/money');
const { todayLocalISO, isIsoDate } = require('./common/dateRange');
const { getRecebimentosPrevistosByRange } = require('./recebimentosPrevistosService');

function normalizeDataReferencia(dataReferencia) {
  if (isIsoDate(dataReferencia)) return dataReferencia;
  return todayLocalISO();
}

async function getResumoDiarioHome({ dataReferencia } = {}) {
  const data = normalizeDataReferencia(dataReferencia);

  const previsto = await getRecebimentosPrevistosByRange({
    de: data,
    ate: data,
    incluirAtrasados: false,
  });

  const recebidoRow = await getAsync(
    db,
    `
      SELECT
        COALESCE(SUM(COALESCE(valor_total, 0)), 0) AS total_recebido,
        COALESCE(SUM(COALESCE(valor_capital, 0)), 0) AS total_capital_recebido,
        COALESCE(SUM(COALESCE(valor_juros, 0)), 0) AS total_juros_recebido,

        COALESCE(SUM(
          CASE
            WHEN DATE(data_vencimento) = DATE(?)
              THEN COALESCE(valor_total, 0)
            ELSE 0
          END
        ), 0) AS total_recebido_parcelas_hoje,
        COALESCE(SUM(
          CASE
            WHEN DATE(data_vencimento) = DATE(?)
              THEN COALESCE(valor_capital, 0)
            ELSE 0
          END
        ), 0) AS capital_recebido_parcelas_hoje,
        COALESCE(SUM(
          CASE
            WHEN DATE(data_vencimento) = DATE(?)
              THEN COALESCE(valor_juros, 0)
            ELSE 0
          END
        ), 0) AS juros_recebido_parcelas_hoje,

        COALESCE(SUM(
          CASE
            WHEN DATE(data_vencimento) < DATE(?)
              THEN COALESCE(valor_total, 0)
            ELSE 0
          END
        ), 0) AS total_recebido_atrasado,
        COALESCE(SUM(
          CASE
            WHEN DATE(data_vencimento) < DATE(?)
              THEN COALESCE(valor_capital, 0)
            ELSE 0
          END
        ), 0) AS capital_recebido_atrasado,
        COALESCE(SUM(
          CASE
            WHEN DATE(data_vencimento) < DATE(?)
              THEN COALESCE(valor_juros, 0)
            ELSE 0
          END
        ), 0) AS juros_recebido_atrasado,

        COALESCE(SUM(
          CASE
            WHEN DATE(data_vencimento) > DATE(?)
              THEN COALESCE(valor_total, 0)
            ELSE 0
          END
        ), 0) AS total_recebido_antecipado,
        COALESCE(SUM(
          CASE
            WHEN DATE(data_vencimento) > DATE(?)
              THEN COALESCE(valor_capital, 0)
            ELSE 0
          END
        ), 0) AS capital_recebido_antecipado,
        COALESCE(SUM(
          CASE
            WHEN DATE(data_vencimento) > DATE(?)
              THEN COALESCE(valor_juros, 0)
            ELSE 0
          END
        ), 0) AS juros_recebido_antecipado,

        COALESCE(SUM(
          CASE
            WHEN (
              data_vencimento IS NULL OR
              TRIM(COALESCE(data_vencimento, '')) = '' OR
              DATE(data_vencimento) IS NULL
            )
              THEN COALESCE(valor_total, 0)
            ELSE 0
          END
        ), 0) AS total_recebido_nao_classificado,
        COALESCE(SUM(
          CASE
            WHEN (
              data_vencimento IS NULL OR
              TRIM(COALESCE(data_vencimento, '')) = '' OR
              DATE(data_vencimento) IS NULL
            )
              THEN COALESCE(valor_capital, 0)
            ELSE 0
          END
        ), 0) AS capital_recebido_nao_classificado,
        COALESCE(SUM(
          CASE
            WHEN (
              data_vencimento IS NULL OR
              TRIM(COALESCE(data_vencimento, '')) = '' OR
              DATE(data_vencimento) IS NULL
            )
              THEN COALESCE(valor_juros, 0)
            ELSE 0
          END
        ), 0) AS juros_recebido_nao_classificado
      FROM caixa_movimentos
      WHERE DATE(data) = DATE(?)
        AND UPPER(COALESCE(tipo, '')) = 'ENTRADA'
        AND UPPER(COALESCE(categoria, '')) = 'PAGAMENTO'
    `,
    [
      data,
      data,
      data,
      data,
      data,
      data,
      data,
      data,
      data,
      data,
    ]
  );

  return {
    success: true,
    data,
    previstoHoje: {
      total: toMoney(previsto.periodo.total),
      capital: toMoney(previsto.periodo.capital),
      juros: toMoney(previsto.periodo.juros),
    },
    recebidoHoje: {
      total: toMoney(recebidoRow?.total_recebido),
      capital: toMoney(recebidoRow?.total_capital_recebido),
      juros: toMoney(recebidoRow?.total_juros_recebido),
    },
    recebidoHojeClassificado: {
      parcelasHoje: {
        total: toMoney(recebidoRow?.total_recebido_parcelas_hoje),
        capital: toMoney(recebidoRow?.capital_recebido_parcelas_hoje),
        juros: toMoney(recebidoRow?.juros_recebido_parcelas_hoje),
      },
      atrasados: {
        total: toMoney(recebidoRow?.total_recebido_atrasado),
        capital: toMoney(recebidoRow?.capital_recebido_atrasado),
        juros: toMoney(recebidoRow?.juros_recebido_atrasado),
      },
      antecipado: {
        total: toMoney(recebidoRow?.total_recebido_antecipado),
        capital: toMoney(recebidoRow?.capital_recebido_antecipado),
        juros: toMoney(recebidoRow?.juros_recebido_antecipado),
      },
      naoClassificado: {
        total: toMoney(recebidoRow?.total_recebido_nao_classificado),
        capital: toMoney(recebidoRow?.capital_recebido_nao_classificado),
        juros: toMoney(recebidoRow?.juros_recebido_nao_classificado),
      },
    },
  };
}

module.exports = {
  getResumoDiarioHome,
};
