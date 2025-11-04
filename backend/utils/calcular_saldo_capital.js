const db = require('../models/database');

function calcularSaldoCapital(emprestimoId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT valor_capital, valor_pago FROM parcelas WHERE emprestimo_id = ?`,
      [emprestimoId],
      (err, parcelas) => {
        if (err) return reject(err);

        let capitalOriginal = 0;
        let capitalPago = 0;

        parcelas.forEach(p => {
          capitalOriginal += p.valor_capital;
          capitalPago += Math.min(p.valor_pago || 0, p.valor_capital);
        });

        const saldo = capitalOriginal - capitalPago;
        resolve(saldo.toFixed(2));
      }
    );
  });
}

module.exports = calcularSaldoCapital;