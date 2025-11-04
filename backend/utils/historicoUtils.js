// utils/historicoUtils.js
const mesesNome = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

function toDateObj(d) {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? null : dt;
}

function isLoanFinalized(emp) {
  if (!emp) return false;
  if (emp.quitado === true) return true;
  if (typeof emp.capital_restante === 'number' && emp.capital_restante <= 0) return true;

  const parcelas = emp.parcelasDetalhes || emp.parcelas || [];
  const relevantes = parcelas.filter(p => p && p.numero !== -1);
  if (relevantes.length === 0) return false;

  return relevantes.every(p => {
    if (p.pago === true || p.pago === 1) return true;
    const valorPago = Number(p.valor_pago || 0);
    const valorTotal = Number(p.valor_total || p.valor_com_desconto || 0);
    if (valorTotal > 0 && valorPago >= valorTotal) return true;
    return false;
  });
}

module.exports = { isLoanFinalized, toDateObj, mesesNome };