export function getCodigoPagamento(emp) {
  return (
    emp?.emprestimo_num?.trim?.() ||
    emp?.codigo_cliente?.trim?.() ||
    `${emp?.cliente_id || '0'}-${emp?.id || '0'}`
  );
}

export function getNomePagamento(emp) {
  return emp?.cliente_nome || emp?.nome || 'Desconhecido';
}

export function isEmprestimoAtivoParaPagamento(emp) {
  return Number(emp?.capital_restante) > 0.009;
}

export function filtrarEmprestimosParaPagamento(
  emprestimos,
  { busca = '', buscaId = '' } = {}
) {
  const termo = String(busca || '').trim().toLowerCase();
  const termoId = String(buscaId || '').trim();

  return (Array.isArray(emprestimos) ? emprestimos : []).filter((emp) => {
    if (!termo && !termoId) return false;
    if (!isEmprestimoAtivoParaPagamento(emp)) return false;
    if (termoId && String(emp?.cliente_id ?? '') !== termoId) return false;
    if (!termo) return true;

    const codigo = String(getCodigoPagamento(emp)).toLowerCase();
    const nome = String(getNomePagamento(emp)).toLowerCase();
    return codigo.startsWith(termo) || nome.startsWith(termo);
  });
}
