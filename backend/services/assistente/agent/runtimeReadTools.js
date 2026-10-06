const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { getDbPath, getLogsDir } = require('../../../utils/paths');

function clampInteger(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function normalizeSql(sql) {
  return String(sql || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasMultipleStatements(sql) {
  const raw = String(sql || '').trim();
  if (!raw) return false;
  const withoutTrailing = raw.replace(/;\s*$/, '');
  return withoutTrailing.includes(';');
}

const FINANCIAL_TABLES = new Set([
  'clientes',
  'emprestimos',
  'parcelas',
  'parcelas_originais',
  'pagamentos',
  'renegociacoes',
  'renegociacoes_historico',
  'recalculos_atraso',
  'notificacoes',
  'caixa_movimentos',
]);

const SENSITIVE_COLUMNS = new Set([
  'cpf',
  'telefone',
  'endereco',
  'foto_cliente',
  'referencia',
  'observacao',
  'snapshot_emprestimo',
  'snapshot_parcelas',
  'detalhes',
  'detalhes_json',
  'meta_json',
]);
const MAX_VISUAL_ROWS = 100;
const MAX_SCOPE_ENTITY_IDS = 2000;

function removeSqlLiterals(sql) {
  return String(sql || '')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}

function removeSingleQuotedLiterals(sql) {
  // Em SQLite aspas duplas tambem podem delimitar identificadores. Elas devem
  // permanecer nesta versao para que colunas sensiveis como "cpf" sejam
  // bloqueadas, sem bloquear uma simples string literal 'cpf'.
  return String(sql || '').replace(/'(?:''|[^'])*'/g, "''");
}

function referencedTables(sql) {
  const source = removeSqlLiterals(sql).toLowerCase();
  const cteAliases = new Set();
  const cteMatcher = /\b(?:with|,)\s*([a-z_][a-z0-9_]*)\s+as\s*\(/g;
  let cteMatch = cteMatcher.exec(source);
  while (cteMatch) {
    cteAliases.add(cteMatch[1]);
    cteMatch = cteMatcher.exec(source);
  }
  const tables = [];
  const matcher = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)/g;
  let match = matcher.exec(source);
  while (match) {
    if (!cteAliases.has(match[1])) tables.push(match[1]);
    match = matcher.exec(source);
  }
  return tables;
}

function isReadOnlySql(sql, { allowSemanticResultSet = false } = {}) {
  const raw = String(sql || '').trim();
  const normalized = normalizeSql(raw).toLowerCase();
  if (!normalized || raw.length > 6000) return false;
  if (!normalized.startsWith('select ') && !normalized.startsWith('with ')) return false;
  if (hasMultipleStatements(normalized)) return false;

  // Comentarios e comandos especiais tornam uma validacao lexical ambigua.
  if (/--|\/\*|\*\//.test(raw)) return false;

  const withoutLiterals = removeSqlLiterals(normalized);
  const withoutSingleQuoted = removeSingleQuotedLiterals(normalized);
  const forbidden = /\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|vacuum|reindex|begin|commit|rollback|pragma|explain|analyze|load_extension|writable_schema|recursive)\b/i;
  if (forbidden.test(withoutLiterals)) return false;

  if (/\bsqlite_[a-z0-9_]*\b/i.test(withoutLiterals)) return false;
  if (/\b(?:cpf|telefone|endereco|foto_cliente|referencia|observacao|snapshot_emprestimo|snapshot_parcelas|detalhes|detalhes_json|meta_json)\b/i.test(withoutSingleQuoted)) return false;
  // Exigir colunas explicitas impede que clientes.* transporte PII ao modelo.
  if (/\b(?:select|,)\s*(?:[a-z_][a-z0-9_]*\.)?\*/i.test(withoutLiterals)) return false;

  const tables = referencedTables(normalized);
  return tables.length > 0 && tables.every((table) => (
    FINANCIAL_TABLES.has(table) || (allowSemanticResultSet && table === 'semantic_result_set')
  ));
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex');
}

async function discoverActiveDatabase() {
  const dbPath = getDbPath();
  let sizeBytes = 0;
  let exists = false;
  try {
    const stat = fs.statSync(dbPath);
    exists = true;
    sizeBytes = Number(stat.size || 0);
  } catch {
    exists = false;
    sizeBytes = 0;
  }

  return {
    db_path: dbPath,
    exists,
    size_bytes: sizeBytes,
    source: 'runtime_db_info',
  };
}

async function inspectDatabaseSchema({ maxTables = 80, includeColumns = true } = {}) {
  const limit = clampInteger(maxTables, 1, 200, 80);
  let connection = null;
  try {
    connection = await openReadOnlyConnection();
    connection.configure('busyTimeout', 1500);
    const objects = await allFromConnection(
      connection,
      `SELECT name, type
         FROM sqlite_master
        WHERE type IN ('table', 'view')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY type ASC, name ASC
        LIMIT ?`,
      [limit]
    );

    if (!includeColumns) {
      return {
        total_objects: objects.length,
        objects,
        source: 'runtime_schema_overview',
      };
    }

    const detailed = [];
    for (const item of objects) {
      const tableName = String(item && item.name ? item.name : '').trim();
      const objType = String(item && item.type ? item.type : '').trim();
      if (!tableName) continue;

      let columns = [];
      if (objType === 'table') {
        const escaped = tableName.replace(/"/g, '""');
        columns = await allFromConnection(connection, `PRAGMA table_info("${escaped}")`);
      }

      detailed.push({
        name: tableName,
        type: objType,
        columns: columns.map((c) => ({
          cid: c.cid,
          name: c.name,
          type: c.type,
          notnull: c.notnull,
          dflt_value: c.dflt_value,
          pk: c.pk,
        })),
      });
    }

    return {
      total_objects: detailed.length,
      objects: detailed,
      source: 'runtime_schema_overview',
    };
  } finally {
    await closeConnection(connection);
  }
}

function openReadOnlyConnection() {
  const dbPath = getDbPath();
  return new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
      return resolve(connection);
    });
  });
}

function closeConnection(connection) {
  return new Promise((resolve) => {
    if (!connection) return resolve();
    connection.close(() => resolve());
  });
}

function allFromConnection(connection, sql, params = [], timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        connection.interrupt();
      } catch (_) {}
    }, timeoutMs);
    connection.all(sql, params, (err, rows) => {
      clearTimeout(timer);
      if (err) return reject(err);
      return resolve(rows || []);
    });
  });
}

function normalizeSemanticResultSet(rawValue) {
  if (!rawValue || typeof rawValue !== 'object' || !Array.isArray(rawValue.entity_ids)) return null;
  const raw = rawValue;
  const entityIds = [...new Set(raw.entity_ids
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))]
    .slice(0, MAX_SCOPE_ENTITY_IDS);
  return {
    result_set_id: String(raw.result_set_id || '').trim().slice(0, 120),
    entity_type: String(raw.entity_type || '').trim().slice(0, 80),
    entity_ids: entityIds,
  };
}

function injectSemanticResultSet(sql, semanticResultSet) {
  const resultSet = normalizeSemanticResultSet(semanticResultSet);
  if (!resultSet) return { sql, params: [], applied: false };

  const cte = resultSet.entity_ids.length
    ? `semantic_result_set(entity_id) AS (VALUES ${resultSet.entity_ids.map(() => '(?)').join(', ')})`
    : 'semantic_result_set(entity_id) AS (SELECT CAST(NULL AS INTEGER) WHERE 0)';
  const raw = String(sql || '').trim().replace(/;\s*$/, '');
  const executionSql = /^with\s+/i.test(raw)
    ? raw.replace(/^with\s+/i, `WITH ${cte}, `)
    : `WITH ${cte} ${raw}`;
  return { sql: executionSql, params: resultSet.entity_ids, applied: true };
}

async function executeReadOnlySql({
  sql,
  maxRows = 120,
  semanticResultSet = null,
  scopeCapture = false,
} = {}) {
  const query = String(sql || '').trim();
  if (!query) {
    throw new Error('SQL vazia em query_financial_data.');
  }
  const normalizedResultSet = normalizeSemanticResultSet(semanticResultSet);
  if (!isReadOnlySql(query, { allowSemanticResultSet: Boolean(normalizedResultSet) })) {
    throw new Error('SQL bloqueada: use uma unica consulta SELECT/WITH sobre tabelas financeiras permitidas, sem dados pessoais sensiveis.');
  }

  const hardLimit = scopeCapture ? MAX_SCOPE_ENTITY_IDS : MAX_VISUAL_ROWS;
  const rowLimit = clampInteger(maxRows, 1, hardLimit, hardLimit);
  const startedAt = Date.now();
  let connection = null;
  try {
    connection = await openReadOnlyConnection();
    connection.configure('busyTimeout', 1500);
    const contextualQuery = injectSemanticResultSet(query, normalizedResultSet);
    // O wrapper aplica o limite no SQLite, inclusive se o SQL gerado nao tiver LIMIT.
    const boundedQuery = `SELECT * FROM (${contextualQuery.sql}) AS assistant_query LIMIT ?`;
    const rows = await allFromConnection(
      connection,
      boundedQuery,
      [...contextualQuery.params, rowLimit + 1],
      2500
    );
    const truncated = rows.length > rowLimit;
    const safeRows = truncated ? rows.slice(0, rowLimit) : rows;
    const columns = safeRows.length && safeRows[0] && typeof safeRows[0] === 'object'
      ? Object.keys(safeRows[0])
      : [];

    return {
      sql: query,
      sql_fingerprint: sha1(normalizeSql(query).toLowerCase()),
      returned_rows: safeRows.length,
      truncated,
      columns,
      rows: safeRows,
      latency_ms: Date.now() - startedAt,
      source: 'query_financial_data',
      semantic_result_set_applied: contextualQuery.applied,
    };
  } finally {
    await closeConnection(connection);
  }
}

async function executeScopeReadOnlySql({ sql, maxRows = MAX_SCOPE_ENTITY_IDS } = {}) {
  const result = await executeReadOnlySql({
    sql,
    maxRows,
    scopeCapture: true,
  });
  const ids = [];
  for (const row of result.rows || []) {
    const keys = row && typeof row === 'object' ? Object.keys(row) : [];
    if (keys.length !== 1 || keys[0] !== 'entity_id') {
      throw new Error('SQL de escopo deve retornar exclusivamente a coluna entity_id.');
    }
    const id = Number(row.entity_id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('SQL de escopo retornou entity_id invalido.');
    }
    ids.push(id);
  }
  return {
    ...result,
    entity_ids: [...new Set(ids)],
    scope_complete: !result.truncated,
    scope_limit: MAX_SCOPE_ENTITY_IDS,
    entity_count_lower_bound: result.truncated ? MAX_SCOPE_ENTITY_IDS + 1 : ids.length,
    source: 'query_financial_scope',
  };
}

function tailLines(text, maxLines) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length <= maxLines) return lines;
  return lines.slice(lines.length - maxLines);
}

async function readBackendLogs({ file = 'backend.log', maxLines = 120 } = {}) {
  const safeMaxLines = clampInteger(maxLines, 10, 600, 120);
  const fileName = String(file || 'backend.log').trim();
  if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    throw new Error('Nome de arquivo de log invalido.');
  }

  const logsDir = getLogsDir();
  const absPath = path.join(logsDir, fileName);
  if (!fs.existsSync(absPath)) {
    return {
      file: fileName,
      exists: false,
      lines: [],
      source: 'runtime_logs_tail',
    };
  }

  const raw = fs.readFileSync(absPath, 'utf8');
  const lines = tailLines(raw, safeMaxLines);

  return {
    file: fileName,
    exists: true,
    line_count: lines.length,
    lines,
    source: 'runtime_logs_tail',
  };
}

function sanitizePathPrefix(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw.startsWith('/')) return `/${raw}`;
  return raw;
}

function isAllowedEndpoint(pathname) {
  const pathText = sanitizePathPrefix(pathname).toLowerCase();
  if (pathText.startsWith('/assistente')) return false;
  const allowPrefixes = [
    '/health',
    '/caixa',
    '/relatorio',
    '/notificacoes',
    '/clientes',
    '/emprestimos',
    '/parcelas',
    '/pagamentos',
    '/backup',
  ];
  return allowPrefixes.some((prefix) => pathText === prefix || pathText.startsWith(`${prefix}/`));
}

async function fetchInternalEndpoint({ path: endpointPath = '/health', query = {}, timeoutMs = 3000 } = {}) {
  const pathname = sanitizePathPrefix(endpointPath);
  if (!isAllowedEndpoint(pathname)) {
    throw new Error(`Endpoint bloqueado para leitura interna: ${pathname}`);
  }

  const url = new URL(`http://127.0.0.1:${Number(process.env.BACKEND_PORT || process.env.PORT || 3001)}${pathname}`);
  if (query && typeof query === 'object' && !Array.isArray(query)) {
    for (const [key, value] of Object.entries(query)) {
      if (value == null) continue;
      url.searchParams.set(String(key), String(value));
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), clampInteger(timeoutMs, 500, 20000, 3000));

  try {
    const startedAt = Date.now();
    const resp = await fetch(url.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
      },
    });
    const elapsed = Date.now() - startedAt;

    const contentType = String(resp.headers.get('content-type') || '');
    let body = null;
    if (contentType.includes('application/json')) {
      body = await resp.json().catch(() => null);
    } else {
      body = await resp.text().catch(() => '');
    }

    return {
      path: pathname,
      url: url.toString(),
      status: resp.status,
      ok: resp.ok,
      latency_ms: elapsed,
      body,
      source: 'runtime_endpoint_get',
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  discoverActiveDatabase,
  inspectDatabaseSchema,
  executeReadOnlySql,
  executeScopeReadOnlySql,
  readBackendLogs,
  fetchInternalEndpoint,
  isReadOnlySql,
  FINANCIAL_TABLES,
  SENSITIVE_COLUMNS,
  MAX_SCOPE_ENTITY_IDS,
  __internal: {
    normalizeSemanticResultSet,
    injectSemanticResultSet,
  },
};
