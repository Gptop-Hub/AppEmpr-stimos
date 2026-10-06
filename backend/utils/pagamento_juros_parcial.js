const db = require('../models/database');
const { calcularVencimento } = require('./vencimento');

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

function isCivilISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

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
 * Descobre automaticamente qual coluna de data de vencimento existe na tabela parcelas.
 * Prioriza "data_vencimento", se não existir usa "vencimento".
 * Se não achar nenhuma, retorna null (e o ajuste de datas é ignorado).
 */
async function getParcelasDateColumn(dbHandle = db) {
  const cols = await new Promise((resolve, reject) => {
    dbHandle.all('PRAGMA table_info(parcelas)', [], (err, rows) => err ? reject(err) : resolve(rows || []));
  });
  const names = cols.map((c) => c.name);

  if (names.includes('data_vencimento')) return 'data_vencimento';
  if (names.includes('vencimento')) return 'vencimento';

  return null;
}

module.exports = async function pagarJurosParcial(
  emprestimoId,
  valorPagamento,
  dataPagamentoISO,
  observacaoParcela = '',
  proximoVencimentoISO,
  { dbHandle = db, manageTransaction = true } = {}
) {
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    dbHandle.run(sql, params, function onRun(err) { return err ? reject(err) : resolve(this); });
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    dbHandle.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    dbHandle.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
  });
  if (!emprestimoId) throw new Error('emprestimoId inválido');

  const valor = f2(valorPagamento || 0);
  if (valor <= 0) throw new Error('Valor de pagamento inválido');

  if (!isCivilISODate(proximoVencimentoISO)) {
    throw new Error('Informe um próximo vencimento válido no formato YYYY-MM-DD.');
  }

  if (manageTransaction) await run('BEGIN');

  try {
    // 1 — pegar primeira parcela aberta
    const parcela = await get(
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
    await run(
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

    // 4 — persistir a data escolhida e recalcular as abertas posteriores.
    const dateCol = await getParcelasDateColumn(dbHandle);
    if (!dateCol) {
      throw new Error('Coluna de vencimento não encontrada em parcelas.');
    }

    const vencimentoAnterior = parcela.vencimento || null;
    const linhaExtra =
      `Próximo vencimento reagendado de ${formatISOToExtenso(vencimentoAnterior)} ` +
      `para ${formatISOToExtenso(proximoVencimentoISO)} porque houve um pagamento parcial ` +
      `de juros na parcela ${numeroParcelaBase}.`;

    // A data civil confirmada na UI é persistida sem novo cálculo. As abertas
    // posteriores são recalculadas em cascata a partir desta nova âncora.
    await run(
      `UPDATE parcelas
          SET ${dateCol} = ?,
              explicacao = CASE
                WHEN explicacao IS NULL OR explicacao = '' THEN ?
                ELSE explicacao || '\n' || ?
              END
        WHERE id = ?`,
      [proximoVencimentoISO, linhaExtra, linhaExtra, id]
    );

    const parcelasPosteriores = await all(
      `SELECT p.id, p.numero, p.explicacao
         FROM parcelas p
         JOIN emprestimos e ON e.id = p.emprestimo_id
        WHERE p.emprestimo_id = ?
          AND p.numero > ?
          AND (p.versao IS NULL OR p.versao = e.versao_atual)
          AND (p.pago IS NULL OR p.pago = 0)
        ORDER BY p.numero ASC`,
      [emprestimoId, numeroParcelaBase]
    );

    const diaAncora = Number(proximoVencimentoISO.slice(-2));
    for (let indice = 0; indice < parcelasPosteriores.length; indice += 1) {
      const posterior = parcelasPosteriores[indice];
      const vencimentoCalculado = calcularVencimento(
        proximoVencimentoISO,
        indice + 2,
        diaAncora
      );
      if (!vencimentoCalculado) {
        throw new Error('Não foi possível calcular o vencimento das parcelas posteriores.');
      }
      const novaDataISO = `${vencimentoCalculado.getFullYear()}-${String(
        vencimentoCalculado.getMonth() + 1
      ).padStart(2, '0')}-${String(vencimentoCalculado.getDate()).padStart(2, '0')}`;
      const linhaCascata =
        `Vencimento reagendado para ${formatISOToExtenso(novaDataISO)} em cascata ` +
        `após o pagamento parcial de juros da parcela ${numeroParcelaBase}.`;

      await run(
        `UPDATE parcelas
            SET ${dateCol} = ?,
                explicacao = CASE
                  WHEN explicacao IS NULL OR explicacao = '' THEN ?
                  ELSE explicacao || '\n' || ?
                END
          WHERE id = ?`,
        [novaDataISO, linhaCascata, linhaCascata, posterior.id]
      );
    }

    // 5 — recalcular capital_restante do empréstimo
    const abertas = await all(
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

    await run(
      `UPDATE emprestimos SET capital_restante = ? WHERE id = ?`,
      [novoCapitalRestante, emprestimoId]
    );

    if (manageTransaction) await run('COMMIT');

    return {
      ok: true,
      parcelaAtualizada: {
        id,
        valor_juros: novoValorJuros,
        juros_pendentes: jurosPendentes,
        juros_adicionais: 0,
        valor_total: novoValorTotal,
        capital: capitalAtual,
        juros_pagados: jurosPagos,
        vencimento: proximoVencimentoISO
      }
    };
  } catch (e) {
    if (manageTransaction) try { await run('ROLLBACK'); } catch {}
    throw e;
  }
};
