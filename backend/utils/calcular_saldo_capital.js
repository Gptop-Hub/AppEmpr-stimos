const db = require('../models/database');

function calcularSaldoCapital(emprestimoId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT p.valor_capital, p.valor_pago
         FROM parcelas p
         JOIN emprestimos e ON e.id = p.emprestimo_id
        WHERE p.emprestimo_id = ?
          AND (p.versao IS NULL OR p.versao = e.versao_atual)`,
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
