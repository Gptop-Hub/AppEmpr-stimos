const db = require('../models/database');
const { toISO, toExtenso, calcularMesesDeDiferenca } = require('../services/dateUtils');
const { touchAtividade } = require('../utils/touchAtividade');

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function f2(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function hojeLocalISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function parseISODateOrNull(value) {
  const iso = toISO(value);
  return iso || null;
}

function isParcelaQuitada(parcela) {
  if (!parcela) return false;
  const pagoFlag =
    parcela.pago === 1 || parcela.pago === '1' || parcela.pago === true;
  if (pagoFlag) return true;
  const valorTotal = f2(parcela.valor_total || 0);
  const valorPago = f2(parcela.valor_pago || 0);
  if (valorTotal > 0 && valorPago >= valorTotal - 0.009) return true;
  return false;
}

function hasRecalculoAtrasoMarker(parcela) {
  if (!parcela) return false;
  const txt = String(parcela.explicacao || '');
  return /recalculo de atraso aplicado/i.test(txt);
}

function parseDateStart(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const dt = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function addMonthsKeepingDay(iso, monthsToAdd) {
  const base = parseDateStart(iso);
  if (!base) return null;
  const add = Number(monthsToAdd || 0);
  if (!Number.isFinite(add)) return null;

  const day = base.getDate();
  const targetMonthIndex = base.getMonth() + add;
  const targetYear = base.getFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayOfMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const finalDay = Math.min(day, lastDayOfMonth);

  const yy = String(targetYear).padStart(4, '0');
  const mm = String(targetMonth + 1).padStart(2, '0');
  const dd = String(finalDay).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function formatMesAnoLabel(iso) {
  const dt = parseDateStart(iso);
  if (!dt) return String(iso || '-');
  const raw = dt.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : String(iso || '-');
}

function isSameMonthISO(dateA, dateB) {
  const a = String(dateA || '').slice(0, 7);
  const b = String(dateB || '').slice(0, 7);
  return /^\d{4}-\d{2}$/.test(a) && a === b;
}

function splitTotalByPeriods(total, periods) {
  const p = Number(periods || 0);
  if (!Number.isFinite(p) || p <= 0) return [];
  const totalSafe = f2(Math.max(0, Number(total || 0)));
  if (p === 1) return [totalSafe];
  const unit = f2(totalSafe / p);
  const values = Array.from({ length: p }, () => unit);
  const partial = f2(unit * (p - 1));
  values[p - 1] = f2(totalSafe - partial);
  return values;
}

function buildPeriodBreakdown({
  periodoInicio,
  periodosDetectados,
  jurosReferenciaMensal,
  valorTotalAtribuir,
}) {
  const count = Number(periodosDetectados || 0);
  if (!periodoInicio || !Number.isFinite(count) || count <= 0) return [];

  const mensal = f2(Number(jurosReferenciaMensal || 0));
  const targetTotal = f2(Math.max(0, Number(valorTotalAtribuir || 0)));
  let valores = [];

  if (count === 1) {
    valores = [targetTotal];
  } else if (mensal > 0) {
    valores = Array.from({ length: count }, () => mensal);
    const totalBase = f2(mensal * count);
    const diff = f2(targetTotal - totalBase);
    valores[count - 1] = f2(valores[count - 1] + diff);
    if (valores[count - 1] < 0) {
      valores = splitTotalByPeriods(targetTotal, count);
    }
  } else {
    valores = splitTotalByPeriods(targetTotal, count);
  }

  return valores.map((valor, idx) => {
    const periodoISO = addMonthsKeepingDay(periodoInicio, idx) || periodoInicio;
    return {
      periodo: periodoISO,
      label: formatMesAnoLabel(periodoISO),
      valor: f2(valor),
    };
  });
}

function isVencida(vencimentoISO, dataBaseISO) {
  const venc = parseDateStart(vencimentoISO);
  const base = parseDateStart(dataBaseISO);
  if (!venc || !base) return false;
  return venc.getTime() < base.getTime();
}

function formatMoedaBRL(value) {
  return Number(value || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function escolherParcelasAtuais(rows = []) {
  // Pode existir mais de uma linha para o mesmo numero: fica a de maior id.
  const ordered = [...rows].sort((a, b) => {
    const numA = Number(a?.numero ?? 0);
    const numB = Number(b?.numero ?? 0);
    if (numA !== numB) return numA - numB;
    return Number(b?.id || 0) - Number(a?.id || 0);
  });
  const chosen = [];
  const seen = new Set();
  for (const row of ordered) {
    const key =
      row && row.numero != null ? `num:${row.numero}` : `id:${row?.id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.push(row);
  }
  return chosen.sort((a, b) => {
    const numA = Number(a?.numero ?? 0);
    const numB = Number(b?.numero ?? 0);
    if (numA !== numB) return numA - numB;
    return Number(a?.id || 0) - Number(b?.id || 0);
  });
}

async function carregarContextoAtraso(emprestimoId, dataBaseISO) {
  const emprestimo = await getAsync(
    `
    SELECT id, cliente_id, versao_atual
      FROM emprestimos
     WHERE id = ?
    `,
    [emprestimoId]
  );

  if (!emprestimo) {
    const err = new Error('Emprestimo nao encontrado.');
    err.code = 'LOAN_NOT_FOUND';
    throw err;
  }

  const rows = await allAsync(
    `
    SELECT p.id, p.emprestimo_id, p.numero, p.vencimento, p.pago, p.valor_pago,
           p.valor_total, p.valor_juros, p.juros_pendentes, p.explicacao, p.versao
      FROM parcelas p
      JOIN emprestimos e ON e.id = p.emprestimo_id
     WHERE p.emprestimo_id = ?
       AND (p.numero IS NULL OR p.numero != -1)
       AND (p.versao IS NULL OR p.versao = e.versao_atual)
     ORDER BY p.numero ASC, p.id DESC
    `,
    [emprestimoId]
  );

  const parcelasAtuais = escolherParcelasAtuais(rows);
  const parcelasAbertas = parcelasAtuais.filter((p) => !isParcelaQuitada(p));
  const parcelaDestino = parcelasAbertas.length > 0 ? parcelasAbertas[0] : null;
  const recalculoJaAplicadoNaParcelaDestino =
    parcelaDestino ? hasRecalculoAtrasoMarker(parcelaDestino) : false;

  const vencidasEmAberto = parcelasAbertas.filter((p) =>
    isVencida(p.vencimento, dataBaseISO)
  );

  const periodosEncontrados = vencidasEmAberto.length;
  const periodoInicio =
    periodosEncontrados > 0
      ? String(vencidasEmAberto[0].vencimento || '').slice(0, 10)
      : null;
  let periodoFim =
    periodosEncontrados > 0
      ? String(vencidasEmAberto[periodosEncontrados - 1].vencimento || '').slice(0, 10)
      : null;

  let periodosDetectados = periodosEncontrados;
  if (periodosEncontrados === 1 && periodoInicio) {
    const mesesDecorridos = Number(calcularMesesDeDiferenca(periodoInicio, dataBaseISO) || 0);
    if (Number.isFinite(mesesDecorridos) && mesesDecorridos > 0) {
      periodosDetectados = Math.max(periodosDetectados, mesesDecorridos + 1);
      periodoFim = addMonthsKeepingDay(periodoInicio, periodosDetectados - 1) || periodoFim;
    }
  }

  // Avança o cronograma até a primeira data NÃO vencida (desatrasar contrato).
  const mesesAjusteDatas =
    periodosDetectados > 0 ? Math.max(0, periodosDetectados) : 0;

  const jurosReferenciaMensal = parcelaDestino
    ? f2(parcelaDestino.valor_juros || 0)
    : 0;
  const valorSugerido = f2(jurosReferenciaMensal * periodosDetectados);
  const detalhamentoSugerido = buildPeriodBreakdown({
    periodoInicio,
    periodosDetectados,
    jurosReferenciaMensal,
    valorTotalAtribuir: valorSugerido,
  });

  let pagosNoPeriodo = 0;
  if (periodosDetectados > 0 && periodoInicio) {
    const rowPagos = await getAsync(
      `
      SELECT COALESCE(SUM(valor), 0) AS total
        FROM pagamentos
       WHERE emprestimo_id = ?
         AND DATE(data) >= DATE(?)
         AND DATE(data) <= DATE(?)
      `,
      [emprestimoId, periodoInicio, dataBaseISO]
    );
    pagosNoPeriodo = f2(rowPagos?.total || 0);
  }

  return {
    emprestimo,
    parcelaDestino,
    periodosDetectados,
    vencidasEmAberto,
    periodoInicio,
    periodoFim,
    jurosReferenciaMensal,
    valorSugerido,
    detalhamentoSugerido,
    pagosNoPeriodo,
    dataBaseISO,
    mesesAjusteDatas,
    recalculoJaAplicadoNaParcelaDestino,
  };
}

exports.preview = async (req, res) => {
  const emprestimoId = Number(req.params.id || 0);
  if (!emprestimoId) {
    return res.status(400).json({ success: false, error: 'ID de emprestimo invalido.' });
  }

  const dataBaseISO =
    parseISODateOrNull(req.body?.data_base || req.query?.data_base) || hojeLocalISO();

  try {
    const ctx = await carregarContextoAtraso(emprestimoId, dataBaseISO);
    if (!ctx.parcelaDestino) {
      return res.status(409).json({
        success: false,
        error: 'Nenhuma parcela aberta no cronograma atual.',
      });
    }

    return res.json({
      success: true,
      tem_atraso:
        ctx.periodosDetectados > 0 &&
        !ctx.recalculoJaAplicadoNaParcelaDestino,
      recalculo_ja_aplicado: !!ctx.recalculoJaAplicadoNaParcelaDestino,
      data_base: dataBaseISO,
      periodos_detectados: ctx.periodosDetectados,
      periodo_inicio: ctx.periodoInicio,
      periodo_fim: ctx.periodoFim,
      valor_sugerido: ctx.valorSugerido,
      juros_referencia_mensal: ctx.jurosReferenciaMensal,
      detalhamento_periodos: ctx.detalhamentoSugerido,
      pagos_registrados_periodo: ctx.pagosNoPeriodo,
      meses_ajuste_datas: Number(ctx.mesesAjusteDatas || 0),
      parcela_destino: {
        id: Number(ctx.parcelaDestino.id),
        numero: Number(ctx.parcelaDestino.numero || 0),
        vencimento: ctx.parcelaDestino.vencimento || null,
        vencimento_ajustado:
          (ctx.mesesAjusteDatas || 0) > 0
            ? addMonthsKeepingDay(ctx.parcelaDestino.vencimento, ctx.mesesAjusteDatas)
            : ctx.parcelaDestino.vencimento || null,
      },
    });
  } catch (err) {
    console.error('[recalculo-atraso/preview] erro:', err);
    if (err && err.code === 'LOAN_NOT_FOUND') {
      return res.status(404).json({ success: false, error: err.message });
    }
    return res.status(500).json({
      success: false,
      error: err?.message || 'Erro ao simular recalculo de atraso.',
    });
  }
};

exports.aplicar = async (req, res) => {
  const emprestimoId = Number(req.params.id || 0);
  if (!emprestimoId) {
    return res.status(400).json({ success: false, error: 'ID de emprestimo invalido.' });
  }

  const valorFinal = f2(req.body?.valor_final);
  const descontoInformado = f2(req.body?.desconto_informado);
  const descontoInformadoPositivo = f2(Math.max(0, descontoInformado));
  const descontoPeriodoBody = parseISODateOrNull(req.body?.desconto_periodo);
  const descontoAlocacoesBody = Array.isArray(req.body?.desconto_alocacoes)
    ? req.body.desconto_alocacoes
    : [];
  const dataBaseISO =
    parseISODateOrNull(req.body?.data_base || req.query?.data_base) || hojeLocalISO();
  const parcelaDestinoReq = Number(req.body?.parcela_destino_id || 0) || null;

  if (!(valorFinal > 0)) {
    return res.status(400).json({
      success: false,
      error: 'Informe um valor final maior que zero para aplicar em juros pendentes.',
    });
  }

  let inTx = false;
  try {
    const ctx = await carregarContextoAtraso(emprestimoId, dataBaseISO);

    if (!ctx.parcelaDestino) {
      return res.status(409).json({
        success: false,
        error: 'Nenhuma parcela aberta no cronograma atual.',
      });
    }

    if (ctx.recalculoJaAplicadoNaParcelaDestino) {
      return res.status(409).json({
        success: false,
        error:
          'Este recalculo ja foi aplicado na parcela atual. Para evitar duplicidade, pague/avance a parcela antes de recalcular novamente.',
      });
    }

    if (ctx.periodosDetectados <= 0) {
      return res.status(409).json({
        success: false,
        error: 'Nao ha parcelas vencidas em aberto para recalcular atraso.',
      });
    }

    const descontoMaximoPermitido = f2(ctx.valorSugerido || 0);
    if (descontoInformadoPositivo > descontoMaximoPermitido + 0.01) {
      return res.status(400).json({
        success: false,
        error: `Desconto informado nao pode ser maior que os juros pendentes do recalculo (${formatMoedaBRL(descontoMaximoPermitido)}).`,
      });
    }

    if (
      parcelaDestinoReq &&
      Number(ctx.parcelaDestino.id) !== Number(parcelaDestinoReq)
    ) {
      return res.status(409).json({
        success: false,
        error: 'A parcela de destino mudou. Atualize a simulacao antes de aplicar.',
      });
    }

    const parcelaAtual = await getAsync(
      `
      SELECT p.id, p.emprestimo_id, p.numero, p.vencimento, p.pago, p.valor_pago,
             p.valor_total, p.juros_pendentes, p.explicacao
        FROM parcelas p
        JOIN emprestimos e ON e.id = p.emprestimo_id
       WHERE p.id = ?
         AND p.emprestimo_id = ?
         AND (p.versao IS NULL OR p.versao = e.versao_atual)
      `,
      [ctx.parcelaDestino.id, emprestimoId]
    );

    if (!parcelaAtual) {
      return res.status(404).json({
        success: false,
        error: 'Parcela de destino nao encontrada no cronograma atual.',
      });
    }

    if (isParcelaQuitada(parcelaAtual)) {
      return res.status(409).json({
        success: false,
        error: 'A parcela de destino ja esta quitada.',
      });
    }

    const jurosPendentesAntes = f2(parcelaAtual.juros_pendentes || 0);
    const valorTotalAntes = f2(parcelaAtual.valor_total || 0);
    const jurosPendentesDepois = f2(jurosPendentesAntes + valorFinal);
    const valorTotalDepois = f2(valorTotalAntes + valorFinal);
    const vencimentoAntes = String(parcelaAtual.vencimento || '').slice(0, 10) || null;
    const periodosDetalhadosBrutos = buildPeriodBreakdown({
      periodoInicio: ctx.periodoInicio,
      periodosDetectados: ctx.periodosDetectados,
      jurosReferenciaMensal: ctx.jurosReferenciaMensal,
      valorTotalAtribuir: ctx.valorSugerido,
    });
    const periodosDetalhadosLiquidos = buildPeriodBreakdown({
      periodoInicio: ctx.periodoInicio,
      periodosDetectados: ctx.periodosDetectados,
      jurosReferenciaMensal: ctx.jurosReferenciaMensal,
      valorTotalAtribuir: valorFinal,
    });
    const periodoInfoMap = new Map(
      periodosDetalhadosBrutos.map((item) => [
        String(item?.periodo || '').slice(0, 10),
        item,
      ])
    );
    const descontoAlocacoesAgrupadas = new Map();
    if (descontoInformadoPositivo > 0) {
      if (descontoAlocacoesBody.length > 0) {
        for (const item of descontoAlocacoesBody) {
          const periodoISO = parseISODateOrNull(item?.periodo);
          const valorItem = f2(item?.valor);
          const dataPagamentoItem = parseISODateOrNull(
            item?.data_pagamento || item?.data
          );
          if (!periodoISO || !(valorItem > 0)) continue;
          if (!periodoInfoMap.has(periodoISO)) {
            return res.status(400).json({
              success: false,
              error: 'Mes de desconto invalido para os periodos detectados no recalculo.',
            });
          }
          if (!dataPagamentoItem || !isSameMonthISO(dataPagamentoItem, periodoISO)) {
            return res.status(400).json({
              success: false,
              error: 'Data do desconto deve estar dentro do mes selecionado.',
            });
          }
          const atual = descontoAlocacoesAgrupadas.get(periodoISO);
          if (atual && String(atual?.data_pagamento || '') !== String(dataPagamentoItem)) {
            return res.status(400).json({
              success: false,
              error: 'Cada mes do desconto deve ter uma unica data de pagamento.',
            });
          }
          descontoAlocacoesAgrupadas.set(periodoISO, {
            valor: f2(Number(atual?.valor || 0) + valorItem),
            data_pagamento: dataPagamentoItem,
          });
        }
      } else if (descontoPeriodoBody) {
        if (!periodoInfoMap.has(descontoPeriodoBody)) {
          return res.status(400).json({
            success: false,
            error: 'Mes de desconto invalido para os periodos detectados no recalculo.',
          });
        }
        descontoAlocacoesAgrupadas.set(descontoPeriodoBody, {
          valor: descontoInformadoPositivo,
          data_pagamento: dataBaseISO,
        });
      } else {
        return res.status(400).json({
          success: false,
          error: 'Distribua o desconto informado entre os meses detectados.',
        });
      }
    }
    const descontoAlocacoes = periodosDetalhadosBrutos
      .map((item) => {
        const periodoISO = String(item?.periodo || '').slice(0, 10);
        const info = descontoAlocacoesAgrupadas.get(periodoISO);
        const valor = f2(info?.valor || 0);
        if (!(valor > 0)) return null;
        return {
          periodo: periodoISO,
          label: item?.label || formatMesAnoLabel(periodoISO),
          valor,
          data_pagamento: String(info?.data_pagamento || dataBaseISO).slice(0, 10),
        };
      })
      .filter(Boolean);
    const descontoPeriodoSelecionado =
      descontoAlocacoes.length > 0 ? descontoAlocacoes[0] : null;
    if (descontoInformadoPositivo > 0) {
      const totalAlocado = f2(
        descontoAlocacoes.reduce((sum, item) => sum + Number(item.valor || 0), 0)
      );
      if (!(totalAlocado > 0)) {
        return res.status(400).json({
          success: false,
          error: 'Distribua o desconto informado entre os meses detectados.',
        });
      }
      if (Math.abs(totalAlocado - descontoInformadoPositivo) > 0.01) {
        return res.status(400).json({
          success: false,
          error: 'A soma da distribuicao do desconto deve ser igual ao desconto informado.',
        });
      }
    }
    const usarDetalhamentoBruto = descontoInformadoPositivo > 0;
    const periodosDetalhados = usarDetalhamentoBruto
      ? periodosDetalhadosBrutos
      : periodosDetalhadosLiquidos;

    const periodoInicioTexto = ctx.periodoInicio ? toExtenso(ctx.periodoInicio) : '-';
    const periodoFimTexto = ctx.periodoFim ? toExtenso(ctx.periodoFim) : '-';
    const detalhesPeriodosTexto = periodosDetalhados.length
      ? periodosDetalhados
          .map((item) => `${item.label} = ${formatMoedaBRL(item.valor)}`)
          .join(' | ')
      : '';
    const detalhesPeriodosTotal = f2(
      periodosDetalhados.reduce((sum, item) => sum + Number(item?.valor || 0), 0)
    );
    const descontoAlocacoesTexto = descontoAlocacoes.length
      ? descontoAlocacoes
          .map((item) => {
            const dataISO = String(item?.data_pagamento || '').slice(0, 10);
            const dia = /^\d{4}-\d{2}-\d{2}$/.test(dataISO)
              ? Number(dataISO.slice(8, 10))
              : 0;
            const dataTxt = dia > 0 ? `dia ${dia}` : '-';
            return `${item.label} (${dataTxt}) = ${formatMoedaBRL(item.valor)}`;
          })
          .join(' | ')
      : '';

    const linhasTecnicas = [
      `Recalculo de atraso aplicado em ${toExtenso(dataBaseISO)}. ` +
        `Parcela ${Number(parcelaAtual.numero || 0)} era ${formatMoedaBRL(valorTotalAntes)} ` +
        `e foi para ${formatMoedaBRL(valorTotalDepois)} por juros nao pagos de ` +
        `${ctx.periodosDetectados} periodo(s), de ${periodoInicioTexto} ate ${periodoFimTexto}. ` +
        `Total acrescido: ${formatMoedaBRL(valorFinal)}.`,
    ];
    if (descontoInformadoPositivo > 0) {
      linhasTecnicas.push(
        `Desconto informado no periodo: ${formatMoedaBRL(descontoInformadoPositivo)}. ` +
          `${descontoAlocacoesTexto ? `Distribuicao: ${descontoAlocacoesTexto}. ` : ''}` +
          `Juros brutos identificados: ${formatMoedaBRL(ctx.valorSugerido)}. ` +
          `Valor liquido aplicado em juros pendentes: ${formatMoedaBRL(valorFinal)}.`
      );
    }
    if (detalhesPeriodosTexto) {
      linhasTecnicas.push(
        `Detalhamento por periodo${usarDetalhamentoBruto ? ' (juros brutos)' : ''}: ` +
          `${detalhesPeriodosTexto}. Total: ${formatMoedaBRL(detalhesPeriodosTotal)}.`
      );
    }
    if ((ctx.mesesAjusteDatas || 0) > 0) {
      linhasTecnicas.push(
        `Vencimentos do cronograma aberto foram ajustados em ${ctx.mesesAjusteDatas} mes(es).`
      );
    }

    const linhaTecnica = linhasTecnicas.join('\n');
    const explicacaoAtual = String(parcelaAtual.explicacao || '').trim();
    const explicacaoNova = explicacaoAtual
      ? `${explicacaoAtual}\n${linhaTecnica}`
      : linhaTecnica;

    let vencimentosAjustados = 0;

    await runAsync('BEGIN');
    inTx = true;

    await runAsync(
      `
      UPDATE parcelas
         SET juros_pendentes = ?,
             valor_total = ?,
             explicacao = ?
       WHERE id = ?
      `,
      [jurosPendentesDepois, valorTotalDepois, explicacaoNova, parcelaAtual.id]
    );

    if ((ctx.mesesAjusteDatas || 0) > 0) {
      const numeroDestino = Number(parcelaAtual.numero || 0);
      const rowsAjuste = await allAsync(
        `
        SELECT p.id, p.numero, p.vencimento, p.pago, p.valor_pago
          FROM parcelas p
          JOIN emprestimos e ON e.id = p.emprestimo_id
         WHERE p.emprestimo_id = ?
           AND (p.numero IS NULL OR p.numero != -1)
           AND (p.versao IS NULL OR p.versao = e.versao_atual)
           AND COALESCE(p.numero, 0) >= ?
         ORDER BY p.numero ASC, p.id DESC
        `,
        [emprestimoId, numeroDestino]
      );

      const parcelasAjuste = escolherParcelasAtuais(rowsAjuste).filter(
        (p) => !isParcelaQuitada(p)
      );

      for (const parcela of parcelasAjuste) {
        const vencOrig = String(parcela.vencimento || '').slice(0, 10);
        const vencNovo = addMonthsKeepingDay(vencOrig, ctx.mesesAjusteDatas);
        if (!vencOrig || !vencNovo || vencOrig === vencNovo) continue;
        await runAsync(
          `
          UPDATE parcelas
             SET vencimento = ?
           WHERE id = ?
          `,
          [vencNovo, parcela.id]
        );
        vencimentosAjustados += 1;
      }
    }

    const vencimentoDepois =
      (ctx.mesesAjusteDatas || 0) > 0
        ? addMonthsKeepingDay(vencimentoAntes, ctx.mesesAjusteDatas) || vencimentoAntes
        : vencimentoAntes;

    const pagamentoDescontoIds = [];
    if (descontoInformadoPositivo > 0) {
      for (const aloc of descontoAlocacoes) {
        const dataDesconto = String(aloc?.data_pagamento || dataBaseISO).slice(0, 10);
        const valorDesconto = f2(aloc?.valor || 0);
        if (!(valorDesconto > 0)) continue;
        const obsDesconto =
          `Desconto informado no recalculo de atraso. ` +
          `Mes atribuido: ${aloc?.label || '-'}.`;
        const insertPagamento = await runAsync(
          `
          INSERT INTO pagamentos (emprestimo_id, valor, data, tipo_pagamento, observacao, parcela_origem)
          VALUES (?, ?, ?, ?, ?, ?)
          `,
          [
            emprestimoId,
            valorDesconto,
            dataDesconto,
            'recalculo_atraso_desconto',
            obsDesconto,
            null,
          ]
        );
        const insertId = Number(insertPagamento?.lastID || 0) || null;
        if (insertId) pagamentoDescontoIds.push(insertId);
      }
    }

    await runAsync(
      `
      INSERT INTO recalculos_atraso (
        emprestimo_id,
        parcela_destino_id,
        periodos_detectados,
        valor_sugerido,
        desconto_informado,
        valor_aplicado,
        data_base,
        periodo_inicio,
        periodo_fim,
        detalhes_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        emprestimoId,
        parcelaAtual.id,
        Number(ctx.periodosDetectados),
        f2(ctx.valorSugerido),
        descontoInformadoPositivo,
        valorFinal,
        dataBaseISO,
        ctx.periodoInicio,
        ctx.periodoFim,
        JSON.stringify({
          desconto_informado: descontoInformadoPositivo,
          juros_referencia_mensal: f2(ctx.jurosReferenciaMensal),
          pagos_registrados_periodo: f2(ctx.pagosNoPeriodo),
          parcela_destino_numero: Number(parcelaAtual.numero || 0),
          parcela_destino_vencimento_antes: vencimentoAntes,
          parcela_destino_vencimento_depois: vencimentoDepois,
          meses_ajuste_datas: Number(ctx.mesesAjusteDatas || 0),
          vencimentos_ajustados: Number(vencimentosAjustados || 0),
          detalhamento_periodos: periodosDetalhados,
          detalhamento_periodos_bruto: periodosDetalhadosBrutos,
          detalhamento_periodos_liquido: periodosDetalhadosLiquidos,
          desconto_periodo: descontoPeriodoSelecionado
            ? String(descontoPeriodoSelecionado.periodo || '').slice(0, 10)
            : null,
          desconto_periodo_label: descontoPeriodoSelecionado?.label || null,
          desconto_alocacoes: descontoAlocacoes,
          pagamento_desconto_id: pagamentoDescontoIds.length > 0 ? pagamentoDescontoIds[0] : null,
          pagamento_desconto_ids: pagamentoDescontoIds,
          origem: 'recalcular_atraso_fase_1',
        }),
      ]
    );

    await runAsync('COMMIT');
    inTx = false;

    try {
      await touchAtividade({ emprestimoId });
    } catch (touchErr) {
      console.error('[touchAtividade] recalculo-atraso/aplicar:', touchErr);
    }

    return res.json({
      success: true,
      message: 'Recalculo de atraso aplicado em juros pendentes.',
      parcela: {
        id: Number(parcelaAtual.id),
        numero: Number(parcelaAtual.numero || 0),
        juros_pendentes_antes: jurosPendentesAntes,
        juros_pendentes_depois: jurosPendentesDepois,
        valor_total_antes: valorTotalAntes,
        valor_total_depois: valorTotalDepois,
        vencimento_antes: vencimentoAntes,
        vencimento_depois: vencimentoDepois,
      },
      resumo: {
        periodos_detectados: Number(ctx.periodosDetectados),
        valor_sugerido: f2(ctx.valorSugerido),
        desconto_informado: descontoInformadoPositivo,
        desconto_periodo: descontoPeriodoSelecionado
          ? String(descontoPeriodoSelecionado.periodo || '').slice(0, 10)
          : null,
        desconto_periodo_label: descontoPeriodoSelecionado?.label || null,
        desconto_alocacoes: descontoAlocacoes,
        valor_aplicado: valorFinal,
        data_base: dataBaseISO,
        meses_ajuste_datas: Number(ctx.mesesAjusteDatas || 0),
        vencimentos_ajustados: Number(vencimentosAjustados || 0),
      },
    });
  } catch (err) {
    if (inTx) {
      try {
        await runAsync('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
    }

    console.error('[recalculo-atraso/aplicar] erro:', err);
    if (err && err.code === 'LOAN_NOT_FOUND') {
      return res.status(404).json({ success: false, error: err.message });
    }
    return res.status(500).json({
      success: false,
      error: err?.message || 'Erro ao aplicar recalculo de atraso.',
    });
  }
};
