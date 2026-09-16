const db = require('../models/database');

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

async function touchAtividade({ clienteId = null, emprestimoId = null } = {}) {
  if (!clienteId && !emprestimoId) return;

  let resolvedClienteId = clienteId;
  if (!resolvedClienteId && emprestimoId) {
    try {
      const row = await getAsync(
        'SELECT cliente_id FROM emprestimos WHERE id = ?',
        [emprestimoId]
      );
      if (row && row.cliente_id) resolvedClienteId = row.cliente_id;
    } catch (err) {
      console.error('[touchAtividade] erro ao resolver cliente_id:', err);
    }
  }

  const tasks = [];
  if (emprestimoId) {
    tasks.push(
      runAsync(
        "UPDATE emprestimos SET last_activity_at = datetime('now') WHERE id = ?",
        [emprestimoId]
      )
    );
  }
  if (resolvedClienteId) {
    tasks.push(
      runAsync(
        "UPDATE clientes SET last_activity_at = datetime('now') WHERE id = ?",
        [resolvedClienteId]
      )
    );
  }

  if (tasks.length === 0) return;
  await Promise.all(tasks);
}

module.exports = { touchAtividade };
