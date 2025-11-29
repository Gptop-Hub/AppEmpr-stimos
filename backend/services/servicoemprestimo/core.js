const db = require('../../models/database');

function toNumberSafe(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isNaN(v) ? 0 : v;
  let s = String(v).trim();
  if (s === '') return 0;
  if (s.indexOf(',') > -1 && s.indexOf('.') > -1) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    if (s.indexOf(',') > -1 && s.indexOf('.') === -1) s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}

function isPaidFlag(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true';
}

function calcularCapitalPagoAPartirDeParcelas(parcelas = [], parcelasOriginais = []) {
  return (parcelas || []).reduce((soma, p) => {
    const valorPago = toNumberSafe(p.valor_pago);
    const numero = p.numero != null ? Number(p.numero) : null;
    let orig = null;
    if (Array.isArray(parcelasOriginais) && numero != null) {
      orig = parcelasOriginais.find((o) => Number(o.numero) === numero) || null;
    }
    if (!orig && Array.isArray(parcelasOriginais)) {
      orig = parcelasOriginais.find((o) => Number(o.id) === Number(p.id)) || null;
    }

    const originalValorCapital = toNumberSafe(
      orig && orig.valor_capital != null ? orig.valor_capital : p.valor_capital
    );
    const originalValorJuros = toNumberSafe(
      orig && orig.valor_juros != null ? orig.valor_juros : p.valor_juros
    );

    if (isPaidFlag(p.pago)) {
      return soma + originalValorCapital;
    }

    if (valorPago > 0) {
      const capitalPagoParcial = Math.max(0, valorPago - originalValorJuros);
      return soma + Math.min(capitalPagoParcial, originalValorCapital);
    }

    return soma;
  }, 0);
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function getValorAtualFromRow(e) {
  if (!e) return 0;
  if (e.valor_atual != null) return toNumberSafe(e.valor_atual);
  return toNumberSafe(e.valor);
}

function calcularCapitalRestanteSomandoCapitais(parcelasAtuais = []) {
  return (parcelasAtuais || []).reduce((soma, p) => {
    if (!p) return soma;
    if (p.renegociada) return soma;
    if (Number(p.numero) === -1) return soma;
    if (p.pago === 1 || p.pago === true) return soma;

    const vc = toNumberSafe(p.valor_capital);
    return soma + Math.max(0, vc);
  }, 0);
}

function calcularCapitalRestanteComRegra(emprestimoRow, parcelasAtuais = []) {
  const atuais = Array.isArray(parcelasAtuais) ? parcelasAtuais : [];

  const capitalFromParcelas = calcularCapitalRestanteSomandoCapitais(atuais);

  const temPagamentoNasAtuais = (atuais || []).some((p) => {
    if (!p) return false;
    if (p.pago === 1 || p.pago === true) return true;
    const vp = toNumberSafe(p.valor_pago);
    return vp > 0;
  });

  let capitalRestanteRaw;

  if (!temPagamentoNasAtuais) {
    let base = null;
    if (emprestimoRow.capital_restante != null && emprestimoRow.capital_restante !== undefined) {
      base = toNumberSafe(emprestimoRow.capital_restante);
    } else if (emprestimoRow.valor_atual != null && emprestimoRow.valor_atual !== undefined) {
      base = toNumberSafe(emprestimoRow.valor_atual);
    } else if (emprestimoRow.valor != null && emprestimoRow.valor !== undefined) {
      base = toNumberSafe(emprestimoRow.valor);
    }

    if (base != null) {
      capitalRestanteRaw = base;
    } else {
      capitalRestanteRaw = capitalFromParcelas;
    }
  } else {
    capitalRestanteRaw = capitalFromParcelas;
  }

  const capitalRestanteFinal = Math.max(
    0,
    Number(
      typeof capitalRestanteRaw.toFixed === 'function'
        ? capitalRestanteRaw.toFixed(2)
        : capitalRestanteRaw
    )
  );
  return Number(Number(capitalRestanteFinal).toFixed(2));
}

function buildHistoricoParcelas(emprestimoId, snapshotJson, pagamentos = []) {
  if (!snapshotJson) {
    return { parcelas: [], capitalRestanteVisual: 0 };
  }

  const num = (v) => toNumberSafe(v);

  try {
    const parsed = JSON.parse(snapshotJson || '[]') || [];

    const historico = parsed.map((p, idx) => {
      const parcelaId = p.id != null ? p.id : null;
      const numero = p.numero != null ? Number(p.numero) : idx + 1;

      const valorCapital = Math.max(
        0,
        num(
          p.estrutura_valor_capital != null ? p.estrutura_valor_capital : p.valor_capital
        )
      );
      const valorJuros = Math.max(
        0,
        num(
          p.estrutura_valor_juros != null ? p.estrutura_valor_juros : p.valor_juros
        )
      );
      const valorTotal = Number((valorCapital + valorJuros).toFixed(2));

      const valorPagoSnapshot = num(p.valor_pago);

      const pagoFlag = valorTotal > 0 && valorPagoSnapshot >= valorTotal ? 1 : 0;

      return {
        id:
          parcelaId != null
            ? parcelaId
            : `hist_${emprestimoId}_${numero}_${idx}`,
        parcela_id: parcelaId,
        numero,

        valor_total: valorTotal,
        valor_capital: valorCapital,
        valor_juros: valorJuros,

        valor_pago: valorPagoSnapshot,

        valor_pago_snapshot: valorPagoSnapshot,

        valor_excedente: num(p.valor_excedente),

        pago: pagoFlag,
        vencimento: p.vencimento || null,
        data_pagamento: p.data_pagamento || null,

        renegociada: 1,
        explicacao: p.explicacao || "Parcela antiga (renegociada)",

        observacao: p.observacao || "",
        juros_adicionais: num(p.juros_adicionais),
        tipo_pagamento: p.tipo_pagamento || null,
        valor_com_desconto:
          p.valor_com_desconto != null ? num(p.valor_com_desconto) : undefined,
        valor_original:
          p.valor_original != null ? num(p.valor_original) : undefined,
      };
    });

    const pagamentosPorNumero = {};
    (pagamentos || []).forEach((pg) => {
      if (!pg) return;
      const valor = num(pg.valor);
      if (valor <= 0) return;
      let numero = null;
      if (pg.parcela_origem != null) {
        numero = Number(pg.parcela_origem);
      } else if (pg.parcela_numero != null) {
        numero = Number(pg.parcela_numero);
      }
      if (!Number.isFinite(numero)) return;
      if (!pagamentosPorNumero[numero]) pagamentosPorNumero[numero] = 0;
      pagamentosPorNumero[numero] = num(pagamentosPorNumero[numero] + valor);
    });

    historico.forEach((parcela) => {
      if (!parcela) return;
      const numero = Number(parcela.numero);
      const soma = Number.isFinite(numero) ? pagamentosPorNumero[numero] : undefined;
      if (soma != null && soma > 0) {
        const visual = num(soma);
        parcela.valor_pago = visual;
        parcela.valor_pago_visual = visual;
      } else {
        parcela.valor_pago_visual = parcela.valor_pago_snapshot;
        parcela.valor_pago = parcela.valor_pago_snapshot;
      }
    });

    const capitalRestanteVisual = historico.reduce((acc, parcela) => {
      if (!parcela) return acc;
      const valorTotal = toNumberSafe(parcela.valor_total);
      const pagoSnapshot = toNumberSafe(parcela.valor_pago_snapshot);
      const capitalAtual = Math.max(0, toNumberSafe(parcela.valor_capital));
      const quitada = valorTotal > 0 && pagoSnapshot >= valorTotal;
      return quitada ? acc : acc + capitalAtual;
    }, 0);

    const valorContratoSnapshot = historico.reduce((acc, parcela) => {
      if (!parcela) return acc;
      const capital = Math.max(0, toNumberSafe(parcela.valor_capital));
      return acc + capital;
    }, 0);

    return {
      parcelas: historico,
      capitalRestanteVisual: Number(capitalRestanteVisual.toFixed(2)),
      valorContratoSnapshot: Number(valorContratoSnapshot.toFixed(2)),
    };
  } catch (e) {
    console.error("Erro ao parsear snapshot_parcelas:", e);
    return { parcelas: [], capitalRestanteVisual: 0, valorContratoSnapshot: 0 };
  }
}

function isLoanFinalizedInternal(emp) {
  if (!emp) return false;
  if (emp.quitado === true) return true;
  if (typeof emp.capital_restante === 'number' && emp.capital_restante <= 0) return true;

  const parcelas = emp.parcelasDetalhes || emp.parcelas || [];
  const relevantes = (parcelas || []).filter(
    (p) => p && !p.renegociada && Number(p.numero) !== -1
  );
  if (relevantes.length === 0) return false;

  return relevantes.every((p) => {
    if (p.pago === true || p.pago === 1) return true;
    const valorPago = toNumberSafe(p.valor_pago);
    const valorTotal = toNumberSafe(p.valor_total || p.valor_com_desconto || 0);
    if (valorTotal > 0 && valorPago >= valorTotal) return true;
    return false;
  });
}

module.exports = {
  db,
  toNumberSafe,
  isPaidFlag,
  calcularCapitalPagoAPartirDeParcelas,
  allAsync,
  getAsync,
  getValorAtualFromRow,
  calcularCapitalRestanteSomandoCapitais,
  calcularCapitalRestanteComRegra,
  buildHistoricoParcelas,
  isLoanFinalizedInternal,
};
