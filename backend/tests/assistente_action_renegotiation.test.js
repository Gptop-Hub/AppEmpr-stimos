const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { runAsync, getAsync, allAsync } = require('../utils/sqliteAsync');
const command = require('../services/assistente/actions/renegotiationCommand');
const { createActionGateway, createMemoryAuditStore } = require('../services/assistente/actions/actionGateway');
const { createActionRegistry } = require('../services/assistente/actions/actionRegistry');
const actions = require('../services/actionService');
const migrationSql = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', 'create_action_tables.sql'), 'utf8');

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistente-renegociar-'));
  const db = new sqlite3.Database(path.join(directory, 'fixture.db'));
  await runAsync(db, 'CREATE TABLE clientes(id INTEGER PRIMARY KEY, nome TEXT, cpf TEXT)');
  await runAsync(db, 'CREATE TABLE emprestimos(id INTEGER PRIMARY KEY, cliente_id INTEGER, modalidade TEXT, ativo INTEGER, versao_atual INTEGER, valor REAL, valor_atual REAL, valor_emprestado REAL, capital_restante REAL, taxa_juros REAL, parcelas INTEGER, data TEXT, dia_pagamento INTEGER, observacao TEXT, updated_at TEXT)');
  await runAsync(db, 'CREATE TABLE parcelas(id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER, numero INTEGER, valor_total REAL, valor_capital REAL, valor_juros REAL, juros_pendentes REAL, juros_adicionais REAL, valor_pago REAL, valor_excedente REAL, pago INTEGER, vencimento TEXT, versao INTEGER, data_pagamento TEXT, observacao TEXT, explicacao TEXT)');
  await runAsync(db, 'CREATE TABLE parcelas_originais(id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER, numero INTEGER, valor_total REAL, valor_capital REAL, valor_juros REAL, valor_pago REAL, valor_excedente REAL, pago INTEGER, data_pagamento TEXT)');
  await runAsync(db, 'CREATE TABLE pagamentos(id INTEGER PRIMARY KEY, emprestimo_id INTEGER, valor REAL, data TEXT, tipo_pagamento TEXT, parcela_origem INTEGER, renegociacao_id INTEGER)');
  await runAsync(db, 'CREATE TABLE renegociacoes_historico(id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER, versao INTEGER, snapshot_emprestimo TEXT, snapshot_parcelas TEXT, tipo TEXT, observacao TEXT, detalhes TEXT, created_at TEXT)');
  await new Promise((resolve, reject) => db.exec(migrationSql, (error) => error ? reject(error) : resolve()));
  await runAsync(db, "INSERT INTO clientes VALUES(1, 'Cliente de Teste', '111.222.333-44')");
  await runAsync(db, "INSERT INTO emprestimos VALUES(10, 1, 'parcelado', 1, 2, 150, 150, 200, 150, 8, 2, '2026-01-15', 15, 'original', NULL)");
  await runAsync(db, "INSERT INTO parcelas(emprestimo_id,numero,valor_total,valor_capital,valor_juros,juros_pendentes,juros_adicionais,valor_pago,valor_excedente,pago,vencimento,versao,data_pagamento,observacao) VALUES(10,1,108,100,8,0,0,50,0,0,'2026-08-15',2,NULL,'')");
  await runAsync(db, "INSERT INTO parcelas(emprestimo_id,numero,valor_total,valor_capital,valor_juros,juros_pendentes,juros_adicionais,valor_pago,valor_excedente,pago,vencimento,versao,data_pagamento,observacao) VALUES(10,2,54,50,4,2,1,0,0,0,'2026-09-15',2,NULL,'')");
  await runAsync(db, "INSERT INTO pagamentos VALUES(7,10,50,'2026-08-01','normal',0,NULL)");
  const wrapped = {
    normalizeIntent: command.normalizeIntent,
    createPaymentPreview: (intent) => command.createPaymentPreview(intent, { dbHandle: db }),
    executePayment: (intent, fingerprint) => command.executePayment(intent, fingerprint, { dbHandle: db }),
  };
  return { db, wrapped, async close() { await new Promise((resolve) => db.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); } };
}

function intent(extra = {}) { return { action: 'renegociar_emprestimo', cliente_id: 1, emprestimo_id: 10, valor: 180, parcelas: 3, taxa_juros: 10, data: '2026-08-19', data_pagamento: '2026-09-10', ...extra }; }
async function dump(db) { const tables = ['emprestimos', 'parcelas', 'parcelas_originais', 'pagamentos', 'renegociacoes_historico']; const result = {}; for (const table of tables) { try { result[table] = await allAsync(db, `SELECT * FROM ${table} ORDER BY id`); } catch { result[table] = null; } } return result; }

test('renegociação cria preview sem escrita e aplica o mesmo cronograma com snapshot e nova versão', async () => {
  const f = await fixture();
  try {
    const audit = createMemoryAuditStore();
    const gateway = createActionGateway({ actionRegistry: createActionRegistry({ renegotiationCommand: f.wrapped }), auditStore: audit });
    const before = JSON.stringify(await dump(f.db));
    const prepared = await gateway.createPreview({ sessionId: 'sessao-1', intent: intent() });
    assert.equal(JSON.stringify(await dump(f.db)), before);
    assert.equal(prepared.preview.renegociacao.novo_acordo.total_previsto, 216);
    assert.equal(prepared.preview.renegociacao.cronograma.length, 3);
    await gateway.confirm({ sessionId: 'sessao-1', confirmationToken: prepared.confirmation_token });
    const loan = await getAsync(f.db, 'SELECT versao_atual,capital_restante,taxa_juros,parcelas FROM emprestimos WHERE id=10');
    assert.deepEqual({ ...loan }, { versao_atual: 3, capital_restante: 180, taxa_juros: 10, parcelas: 3 });
    const current = await allAsync(f.db, 'SELECT numero,valor_total,valor_capital,valor_juros,versao,pago FROM parcelas ORDER BY numero');
    assert.deepEqual(current.map((row) => ({ ...row })), [
      { numero: 1, valor_total: 78, valor_capital: 60, valor_juros: 18, versao: 3, pago: 0 },
      { numero: 2, valor_total: 72, valor_capital: 60, valor_juros: 12, versao: 3, pago: 0 },
      { numero: 3, valor_total: 66, valor_capital: 60, valor_juros: 6, versao: 3, pago: 0 },
    ]);
    const history = await getAsync(f.db, 'SELECT versao,snapshot_emprestimo,snapshot_parcelas FROM renegociacoes_historico');
    assert.equal(history.versao, 2); assert.equal(JSON.parse(history.snapshot_parcelas).length, 2); assert.equal(JSON.parse(history.snapshot_emprestimo).capital_restante, 150);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) total FROM pagamentos')).total, 1);
    const action = (await actions.listarAcoes({ tipo: 'EMPRESTIMO_RENEGOCIADO', emprestimo_id: 10 }, { dbHandle: f.db }))[0];
    const actionDetail = await actions.buscarAcaoPorId(action.id, { dbHandle: f.db });
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) total FROM acoes')).total, 1);
    assert.equal(actionDetail.snapshots.length, 2);
    assert.equal(actionDetail.snapshots.find((snapshot) => snapshot.momento === 'antes').dados.estado.parcelas.length, 2);
    assert.equal(actionDetail.snapshots.find((snapshot) => snapshot.momento === 'depois').dados.estado.parcelas.length, 3);
    assert.equal(audit.entries[0].preview.valor, 180); assert.doesNotMatch(JSON.stringify(audit.entries), /Cliente de Teste|111\.222/);
  } finally { await f.close(); }
});

test('renegociação rejeita termos ausentes ou extras e invalida preview quando estado muda', async () => {
  const f = await fixture();
  try {
    const gateway = createActionGateway({ actionRegistry: createActionRegistry({ renegotiationCommand: f.wrapped }), auditStore: createMemoryAuditStore() });
    await assert.rejects(() => gateway.createPreview({ sessionId: 's', intent: { ...intent(), desconto: 1 } }), { code: 'invalid_action_contract' });
    await assert.rejects(() => gateway.createPreview({ sessionId: 's', intent: { ...intent(), taxa_juros: null } }), { code: 'invalid_rate' });
    const prepared = await gateway.createPreview({ sessionId: 's', intent: intent() });
    await runAsync(f.db, 'UPDATE parcelas SET juros_adicionais = 9 WHERE emprestimo_id = 10 AND numero = 2');
    await assert.rejects(() => gateway.confirm({ sessionId: 's', confirmationToken: prepared.confirmation_token }), { code: 'state_changed' });
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) total FROM renegociacoes_historico')).total, 0);
  } finally { await f.close(); }
});

test('renegociacao persiste o ajuste de capital na ultima parcela', async () => {
  const f = await fixture();
  try {
    const gateway = createActionGateway({ actionRegistry: createActionRegistry({ renegotiationCommand: f.wrapped }), auditStore: createMemoryAuditStore() });
    const prepared = await gateway.createPreview({
      sessionId: 'sessao-residuo',
      intent: intent({ valor: 1624.90, parcelas: 3, taxa_juros: 0 }),
    });

    await gateway.confirm({ sessionId: 'sessao-residuo', confirmationToken: prepared.confirmation_token });
    const current = await allAsync(f.db, 'SELECT numero, valor_capital, explicacao FROM parcelas ORDER BY numero');

    assert.deepEqual(current.map((row) => row.valor_capital), [541.63, 541.63, 541.64]);
    assert.equal(
      current[2].explicacao,
      'Ajuste de R$ 0,01 aplicado nesta parcela para fechar corretamente o capital total do empréstimo.'
    );
  } finally { await f.close(); }
});

test('falha ao registrar ação reverte a renegociação e não consome sequência', async () => {
  const f = await fixture();
  try {
    const gateway = createActionGateway({ actionRegistry: createActionRegistry({ renegotiationCommand: f.wrapped }), auditStore: createMemoryAuditStore() });
    const prepared = await gateway.createPreview({ sessionId: 'rollback', intent: intent() });
    await runAsync(f.db, "CREATE TRIGGER falha_snapshot BEFORE INSERT ON acao_snapshots BEGIN SELECT RAISE(ABORT, 'falha auditoria'); END;");
    try {
      await assert.rejects(
        () => gateway.confirm({ sessionId: 'rollback', confirmationToken: prepared.confirmation_token }),
        /falha auditoria/
      );
    } finally {
      await runAsync(f.db, 'DROP TRIGGER falha_snapshot');
    }
    assert.equal((await getAsync(f.db, 'SELECT versao_atual FROM emprestimos WHERE id=10')).versao_atual, 2);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM parcelas WHERE emprestimo_id=10')).total, 2);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM renegociacoes_historico')).total, 0);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 0);
    assert.equal((await getAsync(f.db, 'SELECT next_sequence FROM action_origin_state WHERE id=1')).next_sequence, 1);
  } finally { await f.close(); }
});
