const db = require('../../../models/database');
const { allAsync } = require('../../../utils/sqliteAsync');

const columnCache = new Map();

async function getTableColumns(tableName, options = {}) {
  const table = String(tableName || '').trim();
  if (!table) return new Set();

  const dbHandle = options.dbHandle || db;
  const useCache = options.useCache !== false;
  const cacheKey = table.toLowerCase();

  if (useCache && columnCache.has(cacheKey)) {
    return columnCache.get(cacheKey);
  }

  const rows = await allAsync(dbHandle, `PRAGMA table_info(${table})`);
  const cols = new Set((rows || []).map((row) => row && row.name).filter(Boolean));

  if (useCache) {
    columnCache.set(cacheKey, cols);
  }

  return cols;
}

function clearTableColumnsCache() {
  columnCache.clear();
}

module.exports = {
  getTableColumns,
  clearTableColumnsCache,
};

