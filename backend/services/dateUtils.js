// backend/services/dateUtils.js
// utilitários de data usados pelo servico emprestimo

function parseToDate(input) {
  if (!input && input !== 0) return null;
  if (input instanceof Date) {
    return isNaN(input.getTime()) ? null : input;
  }

  if (typeof input !== 'string') {
    try {
      const d = new Date(input);
      return isNaN(d.getTime()) ? null : d;
    } catch (e) {
      return null;
    }
  }

  const s = input.trim();

  // ISO (yyyy-mm-dd or yyyy-mm-ddTHH:MM:SS)
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    const dt = new Date(y, m - 1, d);
    return isNaN(dt.getTime()) ? null : dt;
  }

  // dd/mm/yyyy
  const parts = s.split('/');
  if (parts.length === 3) {
    const day = Number(parts[0]);
    const mon = Number(parts[1]);
    const year = Number(parts[2]);
    if (!Number.isNaN(day) && !Number.isNaN(mon) && !Number.isNaN(year)) {
      const dt = new Date(year, mon - 1, day);
      return isNaN(dt.getTime()) ? null : dt;
    }
  }

  // fallback - tentar Date()
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt;
}

function toISO(dateLike) {
  const d = parseToDate(dateLike);
  if (!d) return null;
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function toExtenso(dateLike) {
  const d = parseToDate(dateLike);
  if (!d) return '-';
  const meses = [
    'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
    'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'
  ];
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = meses[d.getMonth()];
  const ano = d.getFullYear();
  return `${dia} ${mes} ${ano}`;
}

function calcularMesesDeDiferenca(dataInicial, dataFinal) {
  const inicio = parseToDate(dataInicial);
  const fim = parseToDate(dataFinal);
  if (!inicio || !fim) return 0;
  let anos = fim.getFullYear() - inicio.getFullYear();
  let meses = fim.getMonth() - inicio.getMonth();
  let totalMeses = anos * 12 + meses;
  if (fim.getDate() < inicio.getDate()) totalMeses--;
  return totalMeses < 0 ? 0 : totalMeses;
}

module.exports = {
  parseToDate,
  toISO,
  toExtenso,
  calcularMesesDeDiferenca
};