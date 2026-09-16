export function isClienteMalPagador(cliente) {
  if (!cliente) return false;
  const value =
    cliente.mal_pagador ??
    cliente.cliente_mal_pagador ??
    cliente.risco_mal_pagador;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const text = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "sim", "yes", "on"].includes(text);
}

export function isEmprestimoClienteMalPagador(emprestimo) {
  if (!emprestimo) return false;
  return isClienteMalPagador({
    mal_pagador: emprestimo.cliente_mal_pagador ?? emprestimo.mal_pagador,
  });
}
