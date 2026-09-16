const { runAsync, getAsync } = require('../../../utils/sqliteAsync');

function duplicateAction() {
  const error = new Error('Esta confirmação já foi processada.');
  error.code = 'action_already_processed';
  return error;
}

async function claimActionExecution(dbHandle, { key, action, emprestimoId = null } = {}) {
  if (!key) return;
  await runAsync(dbHandle, `CREATE TABLE IF NOT EXISTS assistant_action_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL,
    emprestimo_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  const existing = await getAsync(dbHandle,
    'SELECT id FROM assistant_action_executions WHERE idempotency_key = ?', [String(key)]);
  if (existing) throw duplicateAction();
  await runAsync(dbHandle,
    'INSERT INTO assistant_action_executions (idempotency_key, action, emprestimo_id) VALUES (?, ?, ?)',
    [String(key), String(action), emprestimoId == null ? null : Number(emprestimoId)]);
}

module.exports = { claimActionExecution };
