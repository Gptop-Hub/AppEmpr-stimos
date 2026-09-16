export function toNumber(value) {
  if (value == null) return 0;
  const raw = String(value).trim();
  if (!raw) return 0;

  // Aceita formato BR (1.234,56) e milhar com ponto sem decimais (10.000).
  const clean = raw.replace(/\s+/g, '');
  const hasComma = clean.includes(',');
  const hasDot = clean.includes('.');

  let normalized = clean;
  if (hasComma && hasDot) {
    normalized = clean.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    normalized = clean.replace(',', '.');
  } else if (hasDot) {
    const brThousandsOnly = /^\d{1,3}(\.\d{3})+$/;
    if (brThousandsOnly.test(clean)) {
      normalized = clean.replace(/\./g, '');
    }
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

export function formatarMoeda(value) {
  const n = Number(value || 0);
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `R$ ${n.toFixed(2)}`;
  }
}
