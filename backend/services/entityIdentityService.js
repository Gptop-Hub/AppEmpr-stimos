const crypto = require('crypto');
const { allAsync, runAsync } = require('../utils/sqliteAsync');

const ENTITY_UIDS = Object.freeze([
  { table: 'clientes', column: 'cliente_uid', trigger: 'trg_clientes_cliente_uid' },
  { table: 'emprestimos', column: 'emprestimo_uid', trigger: 'trg_emprestimos_emprestimo_uid' },
  { table: 'parcelas', column: 'parcela_uid', trigger: 'trg_parcelas_parcela_uid' },
]);

const inFlight = new WeakMap();
const ready = new WeakSet();

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createUuid() {
  if (typeof crypto.randomUUID !== 'function') throw new Error('O runtime atual não oferece crypto.randomUUID.');
  return crypto.randomUUID();
}

async function hasColumn(dbHandle, table, column) {
  const columns = await allAsync(dbHandle, `PRAGMA table_info(${table})`);
  return columns.some((item) => item.name === column);
}

function triggerSql({ table, column, trigger }) {
  // SQLite não possui uuid() nativo. O valor formado abaixo é UUID v4 e é
  // atribuído somente quando a origem não trouxe um UID para preservar.
  const uuid = "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))";
  return `CREATE TRIGGER IF NOT EXISTS ${trigger}
    AFTER INSERT ON ${table}
    WHEN NEW.${column} IS NULL OR trim(NEW.${column}) = ''
    BEGIN
      UPDATE ${table} SET ${column} = ${uuid} WHERE rowid = NEW.rowid;
    END`;
}

async function runEnsure(dbHandle) {
  await runAsync(dbHandle, 'BEGIN IMMEDIATE');
  try {
    for (const entity of ENTITY_UIDS) {
      if (!await hasColumn(dbHandle, entity.table, entity.column)) {
        await runAsync(dbHandle, `ALTER TABLE ${entity.table} ADD COLUMN ${entity.column} TEXT`);
      }
      await runAsync(dbHandle, `CREATE UNIQUE INDEX IF NOT EXISTS idx_${entity.table}_${entity.column}_unique
        ON ${entity.table}(${entity.column}) WHERE ${entity.column} IS NOT NULL AND trim(${entity.column}) <> ''`);
      const missing = await allAsync(dbHandle,
        `SELECT id FROM ${entity.table} WHERE ${entity.column} IS NULL OR trim(${entity.column}) = '' ORDER BY id ASC`
      );
      for (const row of missing) {
        await runAsync(dbHandle, `UPDATE ${entity.table} SET ${entity.column} = ? WHERE id = ? AND (${entity.column} IS NULL OR trim(${entity.column}) = '')`, [createUuid(), row.id]);
      }
      await runAsync(dbHandle, triggerSql(entity));
    }
    await runAsync(dbHandle, 'COMMIT');
  } catch (error) {
    await runAsync(dbHandle, 'ROLLBACK').catch(() => {});
    throw error;
  }
}

async function ensureEntityIdentityV1(dbHandle) {
  if (ready.has(dbHandle)) return;
  const current = inFlight.get(dbHandle);
  if (current) return current;
  const task = (async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await runEnsure(dbHandle);
        ready.add(dbHandle);
        return;
      } catch (error) {
        if (!/cannot start a transaction within a transaction/i.test(String(error?.message || error)) || attempt === 39) throw error;
        await wait(25);
      }
    }
  })().finally(() => inFlight.delete(dbHandle));
  inFlight.set(dbHandle, task);
  return task;
}

module.exports = { ENTITY_UIDS, createUuid, ensureEntityIdentityV1 };
