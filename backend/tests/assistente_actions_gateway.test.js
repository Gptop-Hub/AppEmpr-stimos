const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { runAsync, getAsync } = require('../utils/sqliteAsync');
const paymentCommand = require('../services/assistente/actions/paymentCommand');
const { createActionGateway, createMemoryAuditStore } = require('../services/assistente/actions/actionGateway');

async function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistente-actions-'));
  const db = new sqlite3.Database(path.join(dir, 'fixture.db'));
  await runAsync(db, `CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT, cpf TEXT, telefone TEXT)`);
  await runAsync(db, `CREATE TABLE emprestimos (id INTEGER PRIMARY KEY, cliente_id INTEGER, modalidade TEXT, versao_atual INTEGER)`);
  await runAsync(db, `CREATE TABLE parcelas (
    id INTEGER PRIMARY KEY, emprestimo_id INTEGER, numero INTEGER, valor_total REAL,
    valor_capital REAL, valor_juros REAL, valor_pago REAL, valor_excedente REAL,
    data_pagamento TEXT, vencimento TEXT, pago INTEGER, versao INTEGER, tipo_pagamento TEXT
  )`);
  await runAsync(db, `CREATE TABLE pagamentos (id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER, valor REAL, data TEXT, tipo_pagamento TEXT, observacao TEXT, parcela_origem INTEGER)`);
  await runAsync(db, `CREATE TABLE caixa_movimentos (id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER, cliente_id INTEGER, parcela_id INTEGER, parcela_numero INTEGER, data TEXT, valor_total REAL)`);
  await runAsync(db, `INSERT INTO clientes (id, nome, cpf, telefone) VALUES (1, 'Cliente de Teste', '111.222.333-44', '999999999')`);
  await runAsync(db, `INSERT INTO clientes (id, nome) VALUES (2, 'Outro Cliente')`);
  await runAsync(db, `INSERT INTO emprestimos (id, cliente_id, modalidade, versao_atual) VALUES (10, 1, 'parcelado', 1)`);
  await runAsync(db, `INSERT INTO parcelas (id, emprestimo_id, numero, valor_total, valor_capital, valor_juros, valor_pago, valor_excedente, vencimento, pago, versao)
                     VALUES (100, 10, 1, 110, 100, 10, 0, 0, '2026-08-20', 0, 1)`);

  const cash = async (payload) => runAsync(
    db,
    'INSERT INTO caixa_movimentos (emprestimo_id, cliente_id, parcela_id, parcela_numero, data, valor_total) VALUES (?, ?, ?, ?, ?, ?)',
    [payload.emprestimo_id, payload.cliente_id, payload.parcela_id, payload.parcela_numero, payload.data, payload.valor_total]
  );
  const service = {
    createPaymentPreview: (intent) => paymentCommand.createPaymentPreview(intent, { dbHandle: db }),
    executePayment: (args, fingerprint) => paymentCommand.executePayment(args, fingerprint, { dbHandle: db, registrarEntradaPagamento: cash }),
  };
  return { db, dir, service, async close() { await new Promise((resolve) => db.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function intent(overrides = {}) {
  return { action: 'registrar_pagamento', cliente_id: 1, emprestimo_id: 10, valor: 30, data: '2026-08-19', tipo_pagamento: 'normal', ...overrides };
}

test('preview de pagamento e token nao alteram o banco', async () => {
  const fixture = await makeFixture();
  try {
    const audit = createMemoryAuditStore();
    const gateway = createActionGateway({ paymentService: fixture.service, auditStore: audit });
    const preview = await gateway.createPreview({ sessionId: 'sess-a', intent: intent() });
    assert.ok(preview.confirmation_token);
    assert.equal(preview.preview.impacto.valor_pago_anterior, 0);
    assert.equal(preview.preview.impacto.valor_pago_posterior, 30);
    assert.equal((await getAsync(fixture.db, 'SELECT COUNT(*) AS total FROM pagamentos')).total, 0);
    assert.equal((await getAsync(fixture.db, 'SELECT valor_pago FROM parcelas WHERE id = 100')).valor_pago, 0);
    assert.doesNotMatch(JSON.stringify(audit.entries), /111\.222|999999999|Cliente de Teste/);
  } finally { await fixture.close(); }
});

test('token e vinculado a sessao, cancelavel e expira', async () => {
  const fixture = await makeFixture();
  try {
    let clock = 1_000;
    const gateway = createActionGateway({ paymentService: fixture.service, auditStore: createMemoryAuditStore(), now: () => clock, ttlMs: 100 });
    const first = await gateway.createPreview({ sessionId: 'sess-a', intent: intent() });
    await assert.rejects(() => gateway.confirm({ sessionId: 'sess-b', confirmationToken: first.confirmation_token }), { code: 'token_not_found' });
    await gateway.cancel({ sessionId: 'sess-a', confirmationToken: first.confirmation_token });
    await assert.rejects(() => gateway.confirm({ sessionId: 'sess-a', confirmationToken: first.confirmation_token }), { code: 'token_unavailable' });
    const second = await gateway.createPreview({ sessionId: 'sess-a', intent: intent() });
    clock += 1001;
    await assert.rejects(() => gateway.confirm({ sessionId: 'sess-a', confirmationToken: second.confirmation_token }), { code: 'token_expired' });
  } finally { await fixture.close(); }
});

test('confirmacao executa no maximo uma vez e ignora argumentos reenviados', async () => {
  const fixture = await makeFixture();
  try {
    const gateway = createActionGateway({ paymentService: fixture.service, auditStore: createMemoryAuditStore() });
    const preview = await gateway.createPreview({ sessionId: 'sess-a', intent: intent() });
    const result = await gateway.confirm({ sessionId: 'sess-a', confirmationToken: preview.confirmation_token, valor: 999999 });
    assert.equal(result.confirmed, true);
    assert.equal((await getAsync(fixture.db, 'SELECT COUNT(*) AS total FROM pagamentos')).total, 1);
    assert.equal((await getAsync(fixture.db, 'SELECT valor FROM pagamentos LIMIT 1')).valor, 30);
    assert.equal((await getAsync(fixture.db, 'SELECT COUNT(*) AS total FROM caixa_movimentos')).total, 1);
    await assert.rejects(() => gateway.confirm({ sessionId: 'sess-a', confirmationToken: preview.confirmation_token }), { code: 'token_unavailable' });
    assert.equal((await getAsync(fixture.db, 'SELECT COUNT(*) AS total FROM pagamentos')).total, 1);
  } finally { await fixture.close(); }
});

test('revalidacao bloqueia estado alterado e entradas invalidas', async () => {
  const fixture = await makeFixture();
  try {
    const gateway = createActionGateway({ paymentService: fixture.service, auditStore: createMemoryAuditStore() });
    await assert.rejects(() => gateway.createPreview({ sessionId: 's', intent: intent({ valor: 0 }) }), { code: 'invalid_amount' });
    await assert.rejects(() => gateway.createPreview({ sessionId: 's', intent: intent({ cliente_id: 999 }) }), { code: 'client_not_found' });
    await assert.rejects(() => gateway.createPreview({ sessionId: 's', intent: intent({ cliente_id: 2 }) }), { code: 'loan_client_mismatch' });
    await assert.rejects(() => gateway.createPreview({ sessionId: 's', intent: { ...intent(), extra: 'nao permitido' } }), { code: 'invalid_action_contract' });
    const preview = await gateway.createPreview({ sessionId: 's', intent: intent() });
    await runAsync(fixture.db, 'UPDATE parcelas SET valor_pago = 1 WHERE id = 100');
    await assert.rejects(() => gateway.confirm({ sessionId: 's', confirmationToken: preview.confirmation_token }), { code: 'state_changed' });
    assert.equal((await getAsync(fixture.db, 'SELECT COUNT(*) AS total FROM pagamentos')).total, 0);
    await runAsync(fixture.db, 'UPDATE parcelas SET pago = 1 WHERE id = 100');
    await assert.rejects(() => gateway.createPreview({ sessionId: 's', intent: intent() }), { code: 'loan_closed' });
  } finally { await fixture.close(); }
});

test('falha no caixa faz rollback de pagamento e parcela', async () => {
  const fixture = await makeFixture();
  try {
    const failingService = {
      createPaymentPreview: fixture.service.createPaymentPreview,
      executePayment: (args, fingerprint) => paymentCommand.executePayment(args, fingerprint, {
        dbHandle: fixture.db,
        registrarEntradaPagamento: async () => { throw new Error('caixa indisponivel'); },
      }),
    };
    const gateway = createActionGateway({ paymentService: failingService, auditStore: createMemoryAuditStore() });
    const preview = await gateway.createPreview({ sessionId: 's', intent: intent() });
    await assert.rejects(() => gateway.confirm({ sessionId: 's', confirmationToken: preview.confirmation_token }));
    assert.equal((await getAsync(fixture.db, 'SELECT COUNT(*) AS total FROM pagamentos')).total, 0);
    assert.equal((await getAsync(fixture.db, 'SELECT valor_pago FROM parcelas WHERE id = 100')).valor_pago, 0);
  } finally { await fixture.close(); }
});

test('falha na auditoria externa apos commit nao reporta falha financeira', async () => {
  const fixture = await makeFixture();
  try {
    const audit = {
      async record(entry) {
        if (entry.event === 'confirmed') throw new Error('auditoria indisponivel');
      },
    };
    const gateway = createActionGateway({ paymentService: fixture.service, auditStore: audit });
    const preview = await gateway.createPreview({ sessionId: 'sess-a', intent: intent() });
    const result = await gateway.confirm({ sessionId: 'sess-a', confirmationToken: preview.confirmation_token });
    assert.equal(result.confirmed, true);
    assert.equal((await getAsync(fixture.db, 'SELECT COUNT(*) AS total FROM pagamentos')).total, 1);
    await assert.rejects(
      () => gateway.confirm({ sessionId: 'sess-a', confirmationToken: preview.confirmation_token }),
      { code: 'token_unavailable' }
    );
  } finally { await fixture.close(); }
});
