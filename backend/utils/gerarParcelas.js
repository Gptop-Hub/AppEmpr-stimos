// Gera parcelas compatíveis com o backend e com o preview do frontend.
const { parseToDate } = require('../services/dateUtils');
// Retorna array com { numero, valor_total, valor_capital, valor_juros, vencimento_iso, vencimento_ext }

function pad(n) { return String(n).padStart(2, '0'); }
function f2(value) { return Number(Number(value || 0).toFixed(2)); }

function formatarMoeda(value) {
  return f2(Math.abs(value)).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).replace(/\u00a0/g, ' ');
}

// Mantém a amortização e o saldo usados no cálculo de juros. Apenas fecha, na
// última parcela, a diferença criada pelo arredondamento das parcelas anteriores.
function reconciliarCapital(parcelas, capitalOriginal) {
  if (!parcelas.length) return parcelas;

  const ultima = parcelas[parcelas.length - 1];
  const capitalArredondado = f2(capitalOriginal);
  const somaAnteriores = f2(
    parcelas.slice(0, -1).reduce((soma, parcela) => soma + Number(parcela.valor_capital || 0), 0)
  );
  const capitalNormalUltima = f2(ultima.valor_capital);
  const capitalCorrigido = f2(capitalArredondado - somaAnteriores);
  const ajuste = f2(capitalCorrigido - capitalNormalUltima);

  ultima.valor_capital = capitalCorrigido;
  ultima.valor_total = f2(capitalCorrigido + Number(ultima.valor_juros || 0));
  if (ajuste !== 0) {
    ultima.explicacao =
      `Ajuste de ${formatarMoeda(ajuste)} aplicado nesta parcela para fechar corretamente o capital total do empréstimo.`;
  }
  return parcelas;
}

function formatISO(d) {
  if (!d) return null;
  const dt = parseToDate(d);
  if (!dt) return null;
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function formatExt(d) {
  if (!d) return '-';
  const dt = parseToDate(d);
  if (!dt) return '-';
  return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()}`;
}

// addMonths conservando dia (se possível); se overflow, ajusta para último dia do mês alvo
function addMonthsSafe(baseDate, months, desiredDay) {
  if (!baseDate) return null;
  const base = new Date(baseDate);
  if (isNaN(base.getTime())) return null;
  const year = base.getFullYear();
  const month = base.getMonth() + months;
  const day = Number.isFinite(desiredDay) ? desiredDay : base.getDate();

  const candidate = new Date(year, month, day);
  // se estourou o mês, ajusta para o último dia do mês alvo
  if (candidate.getMonth() !== ((month % 12 + 12) % 12)) {
    const lastDay = new Date(year, month + 1, 0).getDate();
    candidate.setDate(lastDay);
  }
  return candidate;
}

// Soma meses preservando o "dia" de uma data completa e ajustando para o último dia válido
function addMonthsAdjust(date, months) {
  const base = new Date(date.getTime());
  const targetMonth = base.getMonth() + months;
  const y = base.getFullYear() + Math.floor(targetMonth / 12);
  const m = ((targetMonth % 12) + 12) % 12;
  const day = base.getDate();
  const lastDay = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, lastDay));
}

/**
 * gerarParcelas
 * @param {Object} opts
 * @param {number} opts.capital
 * @param {number} opts.taxa_juros  (ex: 10 => 10%)
 * @param {number} opts.qtdParcelas
 * @param {string|Date} opts.dataInicio  (ISO ou Date)
 * @param {number} [opts.diaPagamento]   (1..31) dia do mês escolhido
 * @param {string|null} [opts.primeiroVencimento]  ISO YYYY-MM-DD para 1ª parcela (se fornecido, ignora regra antiga)
 */
function gerarParcelas({ capital, taxa_juros, qtdParcelas, dataInicio, diaPagamento, primeiroVencimento }) {
  const taxa = Number(taxa_juros || 0) / 100;
  const amortizacao = Number(capital || 0) / Number(qtdParcelas || 1);
  let saldo = Number(capital || 0);

  const baseDate = parseToDate(dataInicio) || new Date();
  if (isNaN(baseDate.getTime())) throw new Error('dataInicio inválida em gerarParcelas');

  const parcelas = [];

  // Caminho NOVO: usa primeiroVencimento + soma de meses
  const firstDueDate = primeiroVencimento ? parseToDate(primeiroVencimento) : null;
  const hasFirstDue = firstDueDate && !Number.isNaN(firstDueDate.getTime());

  if (hasFirstDue) {
    for (let i = 1; i <= qtdParcelas; i++) {
      const juros = saldo * taxa;
      const total = amortizacao + juros;

      const vencDate = addMonthsAdjust(firstDueDate, i - 1);
      const vencISO = formatISO(vencDate); // <<< importante: sem UTC

      parcelas.push({
        numero: i,
        valor_total: Number(Number(total).toFixed(2)),
        valor_capital: Number(Number(amortizacao).toFixed(2)),
        valor_juros: Number(Number(juros).toFixed(2)),
        vencimento_iso: vencISO,
        vencimento_ext: formatExt(vencDate)
      });

      saldo -= amortizacao;
    }
    return reconciliarCapital(parcelas, capital);
  }

  // Caminho antigo: dataInicio + diaPagamento
  const diaPag = Number(diaPagamento || baseDate.getDate());
  const candidata = new Date(baseDate.getFullYear(), baseDate.getMonth(), diaPag);
  const firstMonthOffset = (candidata.getTime() >= baseDate.getTime()) ? 0 : 1;

  for (let i = 1; i <= qtdParcelas; i++) {
    const juros = saldo * taxa;
    const total = amortizacao + juros;

    const monthOffset = firstMonthOffset + (i - 1);
    const targetMonthIndex = baseDate.getMonth() + monthOffset;
    const targetYear = baseDate.getFullYear() + Math.floor(targetMonthIndex / 12);
    const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

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

  return reconciliarCapital(parcelas, capital);
}

module.exports = gerarParcelas;
