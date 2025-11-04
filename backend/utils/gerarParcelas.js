// utils/gerarParcelas.js
// Gera parcelas compatíveis com o backend e com o preview do frontend.
// Retorna array com { numero, valor_total, valor_capital, valor_juros, vencimento_iso, vencimento_ext }

function pad(n) { return String(n).padStart(2, '0'); }

function formatISO(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`;
}

function formatExt(d) {
  if (!d) return '-';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '-';
  return `${pad(dt.getDate())}/${pad(dt.getMonth()+1)}/${dt.getFullYear()}`;
}

// addMonths conservando dia (se possível), se overflow ajusta para último dia do mês
function addMonthsSafe(baseDate, months, desiredDay) {
  if (!baseDate) return null;
  const base = new Date(baseDate);
  if (isNaN(base.getTime())) return null;
  const year = base.getFullYear();
  const month = base.getMonth() + months;
  const day = Number.isFinite(desiredDay) ? desiredDay : base.getDate();

  const candidate = new Date(year, month, day);
  // if overflow (month changed unexpectedly), adjust to last day of target month
  if (candidate.getMonth() !== ((month % 12 + 12) % 12)) {
    const lastDay = new Date(year, month + 1, 0).getDate();
    candidate.setDate(lastDay);
  }
  return candidate;
}

/**
 * gerarParcelas
 * @param {Object} opts
 * @param {number} opts.capital
 * @param {number} opts.taxa_juros  (ex: 10 => 10% por período usado no seu sistema)
 * @param {number} opts.qtdParcelas
 * @param {string|Date} opts.dataInicio  (data de início do empréstimo) - string ISO ou Date
 * @param {number} opts.diaPagamento    (1..31) dia do mês escolhido para vencimento
 */
function gerarParcelas({ capital, taxa_juros, qtdParcelas, dataInicio, diaPagamento }) {
  const taxa = Number(taxa_juros || 0) / 100;
  const amortizacao = Number(capital || 0) / Number(qtdParcelas || 1);
  let saldo = Number(capital || 0);

  const baseDate = dataInicio ? new Date(dataInicio) : new Date();
  if (isNaN(baseDate.getTime())) throw new Error('dataInicio inválida em gerarParcelas');

  // resolve diaPagamento numérico (1..31). se não fornecido, usa dia da dataInicio
  const diaPag = Number(diaPagamento || baseDate.getDate());

  // Decide se a primeira parcela fica no mesmo mês da dataInicio ou no próximo:
  // calculamos a "data candidata" (mesma mês da dataInicio com dia = diaPag)
  // se candidata >= dataInicio -> primeira parcela no mesmo mês (offset 0)
  // se candidata < dataInicio -> primeira parcela no mês seguinte (offset 1)
  const candidata = new Date(baseDate.getFullYear(), baseDate.getMonth(), diaPag);
  const firstMonthOffset = (candidata.getTime() >= baseDate.getTime()) ? 0 : 1;

  const parcelas = [];

  for (let i = 1; i <= qtdParcelas; i++) {
    const juros = saldo * taxa;
    const total = amortizacao + juros;

    const monthOffset = firstMonthOffset + (i - 1);
    const targetMonthIndex = baseDate.getMonth() + monthOffset;
    const targetYear = baseDate.getFullYear() + Math.floor(targetMonthIndex / 12);
    const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
    // anchor no primeiro dia do targetMonth e depois aplicar desiredDay (addMonthsSafe tratar overflow)
    const anchor = new Date(targetYear, targetMonth, 1);
    const vencDate = addMonthsSafe(anchor, 0, diaPag);

    parcelas.push({
      numero: i,
      valor_total: Number(Number(total).toFixed(2)),
      valor_capital: Number(Number(amortizacao).toFixed(2)),
      valor_juros: Number(Number(juros).toFixed(2)),
      vencimento_iso: formatISO(vencDate),
      vencimento_ext: formatExt(vencDate)
    });

    saldo -= amortizacao;
  }

  return parcelas;
}

module.exports = gerarParcelas;