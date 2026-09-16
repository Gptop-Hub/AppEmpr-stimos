const f2 = (n) => Number(Number(n || 0).toFixed(2));

// Abate juros na ordem: adicionais -> pendentes -> base
module.exports = function abaterJuros({
  valor = 0,
  jurosAdicionais = 0,
  jurosPendentes = 0,
  jurosBase = 0,
}) {
  let restante = f2(valor);
  const adic = f2(Math.max(0, jurosAdicionais));
  const pend = f2(Math.max(0, jurosPendentes));
  const base = f2(Math.max(0, jurosBase));

  const aplicadoAdicionais = f2(Math.min(restante, adic));
  restante = f2(restante - aplicadoAdicionais);

  const aplicadoPendentes = f2(Math.min(restante, pend));
  restante = f2(restante - aplicadoPendentes);

  const aplicadoBase = f2(Math.min(restante, base));
  restante = f2(restante - aplicadoBase);

  return {
    aplicadoAdicionais,
    aplicadoPendentes,
    aplicadoBase,
    totalAplicado: f2(aplicadoAdicionais + aplicadoPendentes + aplicadoBase),
    restante,
    jurosAdicionaisDepois: f2(Math.max(0, adic - aplicadoAdicionais)),
    jurosPendentesDepois: f2(Math.max(0, pend - aplicadoPendentes)),
    jurosBaseDepois: f2(Math.max(0, base - aplicadoBase)),
  };
};
