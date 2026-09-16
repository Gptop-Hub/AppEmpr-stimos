const db = require('../models/database');

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

const f2 = (n) => Number(Number(n || 0).toFixed(2));

// nomes de meses em português, para texto "12 Janeiro 2026"
const mesesPt = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

function formatISOToExtenso(iso) {
  try {
    if (!iso) return '';
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y || !m || !d) return iso;
    const dt = new Date(y, m - 1, d);
    if (isNaN(dt.getTime())) return iso;
    const dd = String(dt.getDate()).padStart(2, '0');
    const mmName = mesesPt[dt.getMonth()];
    const yyyy = dt.getFullYear();
    return `${dd} ${mmName} ${yyyy}`;
  } catch {
    return iso;
  }
}

/**
 * Soma 1 m??s a uma data ISO (YYYY-MM-DD) usando dia fixo.
 * Se o dia n??o existir no m??s alvo, usa o ??ltimo dia do m??s.
 */
function addOneMonthISO(dateStr, fixedDay) {
  if (!dateStr) return dateStr;

  try {
    const [y, m] = String(dateStr).split('-').map(Number);
    if (!y || !m) return dateStr;

    const base = new Date(y, m - 1, 1);
    if (isNaN(base.getTime())) return dateStr;

    const targetYear =
      base.getFullYear() + Math.floor((base.getMonth() + 1) / 12);
    const targetMonth = (base.getMonth() + 1) % 12;
    const day = Number.isFinite(fixedDay) ? fixedDay : 1;

    let candidate = new Date(targetYear, targetMonth, day);
    if (candidate.getMonth() !== ((targetMonth + 12) % 12)) {
      const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
      candidate = new Date(targetYear, targetMonth, lastDay);
    }

    const yy = candidate.getFullYear();
    const mm = String(candidate.getMonth() + 1).padStart(2, '0');
    const dd = String(candidate.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  } catch {
    return dateStr;
  }
}

async function getFixedDayFromOriginais(emprestimoId) {
  if (emprestimoId == null) return null;
  const cols = await allAsync('PRAGMA table_info(parcelas_originais)', []);
  const names = (cols || []).map((c) => c.name);
  const dateCol = names.includes('vencimento')
    ? 'vencimento'
    : names.includes('data_vencimento')
    ? 'data_vencimento'
    : null;
  if (!dateCol) return null;

  const row = await getAsync(
    `SELECT ${dateCol} AS vencimento
       FROM parcelas_originais
      WHERE emprestimo_id = ?
      ORDER BY numero ASC, id ASC
      LIMIT 1`,
    [emprestimoId]
  );
  if (!row || !row.vencimento) return null;
  const parts = String(row.vencimento).split('-').map(Number);
  if (parts.length >= 3 && Number.isFinite(parts[2])) {
    const d = parts[2];
    return d >= 1 && d <= 31 ? d : null;
  }
  const dt = new Date(row.vencimento);
  if (isNaN(dt.getTime())) return null;
  return dt.getDate();
}

async function getFixedDay(emprestimoId, parcelas = []) {
  if (emprestimoId != null) {
    try {
      const row = await getAsync(
        'SELECT dia_pagamento FROM emprestimos WHERE id = ?',
        [emprestimoId]
      );
      const dia = Number(row && row.dia_pagamento);
      if (Number.isFinite(dia) && dia >= 1 && dia <= 31) return dia;
    } catch {
      // fallback abaixo
    }
  }

  try {
    const dOrig = await getFixedDayFromOriginais(emprestimoId);
    if (Number.isFinite(dOrig)) return dOrig;
  } catch {
    // fallback abaixo
  }

  const primeira = parcelas.find((p) => p && p.vencimento);
  if (primeira && primeira.vencimento) {
    const parts = String(primeira.vencimento).split('-').map(Number);
    if (parts.length >= 3 && Number.isFinite(parts[2])) {
      const d = parts[2];
      if (d >= 1 && d <= 31) return d;
    }
    const dt = new Date(primeira.vencimento);
    if (!isNaN(dt.getTime())) return dt.getDate();
  }

  return null;
}

/**
 * Descobre automaticamente qual coluna de data de vencimento existe na tabela parcelas.
 * Prioriza "data_vencimento", se não existir usa "vencimento".
 * Se não achar nenhuma, retorna null (e o ajuste de datas é ignorado).
 */
async function getParcelasDateColumn() {
  const cols = await allAsync(`PRAGMA table_info(parcelas)`, []);
  const names = cols.map((c) => c.name);

  if (names.includes('data_vencimento')) return 'data_vencimento';
  if (names.includes('vencimento')) return 'vencimento';

  return null;
}

module.exports = async function pagarJurosParcial(
  emprestimoId,
  valorPagamento,
  dataPagamentoISO,
  observacaoParcela = ''
) {
  if (!emprestimoId) throw new Error('emprestimoId inválido');

  const valor = f2(valorPagamento || 0);
  if (valor <= 0) throw new Error('Valor de pagamento inválido');

  await runAsync('BEGIN');

  try {
    // 1 — pegar primeira parcela aberta
    const parcela = await getAsync(
      `SELECT p.* FROM parcelas p
       JOIN emprestimos e ON e.id = p.emprestimo_id
       WHERE p.emprestimo_id = ?
         AND (p.versao IS NULL OR p.versao = e.versao_atual)
         AND (p.pago IS NULL OR p.pago = 0)
       ORDER BY p.numero ASC
       LIMIT 1`,
      [emprestimoId]
    );

    if (!parcela) throw new Error('Nenhuma parcela aberta para juros parcial.');

    const id = parcela.id;
    const numeroParcelaBase = parcela.numero || 1;

    const jurosBase = f2(parcela.valor_juros || 0);              // juros do mês
    const jurosPendAntigo = f2(parcela.juros_pendentes || 0);   // juros pendentes já acumulados
    const jurosAdicAtual = f2(parcela.juros_adicionais || 0);   // juros adicionais do mês
    const capitalAtual = f2(parcela.valor_capital || 0);

    // total de juros devidos (mês + adicionais anteriores)
    const jurosTotalAntes = f2(jurosBase + jurosPendAntigo + jurosAdicAtual);

    if (valor >= jurosTotalAntes)
      throw new Error('Valor não é juros parcial (>= juros totais da parcela).');

    // 2 — repartir o pagamento:
    //     primeiro nos adicionais, depois nos pendentes, depois nos juros do mês
    let restante = valor;

    const pagoAdic = Math.min(restante, jurosAdicAtual);
    restante = f2(restante - pagoAdic);
    let adicDepois = f2(jurosAdicAtual - pagoAdic);

    const pagoPend = Math.min(restante, jurosPendAntigo);
    restante = f2(restante - pagoPend);
    let pendDepois = f2(jurosPendAntigo - pagoPend);

    const pagoBase = Math.min(restante, jurosBase);
    restante = f2(restante - pagoBase); // deve chegar bem perto de 0

    const faltaBase = f2(jurosBase - pagoBase);

    // juros pendentes (inclui adicionais remanescentes + pendentes antigos + base não paga)
    const jurosPendentes = f2(adicDepois + pendDepois + faltaBase);

    const jurosPagos = valor;
    const novoValorJuros = jurosBase;          // mantém juros do mês
    const novoJurosAdicional = 0;
    const novoValorTotal = f2(capitalAtual + novoValorJuros + jurosPendentes);

    const dataFormatada = (() => {
      try {
        if (!dataPagamentoISO) return formatISOToExtenso(new Date().toISOString().slice(0, 10));
        const iso = String(dataPagamentoISO).slice(0, 10);
        return formatISOToExtenso(iso);
      } catch {
        return formatISOToExtenso(new Date().toISOString().slice(0, 10));
      }
    })();

    // 🔵 TEXTO BEM DIFERENTE do pagamento de juros cheio
    const explic = `⏳ O cliente pagou R$ ${jurosPagos.toFixed(
      2
    )} de juros na data de ${dataFormatada}. Os juros eram de R$ ${jurosTotalAntes.toFixed(
      2
    )}. O restante de R$ ${jurosPendentes.toFixed(
      2
    )} foi somado aos juros pendentes desta parcela.`;

    // 3 — atualizar a primeira parcela aberta com os novos juros
    await runAsync(
      `UPDATE parcelas
         SET valor_juros = ?,
             juros_pendentes = ?,
             juros_adicionais = 0,
             valor_total = ?,
             pago = 0,
             data_pagamento = NULL,
             tipo_pagamento = 'manual_juros_parcial',
             explicacao = CASE 
                 WHEN explicacao IS NULL OR explicacao = '' THEN ?
                 ELSE explicacao || '\n' || ?
             END
       WHERE id = ?`,
      [
        novoValorJuros,
        jurosPendentes,
        novoValorTotal,
        explic,
        explic,
        id
      ]
    );

    // 4 — empurrar o vencimento de TODAS as parcelas abertas em +1 mês
    //     E registrar explicação para aparecer no "Mais informações ▼"
    const dateCol = await getParcelasDateColumn();

    if (dateCol) {
      const fixedDay = await getFixedDay(emprestimoId, [parcela]);
      const abertasParaAdiantar = await allAsync(
        `SELECT p.id, p.${dateCol} AS data_vencimento, p.explicacao 
           FROM parcelas p
           JOIN emprestimos e ON e.id = p.emprestimo_id
          WHERE p.emprestimo_id = ?
            AND (p.versao IS NULL OR p.versao = e.versao_atual)
            AND (p.pago IS NULL OR p.pago = 0)
          ORDER BY p.numero ASC`,
        [emprestimoId]
      );

      for (const p of abertasParaAdiantar) {
        const dataAntigaISO = p.data_vencimento;
        const novaDataISO = addOneMonthISO(dataAntigaISO, fixedDay);

        let novaExplicacao = p.explicacao || '';

        if (dataAntigaISO && novaDataISO && dataAntigaISO !== novaDataISO) {
          const vencOriginalStr = formatISOToExtenso(dataAntigaISO);
          const novaVencStr = formatISOToExtenso(novaDataISO);

          // 🔵 TEXTO DIFERENTE DO JUROS CHEIO
          const linhaExtra =
            `⏳ Vencimento reagendado de ${vencOriginalStr} para ${novaVencStr} ` +
            `porque houve um PAGAMENTO PARCIAL de juros na parcela ${numeroParcelaBase} ` +
            `(juros não pagos foram adicionados como juros pendentes).`;

          novaExplicacao = novaExplicacao
            ? `${novaExplicacao}\n${linhaExtra}`
            : linhaExtra;
        }

        await runAsync(
          `UPDATE parcelas
             SET ${dateCol} = ?, 
                 explicacao = ?
           WHERE id = ?`,
          [novaDataISO, novaExplicacao, p.id]
        );
      }
    }

    // 5 — recalcular capital_restante do empréstimo
    const abertas = await allAsync(
      `SELECT p.valor_capital FROM parcelas p
       JOIN emprestimos e ON e.id = p.emprestimo_id
       WHERE p.emprestimo_id = ?
         AND (p.versao IS NULL OR p.versao = e.versao_atual)
         AND (p.pago IS NULL OR p.pago = 0)`,
      [emprestimoId]
    );

    const novoCapitalRestante = f2(
      abertas.reduce((s, p) => s + f2(p.valor_capital), 0)
    );

    await runAsync(
      `UPDATE emprestimos SET capital_restante = ? WHERE id = ?`,
      [novoCapitalRestante, emprestimoId]
    );

    await runAsync('COMMIT');

    return {
      ok: true,
      parcelaAtualizada: {
        id,
        valor_juros: novoValorJuros,
        juros_pendentes: jurosPendentes,
        juros_adicionais: 0,
        valor_total: novoValorTotal,
        capital: capitalAtual,
        juros_pagados: jurosPagos
      }
    };
  } catch (e) {
    try { await runAsync('ROLLBACK'); } catch {}
    throw e;
  }
};
