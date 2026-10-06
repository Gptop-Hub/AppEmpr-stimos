/**
 * Calcula a data de vencimento de uma parcela de empréstimo
 * @param {string|Date} dataCriacao - Data em que o empréstimo foi criado (aceita Date ou string ISO)
 * @param {number} numeroParcela - Número da parcela (1 = primeira, 2 = segunda, etc.)
 * @param {number} diaPagamento - Dia do mês em que o usuário escolheu pagar (1 a 31)
 * @returns {Date|null} Data de vencimento (objeto Date) ou null se inválida
 */
function calcularVencimento(dataCriacao, numeroParcela, diaPagamento) {
  // validações básicas
  if (!dataCriacao || typeof numeroParcela !== 'number' || typeof diaPagamento !== 'number') return null;
  if (Number.isNaN(numeroParcela) || Number.isNaN(diaPagamento)) return null;

  // Datas YYYY-MM-DD são datas civis: não use o parser UTC do JavaScript.
  let inicio;
  if (dataCriacao instanceof Date) {
    inicio = new Date(dataCriacao.getTime());
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(dataCriacao || ''))) {
    const [ano, mes, dia] = String(dataCriacao).split('-').map(Number);
    inicio = new Date(ano, mes - 1, dia);
  } else {
    inicio = new Date(dataCriacao);
  }
  if (isNaN(inicio.getTime())) return null;

  // normaliza diaPagamento
  let dia = Math.floor(diaPagamento);
  if (dia < 1) dia = 1;
  if (dia > 31) dia = 31;

  // --- primeira parcela ---
  let primeira = new Date(inicio.getFullYear(), inicio.getMonth(), dia);

  // se a data "transbordou" (ex.: dia 31 em mês com menos dias), ajusta pro último dia do mês
  if (primeira.getDate() !== dia) {
    const ultimo = new Date(primeira.getFullYear(), primeira.getMonth() + 1, 0).getDate();
    primeira.setDate(ultimo);
  }

  // se numeroParcela === 1 -> retorna 'primeira'
  if (numeroParcela === 1) return primeira;

  // --- parcelas seguintes ---
  let venc = new Date(primeira.getFullYear(), primeira.getMonth() + (numeroParcela - 1), 1);

  // calcula último dia do mês alvo
  const ultimoDiaMes = new Date(venc.getFullYear(), venc.getMonth() + 1, 0).getDate();
  venc.setDate(Math.min(dia, ultimoDiaMes));

  return venc;
}

module.exports = { calcularVencimento };
