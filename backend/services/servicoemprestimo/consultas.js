const {
  db,
  toNumberSafe,
  getValorAtualFromRow,
  calcularCapitalRestanteComRegra,
  buildHistoricoParcelas,
  allAsync,
  isLoanFinalizedInternal,
} = require('./core');
const { calcularMesesDeDiferenca } = require('../dateUtils');
const { getParcelasData } = require('../parcelasService');

function pickPrimeiroNumero(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    return toNumberSafe(value);
  }
  return null;
}

function toTimestampSeguro(value) {
  if (!value) return null;

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }

  const text = String(value).trim();
  if (!text) return null;

  const iso = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2})(?::(\d{2})(?::(\d{2}))?)?)?/
  );
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]) - 1;
    const day = Number(iso[3]);
    const hour = Number(iso[4] || 0);
    const minute = Number(iso[5] || 0);
    const second = Number(iso[6] || 0);
    const dt = new Date(year, month, day, hour, minute, second);
    const time = dt.getTime();
    return Number.isNaN(time) ? null : time;
  }

  const br = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) {
    const day = Number(br[1]);
    const month = Number(br[2]) - 1;
    const year = Number(br[3]);
    const dt = new Date(year, month, day, 23, 59, 59);
    const time = dt.getTime();
    return Number.isNaN(time) ? null : time;
  }

  const parsed = new Date(text);
  const time = parsed.getTime();
  return Number.isNaN(time) ? null : time;
}

function somarPagamentos(pagamentos = []) {
  return Number(
    (pagamentos || [])
      .reduce((acc, pagamento) => acc + toNumberSafe(pagamento?.valor), 0)
      .toFixed(2)
  );
}

async function carregarHistoricosRenegociacao(emprestimoId, pagamentos = []) {
  const historicos = await allAsync(
    `SELECT id, versao, created_at, snapshot_parcelas, snapshot_emprestimo, tipo, observacao, detalhes
       FROM renegociacoes_historico
      WHERE emprestimo_id = ?
   ORDER BY versao ASC`,
    [emprestimoId]
  );

  const pagamentosLista = Array.isArray(pagamentos) ? pagamentos : [];

  return (historicos || []).map((row) => {
    let snapshotEmprestimo = null;
    if (row && row.snapshot_emprestimo) {
      try {
        snapshotEmprestimo = JSON.parse(row.snapshot_emprestimo);
      } catch {
        snapshotEmprestimo = null;
      }
    }

    let detalhes = null;
    if (row && row.detalhes) {
      try {
        detalhes = JSON.parse(row.detalhes);
      } catch {
        detalhes = row.detalhes;
      }
    }

    const dataEventoTs = toTimestampSeguro(row?.created_at);
    const pagamentosAteEvento = pagamentosLista.filter((pagamento) => {
      if (!pagamento) return false;
      if (dataEventoTs == null) return true;

      const dataPagamentoTs = toTimestampSeguro(
        pagamento?.created_at ?? pagamento?.data
      );

      if (dataPagamentoTs == null) return true;
      return dataPagamentoTs <= dataEventoTs;
    });

    const { parcelas, capitalRestanteVisual, valorContratoSnapshot } =
      buildHistoricoParcelas(
        emprestimoId,
        row && row.snapshot_parcelas,
        pagamentosAteEvento
      );

    const capitalVisualFromSnapshot =
      snapshotEmprestimo && snapshotEmprestimo.capital_restante != null
        ? toNumberSafe(snapshotEmprestimo.capital_restante)
        : capitalRestanteVisual;

    const baseSnapshot = snapshotEmprestimo || {};
    const composicaoSnapshot = Array.isArray(baseSnapshot.valor_emprestado_composicao)
      ? baseSnapshot.valor_emprestado_composicao
      : Array.isArray(baseSnapshot.composicao_valor_emprestado)
        ? baseSnapshot.composicao_valor_emprestado
        : Array.isArray(baseSnapshot.valor_emprestado_partes)
          ? baseSnapshot.valor_emprestado_partes
          : [];
    const composicaoNormalizada = composicaoSnapshot
      .map((value) => toNumberSafe(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    const valorComposicao = composicaoNormalizada.length
      ? Number(
          composicaoNormalizada
            .reduce((acc, value) => acc + toNumberSafe(value), 0)
            .toFixed(2)
        )
      : null;

    const valorContratoVisual =
      valorContratoSnapshot && valorContratoSnapshot > 0
        ? valorContratoSnapshot
        : pickPrimeiroNumero(
            baseSnapshot.valor_emprestado_epoca,
            baseSnapshot.valor_emprestado_total,
            valorComposicao,
            baseSnapshot.valor,
            baseSnapshot.valor_atual,
            baseSnapshot.capital_restante,
            baseSnapshot.valor_emprestado
          );

    const totalPagoSnapshot = (parcelas || []).reduce((acc, parcela) => {
      if (!parcela) return acc;
      const pago = toNumberSafe(
        parcela.valor_pago_snapshot ?? parcela.valor_pago
      );
      return acc + (pago || 0);
    }, 0);
    const totalPagoPagamentos = somarPagamentos(pagamentosAteEvento);
    const totalPagoEpoca = Number(
      Math.max(totalPagoSnapshot, totalPagoPagamentos).toFixed(2)
    );

    const snapshotEmprestimoFinal =
      snapshotEmprestimo && typeof snapshotEmprestimo === 'object'
        ? { ...snapshotEmprestimo }
        : {};

    if (snapshotEmprestimoFinal.total_pago == null) {
      snapshotEmprestimoFinal.total_pago = totalPagoEpoca;
    }
    if (
      snapshotEmprestimoFinal.capital_restante == null &&
      capitalVisualFromSnapshot != null
    ) {
        snapshotEmprestimoFinal.capital_restante = capitalVisualFromSnapshot;
    }

    if (
      snapshotEmprestimoFinal.valor_emprestado_base == null &&
      composicaoNormalizada.length
    ) {
      snapshotEmprestimoFinal.valor_emprestado_base = composicaoNormalizada[0];
    }
    if (
      (!Array.isArray(snapshotEmprestimoFinal.valor_emprestado_composicao) ||
        !snapshotEmprestimoFinal.valor_emprestado_composicao.length) &&
      composicaoNormalizada.length
    ) {
      snapshotEmprestimoFinal.valor_emprestado_composicao = composicaoNormalizada;
    }

    const valorEmprestadoEpoca = pickPrimeiroNumero(
      snapshotEmprestimoFinal.valor_emprestado_epoca,
      snapshotEmprestimoFinal.valor_emprestado_total,
      valorComposicao,
      valorContratoVisual,
      snapshotEmprestimoFinal.valor_emprestado,
      snapshotEmprestimoFinal.valor,
      snapshotEmprestimoFinal.valor_atual,
      snapshotEmprestimoFinal.capital_restante
    );
    if (valorEmprestadoEpoca != null) {
      snapshotEmprestimoFinal.valor_emprestado_epoca = valorEmprestadoEpoca;
      snapshotEmprestimoFinal.valor_emprestado = valorEmprestadoEpoca;
    }

    return {
      id: row?.id ?? null,
      versao: row?.versao ?? null,
      created_at: row?.created_at || null,
      criado_em: row?.created_at || null,
      snapshot_emprestimo: snapshotEmprestimoFinal,
      parcelas,
      capital_restante_visual: capitalVisualFromSnapshot,
      valor_contrato_visual: valorContratoVisual,
      tipo: row?.tipo || null,
      observacao: row?.observacao || null,
      detalhes,
    };
  });
}

exports.listarTodosEmprestimos = () => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT e.*, c.nome AS cliente_nome, COALESCE(c.mal_pagador, 0) AS cliente_mal_pagador
       FROM emprestimos e
       JOIN clientes c ON c.id = e.cliente_id`,
      (err, emprestimos) => {
        if (err) return reject(err);

        const emprestimosComParcelas = [];

        const carregarParcelas = async (index) => {
          if (index >= emprestimos.length) return resolve(emprestimosComParcelas);
          const e = emprestimos[index];

          try {
            const { parcelas, pagamentos, parcelasOriginais } = await getParcelasData(e.id);

            const historicosReneg = await carregarHistoricosRenegociacao(e.id, pagamentos);
            const hoje = new Date();
            const meses = calcularMesesDeDiferenca(e.data, hoje);

            const atuais = Array.isArray(parcelas)
              ? parcelas.map((p) => ({
                  ...p,
                  emprestimo_id: p.emprestimo_id ?? e.id,
                  origem: p.origem || 'atual',
                }))
              : [];

            e.parcelasDetalhes = [...atuais];
            e.parcelasOriginais = parcelasOriginais || [];
            e.meses_passados = meses;

            const valorAtual = getValorAtualFromRow(e);

            e.valor_com_juros = Number(
              (valorAtual * Math.pow(1 + (toNumberSafe(e.taxa_juros) || 0) / 100, meses)).toFixed(2)
            );
            e.total_pago = (pagamentos || []).reduce(
              (soma, p) => soma + toNumberSafe(p.valor),
              0
            );
            e.pagamentos = pagamentos || [];
            e.renegociacoesHistorico = historicosReneg;

            e.capital_restante = calcularCapitalRestanteComRegra(e, atuais);

            e.valor_emprestado = e.valor_emprestado != null ? e.valor_emprestado : valorAtual;
            e.valor_atual = valorAtual;
            e.valor = valorAtual;

            emprestimosComParcelas.push(e);
            carregarParcelas(index + 1);
          } catch (errParcelas) {
            console.error('Erro ao obter parcelas para emprestimo', e.id, errParcelas);

            const valorAtual = getValorAtualFromRow(e);

            e.parcelasDetalhes = [];
            e.parcelasOriginais = [];
            e.meses_passados = 0;
            e.valor_com_juros = Number(valorAtual || 0);
            e.total_pago = 0;
            e.pagamentos = [];
            e.capital_restante = Number(valorAtual.toFixed(2));
            e.renegociacoesHistorico = [];

            e.valor_emprestado = e.valor_emprestado != null ? e.valor_emprestado : valorAtual;
            e.valor_atual = valorAtual;
            e.valor = valorAtual;

            emprestimosComParcelas.push(e);
            carregarParcelas(index + 1);
          }
        };

        carregarParcelas(0);
      }
    );
  });
};

exports.buscarEmprestimoPorId = (id) => {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT e.*, c.nome AS cliente_nome, COALESCE(c.mal_pagador, 0) AS cliente_mal_pagador
         FROM emprestimos e
         LEFT JOIN clientes c ON c.id = e.cliente_id
        WHERE e.id = ?`,
      [id],
      async (err, emprestimo) => {
      if (err) return reject(err);
      if (!emprestimo) return resolve(null);

      try {
        const { parcelas, pagamentos, parcelasOriginais } = await getParcelasData(emprestimo.id);

        const historicosReneg = await carregarHistoricosRenegociacao(
          emprestimo.id,
          pagamentos
        );
        const atuais = Array.isArray(parcelas) ? parcelas : [];

        emprestimo.parcelasDetalhes = [...atuais];
        emprestimo.parcelasOriginais = parcelasOriginais || [];
        emprestimo.pagamentos = pagamentos || [];
        emprestimo.total_pago = (pagamentos || []).reduce(
          (s, p) => s + toNumberSafe(p.valor),
          0
        );
        emprestimo.renegociacoesHistorico = historicosReneg;

        const valorAtual = getValorAtualFromRow(emprestimo);

        emprestimo.capital_restante = calcularCapitalRestanteComRegra(emprestimo, atuais);

        emprestimo.valor_emprestado =
          emprestimo.valor_emprestado != null ? emprestimo.valor_emprestado : valorAtual;
        emprestimo.valor_atual = valorAtual;
        emprestimo.valor = valorAtual;

        resolve(emprestimo);
      } catch (errParcelas) {
        console.error('Erro getParcelasData (buscarPorId):', errParcelas);

        const valorAtual = getValorAtualFromRow(emprestimo);

        emprestimo.parcelasDetalhes = [];
        emprestimo.parcelasOriginais = [];
        emprestimo.pagamentos = [];
        emprestimo.total_pago = 0;
        emprestimo.capital_restante = Number(valorAtual.toFixed(2));
        emprestimo.renegociacoesHistorico = [];

        emprestimo.valor_emprestado =
          emprestimo.valor_emprestado != null ? emprestimo.valor_emprestado : valorAtual;
        emprestimo.valor_atual = valorAtual;
        emprestimo.valor = valorAtual;

        resolve(emprestimo);
      }
      }
    );
  });
};

exports.listarEmprestimosQuitados = () => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT e.*, c.nome AS cliente_nome, COALESCE(c.mal_pagador, 0) AS cliente_mal_pagador
       FROM emprestimos e
       JOIN clientes c ON c.id = e.cliente_id`,
      (err, emprestimos) => {
        if (err) return reject(err);

        const result = [];
        let i = 0;

        const carregar = async () => {
          if (i >= emprestimos.length) return resolve(result);
          const e = emprestimos[i];

          try {
            const { parcelas, pagamentos, parcelasOriginais } = await getParcelasData(e.id);

            const historicosReneg = await carregarHistoricosRenegociacao(e.id, pagamentos);
            const atuais = Array.isArray(parcelas) ? parcelas : [];

            e.parcelasDetalhes = [...atuais];
            e.parcelasOriginais = parcelasOriginais || [];
            e.pagamentos = pagamentos || [];
            e.total_pago = (pagamentos || []).reduce(
              (s, p) => s + toNumberSafe(p.valor),
              0
            );
            e.renegociacoesHistorico = historicosReneg;

            const valorAtual = getValorAtualFromRow(e);

            e.capital_restante = calcularCapitalRestanteComRegra(e, atuais);

            e.valor_emprestado =
              e.valor_emprestado != null ? e.valor_emprestado : valorAtual;
            e.valor_atual = valorAtual;
            e.valor = valorAtual;

            if (isLoanFinalizedInternal(e)) {
              result.push(e);
            }

            i++;
            carregar();
          } catch (errParcelas) {
            console.error('Erro getParcelasData (quitados) emprestimo', e.id, errParcelas);

            const valorAtual = getValorAtualFromRow(e);

            e.parcelasDetalhes = [];
            e.parcelasOriginais = [];
            e.pagamentos = [];
            e.total_pago = 0;
            e.capital_restante = Number(valorAtual.toFixed(2));
            e.renegociacoesHistorico = [];

            e.valor_emprestado =
              e.valor_emprestado != null ? e.valor_emprestado : valorAtual;
            e.valor_atual = valorAtual;
            e.valor = valorAtual;

            if (isLoanFinalizedInternal(e)) {
              result.push(e);
            }

            i++;
            carregar();
          }
        };

        carregar();
      }
    );
  });
};
