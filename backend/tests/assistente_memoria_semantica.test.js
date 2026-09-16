const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const memory = require('../services/assistente/conversationMemory');
const runtimeTools = require('../services/assistente/agent/runtimeReadTools');
const { __internal: agentInternal } = require('../services/assistente/agent/agentLoop');

function financialResult(rows, extra = {}) {
  return {
    entity_type: 'cliente',
    description: 'Clientes com saldo em aberto',
    filters: { period_reference: 'ultimos_30_dias', cpf: 'nao-persistir' },
    tool_result: {
      sql_fingerprint: 'fingerprint-teste',
      returned_rows: rows.length,
      truncated: false,
      rows,
      ...extra,
    },
  };
}

async function executeBoundAnalysis({ entityType, scopeSql, analyticSql }) {
  assert.equal(agentInternal.isScopeSqlForEntity(scopeSql, entityType), true);
  assert.equal(agentInternal.isAnalyticSqlBoundToScope(analyticSql, entityType), true);
  const scope = await runtimeTools.executeScopeReadOnlySql({ sql: scopeSql });
  assert.equal(scope.scope_complete, true);
  const analytic = await runtimeTools.executeReadOnlySql({
    sql: analyticSql,
    semanticResultSet: {
      result_set_id: 'teste-escopo',
      entity_type: entityType,
      entity_ids: scope.entity_ids,
    },
  });
  return { scope, analytic };
}

test('cria result_set por sessao, preserva IDs e remove PII', () => {
  memory.resetSessionMemory('mem-a');
  const update = memory.recordConversationTurn({
    sessionId: 'mem-a', turnId: '1', userText: 'consulta', answerText: 'ok',
    financialResult: financialResult([
      { cliente_id: 11, nome: 'Ana', cpf: '000', telefone: '9999', total: 120 },
      { cliente_id: 22, nome: 'Bruno', endereco: 'x', total: 80 },
      { cliente_id: 11, nome: 'Ana' },
    ]),
  });

  assert.equal(update.result_set.type, 'cliente');
  assert.equal(update.result_set.entity_count, 2);
  assert.equal(Object.hasOwn(update.result_set.filters, 'cpf'), false);
  const stored = memory.getResultSetById('mem-a', update.result_set.result_set_id);
  assert.deepEqual(stored.entity_ids, [11, 22]);
  assert.equal(memory.getResultSetById('mem-b', update.result_set.result_set_id), null);

  const compact = memory.getSessionMemorySnapshot('mem-a');
  assert.equal(JSON.stringify(compact).includes('000'), false);
  assert.equal(JSON.stringify(compact).includes('9999'), false);
  assert.equal(Object.hasOwn(compact.result_sets[0], 'entity_ids'), false);
  assert.equal(memory.__internal.inferEntityType('', [{ parcela_id: 7 }]), 'parcela');
});

test('mantem multiplos result_sets, aplica limite e expira conjuntos', () => {
  memory.resetSessionMemory('mem-limite');
  for (let i = 1; i <= 15; i += 1) {
    memory.recordConversationTurn({
      sessionId: 'mem-limite', turnId: String(i), userText: 'consulta', answerText: 'ok',
      financialResult: financialResult([{ cliente_id: i }]),
    });
  }
  const snapshot = memory.getSessionMemorySnapshot('mem-limite');
  assert.equal(memory.pruneResultSets('mem-limite').length, memory.__internal.MAX_RESULT_SETS);
  assert.equal(snapshot.result_sets.length, 4);

  const afterExpiry = memory.pruneResultSets(
    'mem-limite',
    Date.now() + memory.__internal.RESULT_SET_TTL_MS + 1
  );
  assert.equal(afterExpiry.length, 0);
});

test('result_set pode ser reutilizado por CTE parametrizada sem expor IDs ao planner', () => {
  memory.resetSessionMemory('mem-reuso');
  const update = memory.recordConversationTurn({
    sessionId: 'mem-reuso', turnId: '1', userText: 'consulta', answerText: 'ok',
    financialResult: financialResult([{ cliente_id: 31 }, { cliente_id: 42 }]),
  });
  const resultSet = memory.getResultSetById('mem-reuso', update.result_set.result_set_id);
  const query = 'SELECT c.id FROM clientes c JOIN semantic_result_set rs ON rs.entity_id = c.id';
  const injected = runtimeTools.__internal.injectSemanticResultSet(query, resultSet);

  assert.equal(runtimeTools.isReadOnlySql(query), false);
  assert.equal(runtimeTools.isReadOnlySql(query, { allowSemanticResultSet: true }), true);
  assert.match(injected.sql, /^WITH semantic_result_set\(entity_id\) AS \(VALUES \(\?\), \(\?\)\)/);
  assert.deepEqual(injected.params, [31, 42]);
  assert.equal(injected.applied, true);
});

test('resultado agregado preserva escopo completo mesmo sem IDs na resposta visual', () => {
  memory.resetSessionMemory('mem-escopo-agregado');
  const ids = Array.from({ length: 423 }, (_, index) => index + 1);
  const update = memory.recordConversationTurn({
    sessionId: 'mem-escopo-agregado', turnId: '1', userText: 'consulta', answerText: '423',
    financialResult: {
      entity_type: 'agregado',
      tool_result: {
        sql_fingerprint: 'analitica-count', returned_rows: 1, truncated: false,
        rows: [{ total_clientes: 423 }],
      },
      semantic_scope: {
        entity_type: 'cliente', entity_ids: ids, scope_complete: true,
        entity_count_lower_bound: 423,
      },
    },
  });
  const stored = memory.getResultSetById('mem-escopo-agregado', update.result_set.result_set_id);
  const compact = memory.getSessionMemorySnapshot('mem-escopo-agregado').result_sets[0];

  assert.equal(stored.entity_ids.length, 423);
  assert.equal(stored.scope_complete, true);
  assert.equal(compact.entity_count, 423);
  assert.equal(compact.scope_complete, true);
  assert.equal(Object.hasOwn(compact, 'entity_ids'), false);
});

test('limite de escopo e explicito e impede reutilizacao de conjunto incompleto', () => {
  memory.resetSessionMemory('mem-escopo-limite');
  const ids = Array.from({ length: memory.__internal.MAX_RESULT_SET_IDS }, (_, index) => index + 1);
  const update = memory.recordConversationTurn({
    sessionId: 'mem-escopo-limite', turnId: '1', userText: 'consulta', answerText: 'muitos',
    financialResult: {
      tool_result: { sql_fingerprint: 'escopo-grande', returned_rows: 1, rows: [{ total: 2500 }] },
      semantic_scope: {
        entity_type: 'cliente', entity_ids: ids, scope_complete: false,
        entity_count_lower_bound: memory.__internal.MAX_RESULT_SET_IDS + 1,
      },
    },
  });
  const stored = memory.getResultSetById('mem-escopo-limite', update.result_set.result_set_id);
  const compact = memory.getSessionMemorySnapshot('mem-escopo-limite').result_sets[0];
  assert.equal(stored.entity_ids.length, memory.__internal.MAX_RESULT_SET_IDS);
  assert.equal(stored.scope_complete, false);
  assert.equal(compact.entity_count_lower_bound, memory.__internal.MAX_RESULT_SET_IDS + 1);
});

test('consulta de escopo usa a mesma camada read-only e nao altera a base', async () => {
  const dbPath = path.resolve(__dirname, '../models/data/database.db');
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  const before = hash();
  const scope = await runtimeTools.executeScopeReadOnlySql({
    sql: 'SELECT c.id AS entity_id FROM clientes c ORDER BY c.id LIMIT 3',
  });
  const after = hash();
  assert.equal(scope.source, 'query_financial_scope');
  assert.equal(scope.scope_complete, true);
  assert.equal(before, after);
  await assert.rejects(
    runtimeTools.executeScopeReadOnlySql({ sql: 'DELETE FROM clientes' }),
    /SQL bloqueada/
  );
});

test('COUNT, SUM e AVG calculam sobre o mesmo escopo materializado', async () => {
  const clientScopeSql = 'SELECT DISTINCT scope_root.id AS entity_id FROM clientes AS scope_root';
  const countSql = 'SELECT COUNT(*) AS total FROM clientes AS scope_root JOIN semantic_result_set AS scope_ids ON scope_ids.entity_id = scope_root.id';
  const counted = await executeBoundAnalysis({
    entityType: 'cliente', scopeSql: clientScopeSql, analyticSql: countSql,
  });
  assert.equal(Number(counted.analytic.rows[0].total), counted.scope.entity_ids.length);

  const loanScopeSql = 'SELECT DISTINCT scope_root.id AS entity_id FROM emprestimos AS scope_root';
  const sumSql = 'SELECT COALESCE(SUM(scope_root.valor), 0) AS total FROM emprestimos AS scope_root JOIN semantic_result_set AS scope_ids ON scope_ids.entity_id = scope_root.id';
  const avgSql = 'SELECT COALESCE(AVG(scope_root.valor), 0) AS media FROM emprestimos AS scope_root JOIN semantic_result_set AS scope_ids ON scope_ids.entity_id = scope_root.id';
  const summed = await executeBoundAnalysis({ entityType: 'emprestimo', scopeSql: loanScopeSql, analyticSql: sumSql });
  const averaged = await executeBoundAnalysis({ entityType: 'emprestimo', scopeSql: loanScopeSql, analyticSql: avgSql });
  assert.equal(summed.analytic.returned_rows, 1);
  assert.equal(averaged.analytic.returned_rows, 1);
});

test('analise divergente e rejeitada e ranking reutilizado permanece dentro do escopo', async () => {
  const invalidSql = 'SELECT COUNT(*) AS total FROM clientes AS scope_root JOIN semantic_result_set AS scope_ids ON 1 = 1';
  const missingScopeSql = 'SELECT COUNT(*) AS total FROM clientes AS scope_root';
  assert.equal(agentInternal.isAnalyticSqlBoundToScope(invalidSql, 'cliente'), false);
  assert.equal(agentInternal.isAnalyticSqlBoundToScope(missingScopeSql, 'cliente'), false);

  const scopeSql = 'SELECT DISTINCT scope_root.id AS entity_id FROM clientes AS scope_root';
  const rankingSql = 'SELECT scope_root.id AS cliente_id, COUNT(e.id) AS total_emprestimos FROM clientes AS scope_root JOIN semantic_result_set AS scope_ids ON scope_ids.entity_id = scope_root.id LEFT JOIN emprestimos e ON e.cliente_id = scope_root.id GROUP BY scope_root.id ORDER BY total_emprestimos DESC';
  const ranked = await executeBoundAnalysis({ entityType: 'cliente', scopeSql, analyticSql: rankingSql });
  const ids = new Set(ranked.scope.entity_ids);
  assert.ok(ranked.analytic.rows.every((row) => ids.has(Number(row.cliente_id))));
});

test('reset explicito limpa memoria sem interpretar a linguagem do usuario', () => {
  memory.resetSessionMemory('mem-reset');
  memory.recordConversationTurn({
    sessionId: 'mem-reset', turnId: '1', userText: 'consulta', answerText: 'ok',
    financialResult: financialResult([{ cliente_id: 5 }]),
  });
  assert.equal(memory.maybeResetSessionContext('mem-reset', 'qualquer texto livre'), false);
  assert.equal(memory.getSessionMemorySnapshot('mem-reset').result_sets.length, 1);
  memory.resetSessionMemory('mem-reset');
  const snapshot = memory.getSessionMemorySnapshot('mem-reset');
  assert.equal(snapshot.result_sets.length, 0);
  assert.equal(snapshot.recent_turns.length, 0);
});
