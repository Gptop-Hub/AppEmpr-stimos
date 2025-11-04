const db = require('../models/database');

exports.atualizarVencimento = (req, res) => {
  const { parcelaId } = req.params;
  const { vencimento } = req.body;

  if (!vencimento) return res.status(400).json({ error: 'Data de vencimento é obrigatória.' });

  db.run(
    `UPDATE parcelas SET vencimento = ? WHERE id = ?`,
    [vencimento, parcelaId],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Erro ao atualizar vencimento.' });
      }
      res.json({ mensagem: 'Vencimento atualizado com sucesso!' });
    }
  );
};