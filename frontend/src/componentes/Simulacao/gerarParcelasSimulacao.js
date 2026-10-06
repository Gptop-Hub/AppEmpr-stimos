const fix2 = (n) => Number(Number(n || 0).toFixed(2));

export function gerarParcelasSimulacao({ capital, taxa_juros, qtdParcelas }) {
  const capitalNum = Number(capital || 0);
  const jurosNum = Number(taxa_juros || 0);
  const parcelasNum = Math.trunc(Number(qtdParcelas || 0));

  if (!Number.isFinite(capitalNum) || capitalNum <= 0) return [];
  if (!Number.isFinite(jurosNum) || jurosNum < 0) return [];
  if (!Number.isFinite(parcelasNum) || parcelasNum <= 0) return [];

  const amortizacao = capitalNum / parcelasNum;
  let saldo = capitalNum;
  const parcelas = [];

  for (let i = 1; i <= parcelasNum; i += 1) {
    const juros = saldo * (jurosNum / 100);
    const total = amortizacao + juros;

    parcelas.push({
      numero: i,
      valor_total: fix2(total),
      valor_capital: fix2(amortizacao),
      valor_juros: fix2(juros),
    });

    saldo -= amortizacao;
    if (Math.abs(saldo) < 1e-10) saldo = 0;
  }

  const ultima = parcelas[parcelas.length - 1];
  const somaAnteriores = fix2(
    parcelas.slice(0, -1).reduce((soma, parcela) => soma + Number(parcela.valor_capital || 0), 0)
  );
  ultima.valor_capital = fix2(fix2(capitalNum) - somaAnteriores);
  ultima.valor_total = fix2(ultima.valor_capital + Number(ultima.valor_juros || 0));

  return parcelas;
}
