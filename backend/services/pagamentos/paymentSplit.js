function f2(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

// Regra canônica já usada pelo fluxo de pagamento normal: juros primeiro,
// depois capital. É compartilhada pela rota tradicional e pelo comando seguro.
function splitNormalPaymentFromParcela(parcela, valorTotal) {
  const valor = f2(valorTotal);
  const jurosDisponivel = f2(
    Number(parcela && parcela.valor_juros || 0) +
    Number(parcela && parcela.juros_pendentes || 0) +
    Number(parcela && parcela.juros_adicionais || 0)
  );
  const juros = Math.min(valor, jurosDisponivel);
  return { juros: f2(juros), capital: f2(Math.max(0, valor - juros)) };
}

module.exports = { splitNormalPaymentFromParcela };
