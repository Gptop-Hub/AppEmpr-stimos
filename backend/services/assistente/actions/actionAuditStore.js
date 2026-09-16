const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { getAppDataDir } = require('../../../utils/paths');

let store = null;

function createPersistentAuditStore({ filePath = path.join(getAppDataDir(), 'assistant-actions.db') } = {}) {
  const db = new sqlite3.Database(filePath);
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS assistant_action_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      event TEXT NOT NULL,
      action TEXT NOT NULL,
      session_id TEXT NOT NULL,
      confirmation_token_hash TEXT NOT NULL,
      preview_json TEXT,
      relevant_ids_json TEXT,
      success INTEGER NOT NULL,
      failure_code TEXT
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_assistant_action_audit_session ON assistant_action_audit(session_id, timestamp)');
  });

  return {
    record(entry) {
      const safe = entry && typeof entry === 'object' ? entry : {};
      return new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO assistant_action_audit
             (timestamp, event, action, session_id, confirmation_token_hash, preview_json, relevant_ids_json, success, failure_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            String(safe.timestamp || new Date().toISOString()), String(safe.event || 'unknown'),
            String(safe.action || 'unknown'), String(safe.session_id || ''),
            String(safe.confirmation_token_hash || ''), JSON.stringify(safe.preview || {}),
            JSON.stringify(safe.relevant_ids || {}), safe.success ? 1 : 0,
            safe.failure_code ? String(safe.failure_code) : null,
          ],
          (err) => (err ? reject(err) : resolve())
        );
      });
    },
  };
}

function getPersistentAuditStore() {
  if (!store) store = createPersistentAuditStore();
  return store;
}

module.exports = { createPersistentAuditStore, getPersistentAuditStore };
