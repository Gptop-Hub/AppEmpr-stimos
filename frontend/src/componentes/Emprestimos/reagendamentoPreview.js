const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isParcelaComPagamento(parcela) {
  if (!parcela) return false;
  if (parcela.pago === 1 || parcela.pago === '1' || parcela.pago === true) return true;
  if (Number(parcela.valor_pago || 0) > 0) return true;
  return Boolean(String(parcela.data_pagamento || '').trim());
}

export function isCivilISO(value) {
  const iso = String(value || '').trim();
  if (!ISO_RE.test(iso)) return false;
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function lastDay(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

export function addMonthsCivil(iso, months, desiredDay) {
  if (!isCivilISO(iso)) return null;
  const [year, month, day] = iso.split('-').map(Number);
  const totalMonth = month - 1 + Number(months || 0);
  const targetYear = year + Math.floor(totalMonth / 12);
  const targetMonth = ((totalMonth % 12) + 12) % 12;
  const targetDay = Math.min(Number(desiredDay || day), lastDay(targetYear, targetMonth));
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

export function changeDayCivil(iso, day) {
  if (!isCivilISO(iso) || !Number.isInteger(Number(day)) || Number(day) < 1 || Number(day) > 31) return null;
  const [year, month] = iso.split('-').map(Number);
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(Number(day), lastDay(year, month - 1))).padStart(2, '0')}`;
}

export function montarPreviaReagendamento({ parcelas = [], parcelaId, tipo, novaDataISO, novoDia }) {
  const ordered = [...parcelas]
    .filter((p) => Number(p?.numero) !== -1)
    .sort((a, b) => Number(a.numero || 0) - Number(b.numero || 0) || Number(a.id || a.parcela_id) - Number(b.id || b.parcela_id));
  const targetId = Number(parcelaId);
  const start = ordered.findIndex((p) => Number(p.id || p.parcela_id) === targetId);
  if (start < 0) return { linhas: [], erro: 'Parcela não encontrada no cronograma.' };
  if (isParcelaComPagamento(ordered[start])) return { linhas: [], erro: 'A parcela selecionada possui pagamento registrado.' };
  if ((tipo === 'single' || tipo === 'cascade') && !isCivilISO(novaDataISO)) return { linhas: [], erro: 'Escolha uma data completa válida.' };
  if (tipo === 'change_day' && (!Number.isInteger(Number(novoDia)) || Number(novoDia) < 1 || Number(novoDia) > 31)) return { linhas: [], erro: 'Escolha um dia entre 1 e 31.' };

  let openOffset = 0;
  const linhas = ordered.map((parcela, index) => {
    const antes = String(parcela.vencimento || '').slice(0, 10);
    const paga = isParcelaComPagamento(parcela);
    let depois = antes;
    let alterada = false;
    if (tipo === 'single' && index === start) {
      depois = novaDataISO;
      alterada = true;
    }
    if (tipo === 'cascade' && index >= start && !paga) {
      depois = addMonthsCivil(novaDataISO, openOffset, Number(novaDataISO.slice(8, 10)));
      openOffset += 1;
      alterada = true;
    }
    if (tipo === 'change_day' && index >= start && !paga) {
      depois = changeDayCivil(antes, Number(novoDia));
      alterada = true;
    }
    return { ...parcela, antes, depois, alterada, paga };
  });

  const periods = new Map();
  linhas.forEach((linha) => {
    const key = linha.depois.slice(0, 7);
    periods.set(key, [...(periods.get(key) || []), linha.numero]);
  });
  const conflitos = [...periods.entries()].filter(([, numeros]) => numeros.length > 1);
  return {
    linhas,
    conflitos,
    erro: conflitos.length ? 'A alteração criaria mais de uma parcela no mesmo mês do cronograma.' : '',
  };
}
