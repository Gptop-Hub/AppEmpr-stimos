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

  // converter dataCriacao para Date seguro
  let inicio = (dataCriacao instanceof Date) ? new Date(dataCriacao.getTime()) : new Date(dataCriacao);
  if (isNaN(inicio.getTime())) return null;

  // normaliza diaPagamento
  let dia = Math.floor(diaPagamento);
  if (dia < 1) dia = 1;
  if (dia > 31) dia = 31;

  const hoje = new Date();
  // zera horas para comparações por data (só dia/mês/ano)
  hoje.setHours(0,0,0,0);

  // --- calcula o vencimento da "primeira parcela" ajustado se já passou no mês de criação ---
  // tenta criar a data no mesmo mês de criação
  let primeira = new Date(inicio.getFullYear(), inicio.getMonth(), dia);

  // se a data resultante "transbordou" (ex.: dia 31 em mês com menos dias), ajusta pro último dia do mês
  if (primeira.getDate() !== dia) {
    // último dia do mês de 'primeira'
    const ultimo = new Date(primeira.getFullYear(), primeira.getMonth() + 1, 0).getDate();
    primeira.setDate(ultimo);
  }

  // se a primeira parcela já passou (menor que hoje), joga para próximo mês
  if (primeira < hoje) {
    primeira = new Date(primeira.getFullYear(), primeira.getMonth() + 1, 1); // primeiro dia do próximo mês
    const ultimo = new Date(primeira.getFullYear(), primeira.getMonth() + 1, 0).getDate();
    primeira.setDate(Math.min(dia, ultimo));
  }

  // --- agora calculamos a parcela número `numeroParcela` a partir dessa primeira ---
  // se numeroParcela === 1 -> retorna 'primeira'
  if (numeroParcela === 1) return primeira;

  // para parcelas seguintes, soma (numeroParcela - 1) meses à primeira
  let venc = new Date(primeira.getFullYear(), primeira.getMonth() + (numeroParcela - 1), 1);

  // calcula último dia do mês alvo
  const ultimoDiaMes = new Date(venc.getFullYear(), venc.getMonth() + 1, 0).getDate();
  venc.setDate(Math.min(dia, ultimoDiaMes));

  return venc;
}

module.exports = { calcularVencimento };