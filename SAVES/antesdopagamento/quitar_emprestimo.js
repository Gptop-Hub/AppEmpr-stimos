/**
 * utils/quitar_emprestimo.js
 *
 * Recebe lista de parcelas (detalhes/enriched) e o indice da parcela atual (primeira não-paga),
 * o valor informado (number), data ISO e observação.
 *
 * Retorna array de updates (mesma forma usada pelas outras rotinas) ou lança Error com mensagem amigável.
 *
 * Lógica:
 * - soma o original_valor_capital de todas as parcelas não pagas (fallback para valor_capital)
 * - pega original_valor_juros da parcela atual (fallback valor_juros)
 * - expected = somaCapital + jurosAtual (arredondado 2 casas)
 * - exige que provided === expected (com tolerância muito pequena para arredondamento)
 * - build updates: para a primeira parcela paga -> inclui jurosAtual; para as seguintes só capital.
 */

function toNumberSafe(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (s === '') return 0;
  // aceita "1.234,56" ou "1234.56"
  let t = s;
  if (t.indexOf(',') > -1 && t.indexOf('.') > -1) {
    t = t.replace(/\./g, '').replace(',', '.');
  } else if (t.indexOf(',') > -1 && t.indexOf('.') === -1) {
    t = t.replace(',', '.');
  }
  const n = Number(t);
  return Number.isNaN(n) ? 0 : n;
}

module.exports = async function aplicarQuitarEmprestimo(parcelas, atualIndex, valor, data, observacao) {
  if (!Array.isArray(parcelas) || parcelas.length === 0) {
    throw new Error('Lista de parcelas inválida.');
  }

  if (typeof atualIndex !== 'number' || atualIndex < 0 || atualIndex >= parcelas.length) {
    throw new Error('Índice da parcela atual inválido.');
  }

  const provided = Number(Number(valor || 0).toFixed(2));

  // lista de parcelas não pagas a partir do indice atual (inclui atual)
  const unpaid = parcelas.slice(atualIndex).filter(p => !p.pago);

  if (!unpaid || unpaid.length === 0) {
    throw new Error('Nenhuma parcela pendente para quitação.');
  }

  // soma dos capitais originais das parcelas não pagas
  const somaCapital = unpaid.reduce((s, p) => {
    const raw = (p.original_valor_capital != null) ? p.original_valor_capital : p.valor_capital;
    const num = toNumberSafe(raw);
    return s + num;
  }, 0);

  // juros da parcela atual (original)
  const jurosAtual = toNumberSafe(enforceNotNull(parcelas[atualIndex].original_valor_juros, parcelas[atualIndex].valor_juros));

  // expected = somaCapital + jurosAtual
  const expected = Number((somaCapital + jurosAtual).toFixed(2));

  if (!Number.isFinite(expected)) {
    throw new Error('Erro ao calcular valor esperado para quitação (dados inválidos).');
  }

  // tolerância: 1 centavo absoluto
  if (Math.abs(provided - expected) > 0.01) {
    const formatted = expected.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    // mensagem amigável para frontend
    throw new Error(`Valor para quitação inválido. Informe exatamente ${formatted} (capital restante + juros da próxima parcela).`);
  }

  // monta updates: primeira parcela (index 0 do 'unpaid') recebe capital + juros; demais só capital
  const updates = unpaid.map((p, idx) => {
    const valorCapital = toNumberSafe((p.original_valor_capital != null) ? p.original_valor_capital : p.valor_capital);
    const jurosToAdd = idx === 0 ? jurosAtual : 0;
    // valor_pago por parcela = capital (+ juros só na primeira)
    const valorPago = Number((valorCapital + jurosToAdd).toFixed(2));

    return {
      id: p.id,
      valor_pago: valorPago,
      valor_excedente: 0,
      data_pagamento: data,
      vencimento: p.vencimento,
      pago: 1,
      valor_total: p.valor_total,
      valor_capital: p.valor_capital,
      valor_juros: p.valor_juros,
      observacao: (p.observacao ? String(p.observacao) + '\n' : '') + (observacao ? `${observacao} — quitar empréstimo` : 'Quitar empréstimo'),
      explicacao: (p.explicacao ? p.explicacao + '\n' : '') + `Quitado em ${new Date(data).toLocaleDateString('pt-BR')} (capital restante + juros da próxima parcela)`,
      tipo_pagamento: 'quitar'
    };
  });

  return updates;
};

// helper local
function enforceNotNull(a, b) {
  if (a != null) return a;
  return b != null ? b : 0;
}