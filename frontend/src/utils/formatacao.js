export function formatarMoedaNumero(valor) {
  if (!valor && valor !== 0) return '';
  return Number(valor).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

export function desformatarMoeda(valor) {
  if (!valor) return 0;
  return Number(
    valor
      .replace(/\s/g, '')
      .replace('R$', '')
      .replace(/\./g, '')
      .replace(',', '.')
  );
}