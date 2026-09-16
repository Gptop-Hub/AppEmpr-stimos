// utils/quitar_emprestimo.js
/**
 * Função para processar pagamento de quitação de empréstimo.
 * Aceita o valor exato = soma do capital restante + juros da próxima parcela.
 *
 * Retorna array de updates para aplicar nas parcelas (mesmo formato já usado no sistema).
 */

const mesesNome = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

function formatBRL(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
}
function formatDataDDMonthYYYY(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const dd = String(d.getDate()).padStart(2,'0');
    const mes = mesesNome[d.getMonth()] || '';
    const yyyy = d.getFullYear();
    return `${dd} ${mes} ${yyyy}`;
  } catch {
    return iso;
  }
}

/**
 * parcelas: array de parcelas (somente cronograma atual)
 * atualIndex: índice da próxima parcela pendente
 * valor: número (float) recebido do frontend
 * data: ISO string da data do pagamento
 * observacao: texto extra informado
 */
function calcularValorQuitacao(parcelas = [], atualIndex = 0) {
  if (!Array.isArray(parcelas) || parcelas.length === 0) throw new Error('Nenhuma parcela pendente para quitação.');
  const proxima = parcelas[atualIndex];
  if (!proxima) throw new Error('Próxima parcela não encontrada.');
  // considera apenas parcelas não pagas a partir do índice atual
  const unpaid = parcelas.slice(atualIndex).filter(p => !p.pago);

  if (!unpaid || unpaid.length === 0) {
    throw new Error('Nenhuma parcela pendente para quitação.');
  }

  // Soma apenas o capital remanescente do cronograma atual
  const somaCapital = unpaid.reduce((s, p) => {
    const cap = Number(p.valor_capital ?? 0);
    return s + cap;
  }, 0);

  // Juros considerados somente da próxima parcela atual
  const jurosAtual = Number(proxima.valor_juros ?? 0);

  return { expected: Number((somaCapital + jurosAtual).toFixed(2)), somaCapital: Number(somaCapital.toFixed(2)), jurosAtual: Number(jurosAtual.toFixed(2)), unpaid, proxima };
}

async function aplicarQuitarEmprestimo(parcelas = [], atualIndex = 0, valor = 0, data = null, observacao = '') {
  if (!Array.isArray(parcelas) || parcelas.length === 0) return [];
  const calculation = calcularValorQuitacao(parcelas, atualIndex);
  const { expected, jurosAtual, unpaid, proxima } = calculation;
  const provided = Number(Number(valor || 0).toFixed(2));

  // validação com tolerância por arredondamento (até 5 centavos de diferença)
  const diff = Math.abs(provided - expected);
  if (diff > 0.05) {
    // mensagem legível para o backend que será retornada ao frontend
    throw new Error(`Valor para quitação inválido. Esperado ${formatBRL(expected)}, recebido ${formatBRL(provided)}.`);
  }

  // Construir updates:
  // - primeira parcela (aquela onde foi pago juros + capital) deve ter explicação EMPRESTIMO QUITADO ...
  // - demais parcelas recebem explicação "PARCELA FANTASMA..."
  const dataString = data ? formatDataDDMonthYYYY(data) : formatDataDDMonthYYYY(new Date().toISOString());
  const msgObservacaoBase = observacao && String(observacao).trim() ? `${String(observacao).trim()} — ` : '';

  const updates = unpaid.map((p, idx) => {
    const isFirst = idx === 0;

    // Usa somente os valores atuais registrados na parcela
    const valorCapital = Number(p.valor_capital ?? 0);

    const jurosToUse = isFirst ? jurosAtual : 0;
    const valorPago = Number((valorCapital + jurosToUse).toFixed(2));

    if (isFirst) {
      const explic = `EMPRESTIMO QUITADO: Devido ao pagamento de ${formatBRL(provided)} no dia ${dataString}.`;
      return {
        id: p.id,
        valor_pago: valorPago,
        valor_excedente: 0,
        data_pagamento: data,
        vencimento: p.vencimento,
        pago: 1,
        valor_total: p.valor_total,
        valor_capital: valorCapital,
        valor_juros: jurosToUse,
        observacao: `${msgObservacaoBase}${explic}`,
        explicacao: explic,
        tipo_pagamento: 'quitar'
      };
    } else {
      // parcela "fantasma": marca como quitada porque o empréstimo foi quitado
      const explic = `PARCELA FANTASMA: Empréstimo quitado em ${dataString}.`;
      return {
        id: p.id,
        valor_pago: p.valor_pago != null ? p.valor_pago : 0,
        valor_excedente: 0,
        data_pagamento: null,
        vencimento: p.vencimento,
        pago: 1,
        valor_total: p.valor_total,
        valor_capital: p.valor_capital != null ? p.valor_capital : valorCapital,
        valor_juros: p.valor_juros != null ? p.valor_juros : 0,
        observacao: explic,
        explicacao: explic,
        tipo_pagamento: 'quitar'
      };
    }
  });

  return updates;
}
module.exports = aplicarQuitarEmprestimo;
module.exports.calcularValorQuitacao = calcularValorQuitacao;
