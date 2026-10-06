export function parseLastActivityMs(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();

  const raw = String(value).trim();
  if (!raw) return 0;

  let normalized = raw.includes(" ") && !raw.includes("T")
    ? raw.replace(" ", "T")
    : raw;
  // Registros legados do SQLite usavam datetime('now'): UTC sem sufixo Z.
  // Explicitá-lo evita que cada máquina os interprete no próprio fuso horário.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(normalized)) {
    normalized += "Z";
  }
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function getClienteLastActivityFromLoans(cliente) {
  return (cliente?.emprestimos || []).reduce((mostRecent, emprestimo) => {
    return Math.max(mostRecent, parseLastActivityMs(emprestimo?.last_activity_at));
  }, 0);
}

export function compareClientesByLastActivity(a, b) {
  const difference =
    getClienteLastActivityFromLoans(b) - getClienteLastActivityFromLoans(a);
  if (difference !== 0) return difference;

  // Sem atividade registrada (ou em empate exato), preserva um desempate
  // determinístico já coerente com a ordenação padrão por ID.
  return Number(a?.id || 0) - Number(b?.id || 0);
}
