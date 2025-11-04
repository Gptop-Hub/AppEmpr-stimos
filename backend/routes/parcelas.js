const express = require('express');
const router = express.Router();
const db = require('../models/database');

/**
 * Helper: converte vários formatos comuns para 'YYYY-MM-DD' (string) para usar em <input type="date">
 * - aceita 'yyyy-mm-dd', 'yyyy-mm-ddTHH:MM:SS', 'dd/mm/yyyy', Date objects
 * - retorna '' se não reconhecer
 */
function paraInputDate(data) {
  if (!data && data !== 0) return '';

  // Date object
  if (data instanceof Date) {
    if (isNaN(data.getTime())) return '';
    const y = data.getFullYear();
    const m = String(data.getMonth() + 1).padStart(2, '0');
    const d = String(data.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  if (typeof data !== 'string') {
    // tenta converter via Date
    const dt = new Date(data);
    if (!isNaN(dt.getTime())) {
      return paraInputDate(dt);
    }
    return '';
  }

  const s = data.trim();

  // já em ISO yyyy-mm-dd
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  // ISO com hora
  if (s.includes('T')) {
    const datePart = s.split('T')[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
  }

  // formato dd/mm/yyyy
  if (s.includes('/')) {
    const partes = s.split('/');
    if (partes.length === 3) {
      const d = partes[0].padStart(2,'0');
      const m = partes[1].padStart(2,'0');
      const y = partes[2];
      if (/^\d{4}$/.test(y)) {
        return `${y}-${m}-${d}`;
      }
    }
  }

  // fallback: tenta criar Date e converter
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) return paraInputDate(dt);

  return '';
}

// GET - listar parcelas de um empréstimo (retorna vencimento e data_pagamento em YYYY-MM-DD)
router.get('/:emprestimo_id', (req, res) => {
  const { emprestimo_id } = req.params;

  db.all(
    `SELECT * FROM parcelas WHERE emprestimo_id = ? ORDER BY numero ASC`,
    [emprestimo_id],
    (err, rows) => {
      if (err) return res.status(500).json({ erro: err.message });

      const parcelasFormatadas = (rows || []).map(p => ({
        ...p,
        vencimento: paraInputDate(p.vencimento),
        data_pagamento: paraInputDate(p.data_pagamento)
      }));

      res.json(parcelasFormatadas);
    }
  );
});

// POST - criar parcela
router.post('/', (req, res) => {
  const {
    emprestimo_id,
    numero,
    capital,
    juros,
    vencimento,
    observacao
  } = req.body;

  db.run(
    `INSERT INTO parcelas (
      emprestimo_id, numero, valor_capital, valor_juros, vencimento, pago, observacao,
      valor_pago, data_pagamento, juros_adicionais
    ) VALUES (?, ?, ?, ?, ?, 0, ?, 0, null, 0)`,
    [emprestimo_id, numero, capital, juros, vencimento, observacao || ''],
    function (err) {
      if (err) return res.status(500).json({ erro: err.message });
      res.json({ id: this.lastID });
    }
  );
});

// PUT - atualizar somente campos enviados (mantendo comportamento flexível)
// Aceita vencimento em 'YYYY-MM-DD' (recomendado) ou dd/mm/yyyy; grava tal como enviado.
router.put('/:id', (req, res) => {
  const { id } = req.params;

const campos = [
  'valor_capital',
  'valor_juros',
  'vencimento',
  'pago',
  'observacao',
  'valor_pago',
  'data_pagamento',
  'juros_adicionais',
  'explicacao', // <-- adiciona aqui
];

  const updates = [];
  const values = [];

  campos.forEach(campo => {
    if (req.body.hasOwnProperty(campo)) {
      updates.push(`${campo} = ?`);
      values.push(req.body[campo]);
    }
  });

  if (updates.length === 0) {
    return res.status(400).json({ erro: 'Nenhum dado enviado para atualizar.' });
  }

  values.push(id);

  const sql = `UPDATE parcelas SET ${updates.join(', ')} WHERE id = ?`;

  db.run(sql, values, function (err) {
    if (err) return res.status(500).json({ erro: err.message });
    res.json({ status: 'Parcela atualizada com sucesso' });
  });
});

// DELETE - apagar parcela
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  db.run(`DELETE FROM parcelas WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ erro: err.message });
    res.json({ status: 'Parcela removida' });
  });
});

module.exports = router;