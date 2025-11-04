function calcularMesesDeDiferenca(dataInicial, dataFinal) {
  const inicio = new Date(dataInicial);
  const fim = new Date(dataFinal);
  let anos = fim.getFullYear() - inicio.getFullYear();
  let meses = fim.getMonth() - inicio.getMonth();
  let totalMeses = anos * 12 + meses;
  if (fim.getDate() < inicio.getDate()) totalMeses--;
  return totalMeses < 0 ? 0 : totalMeses;
}

module.exports = calcularMesesDeDiferenca;