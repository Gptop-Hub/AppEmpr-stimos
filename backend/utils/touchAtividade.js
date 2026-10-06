const db = require('../models/database');

function runAsync(dbHandle, sql, params = []) {
  return new Promise((resolve, reject) => {
    dbHandle.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getAsync(dbHandle, sql, params = []) {
  return new Promise((resolve, reject) => {
    dbHandle.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

async function touchAtividade({ clienteId = null, emprestimoId = null, dbHandle = db, strict = false } = {}) {
  if (!clienteId && !emprestimoId) return;

  let resolvedClienteId = clienteId;
  if (!resolvedClienteId && emprestimoId) {
    try {
      const row = await getAsync(
        dbHandle,
        'SELECT cliente_id FROM emprestimos WHERE id = ?',
        [emprestimoId]
      );
      if (row && row.cliente_id) resolvedClienteId = row.cliente_id;
    } catch (err) {
      console.error('[touchAtividade] erro ao resolver cliente_id:', err);
      if (strict) throw err;
    }
  }

  // ISO em UTC preserva a ordem cronológica no banco e fornece milissegundos
  // para ações consecutivas não ficarem empatadas artificialmente.
  const timestamp = new Date().toISOString();
  const tasks = [];
  if (emprestimoId) {
    tasks.push(
      runAsync(
        dbHandle,
        'UPDATE emprestimos SET last_activity_at = ? WHERE id = ?',
        [timestamp, emprestimoId]
      )
    );
  }
  if (resolvedClienteId) {
    tasks.push(
      runAsync(
        dbHandle,
        'UPDATE clientes SET last_activity_at = ? WHERE id = ?',
        [timestamp, resolvedClienteId]
      )
    );
  }

  if (tasks.length === 0) return;
  await Promise.all(tasks);
}

module.exports = { touchAtividade };
