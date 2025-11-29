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

async function carregarHistoricosRenegociacao(emprestimoId, pagamentos = []) {
  const historicos = await allAsync(
    `SELECT versao, created_at, snapshot_parcelas, snapshot_emprestimo
       FROM renegociacoes_historico
      WHERE emprestimo_id = ?
   ORDER BY versao ASC`,
    [emprestimoId]
  );

  return (historicos || []).map((row, index) => {
    let snapshotEmprestimo = null;
    if (row && row.snapshot_emprestimo) {
      try {
        snapshotEmprestimo = JSON.parse(row.snapshot_emprestimo);
      } catch {
        snapshotEmprestimo = null;
      }
    }

    const { parcelas, capitalRestanteVisual, valorContratoSnapshot } = buildHistoricoParcelas(
      emprestimoId,
      row && row.snapshot_parcelas,
      pagamentos
    );

    const capitalVisualFromSnapshot =
      snapshotEmprestimo && snapshotEmprestimo.capital_restante != null
        ? toNumberSafe(snapshotEmprestimo.capital_restante)
        : capitalRestanteVisual;

    const baseSnapshot = snapshotEmprestimo || {};
    const valorContratoVisual =
      valorContratoSnapshot && valorContratoSnapshot > 0
        ? valorContratoSnapshot
        : pickPrimeiroNumero(
            baseSnapshot.valor_emprestado,
            baseSnapshot.valor,
            baseSnapshot.valor_atual,
            baseSnapshot.capital_restante
          );

    return {
      versao: row?.versao ?? null,
      criado_em: row?.created_at || null,
      snapshot_emprestimo: snapshotEmprestimo,
      parcelas,
      capital_restante_visual: capitalVisualFromSnapshot,
      valor_contrato_visual: valorContratoVisual,
    };
  });
}

exports.listarTodosEmprestimos = () => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT e.*, c.nome AS cliente_nome
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
            const ultimaRenegociacaoParcelas =
              historicosReneg.length > 0
                ? historicosReneg[historicosReneg.length - 1].parcelas
                : [];

            const hoje = new Date();
            const meses = calcularMesesDeDiferenca(e.data, hoje);

            const atuais = Array.isArray(parcelas) ? parcelas : [];

            e.parcelasDetalhes = [...atuais, ...ultimaRenegociacaoParcelas];
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
    db.get('SELECT * FROM emprestimos WHERE id = ?', [id], async (err, emprestimo) => {
      if (err) return reject(err);
      if (!emprestimo) return resolve(null);

      try {
        const { parcelas, pagamentos, parcelasOriginais } = await getParcelasData(emprestimo.id);

        const historicosReneg = await carregarHistoricosRenegociacao(
          emprestimo.id,
          pagamentos
        );
        const ultimaRenegociacaoParcelas =
          historicosReneg.length > 0
            ? historicosReneg[historicosReneg.length - 1].parcelas
            : [];

        const atuais = Array.isArray(parcelas) ? parcelas : [];

        emprestimo.parcelasDetalhes = [...atuais, ...ultimaRenegociacaoParcelas];
        emprestimo.parcelasOriginais = parcelasOriginais || [];
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
        emprestimo.total_pago = 0;
        emprestimo.capital_restante = Number(valorAtual.toFixed(2));
        emprestimo.renegociacoesHistorico = [];

        emprestimo.valor_emprestado =
          emprestimo.valor_emprestado != null ? emprestimo.valor_emprestado : valorAtual;
        emprestimo.valor_atual = valorAtual;
        emprestimo.valor = valorAtual;

        resolve(emprestimo);
      }
    });
  });
};

exports.listarEmprestimosQuitados = () => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT e.*, c.nome AS cliente_nome
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
            const ultimaRenegociacaoParcelas =
              historicosReneg.length > 0
                ? historicosReneg[historicosReneg.length - 1].parcelas
                : [];

            const atuais = Array.isArray(parcelas) ? parcelas : [];

            e.parcelasDetalhes = [...atuais, ...ultimaRenegociacaoParcelas];
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
