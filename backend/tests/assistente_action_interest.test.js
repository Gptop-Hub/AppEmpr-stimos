const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { runAsync, getAsync } = require('../utils/sqliteAsync');
const interest = require('../services/assistente/actions/interestPaymentCommand');
const { createActionGateway, createMemoryAuditStore } = require('../services/assistente/actions/actionGateway');
const { createActionRegistry } = require('../services/assistente/actions/actionRegistry');

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistente-juros-')); const db = new sqlite3.Database(path.join(dir, 'fixture.db'));
  await runAsync(db, 'CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT)');
  await runAsync(db, 'CREATE TABLE emprestimos (id INTEGER PRIMARY KEY, cliente_id INTEGER, modalidade TEXT, versao_atual INTEGER, dia_pagamento INTEGER)');
  await runAsync(db, 'CREATE TABLE parcelas (id INTEGER PRIMARY KEY, emprestimo_id INTEGER, numero INTEGER, valor_total REAL, valor_capital REAL, valor_juros REAL, valor_pago REAL, valor_excedente REAL, data_pagamento TEXT, vencimento TEXT, pago INTEGER, versao INTEGER, juros_pendentes REAL, juros_adicionais REAL, observacao TEXT, explicacao TEXT, tipo_pagamento TEXT)');
  await runAsync(db, 'CREATE TABLE pagamentos (id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER, valor REAL, data TEXT, tipo_pagamento TEXT, observacao TEXT, parcela_origem INTEGER)');
  await runAsync(db, "INSERT INTO clientes VALUES (1, 'Cliente')"); await runAsync(db, "INSERT INTO emprestimos VALUES (10, 1, 'parcelado', 1, 20)");
  await runAsync(db, "INSERT INTO parcelas VALUES (100,10,1,110,100,10,0,0,NULL,'2026-08-20',0,1,5,2,'','',NULL)");
  await runAsync(db, "INSERT INTO parcelas VALUES (101,10,2,110,100,10,0,0,NULL,'2026-09-20',0,1,0,0,'','',NULL)");
  const cash = async () => {};
  const command = { createPaymentPreview: (i) => interest.createPaymentPreview(i, { dbHandle: db }), executePayment: (a, f) => interest.executePayment(a, f, { dbHandle: db, registrarEntradaPagamento: cash }), normalizeIntent: interest.normalizeIntent };
  return { db, command, async close() { await new Promise((r) => db.close(r)); fs.rmSync(dir, { recursive: true, force: true }); } };
}
function intent(overrides = {}) { return { action: 'registrar_pagamento_juros', cliente_id: 1, emprestimo_id: 10, valor: 17, data: '2026-08-19', ...overrides }; }
test('registry de juros prepara sem escrita e confirma transacionalmente a regra oficial', async () => {
  const f = await fixture(); try {
    const registry = createActionRegistry({ interestCommand: f.command }); const audit = createMemoryAuditStore(); const gateway = createActionGateway({ actionRegistry: registry, auditStore: audit });
    const preview = await gateway.createPreview({ sessionId: 's', intent: intent() });
    assert.equal(preview.preview.impacto.juros.total_antes, 17); assert.equal((await getAsync(f.db, 'SELECT COUNT(*) total FROM pagamentos')).total, 0);
    await gateway.confirm({ sessionId: 's', confirmationToken: preview.confirmation_token });
    const current = await getAsync(f.db, 'SELECT juros_pendentes, juros_adicionais, vencimento, pago FROM parcelas WHERE id=100');
    assert.deepEqual({ ...current }, { juros_pendentes: 0, juros_adicionais: 0, vencimento: '2026-09-20', pago: 0 });
    assert.equal((await getAsync(f.db, 'SELECT vencimento FROM parcelas WHERE id=101')).vencimento, '2026-10-20');
    assert.equal((await getAsync(f.db, 'SELECT tipo_pagamento FROM pagamentos')).tipo_pagamento, 'juros');
    assert.doesNotMatch(JSON.stringify(audit.entries), /Cliente/);
  } finally { await f.close(); }
});
test('juros rejeita valor parcial e revalida mudanca entre previa e confirmacao', async () => {
  const f = await fixture(); try {
    const gateway = createActionGateway({ actionRegistry: createActionRegistry({ interestCommand: f.command }), auditStore: createMemoryAuditStore() });
    await assert.rejects(() => gateway.createPreview({ sessionId: 's', intent: intent({ valor: 16 }) }), { code: 'interest_amount_mismatch' });
    const preview = await gateway.createPreview({ sessionId: 's', intent: intent() }); await runAsync(f.db, "UPDATE parcelas SET vencimento = '2026-08-21' WHERE id=100");
    await assert.rejects(() => gateway.confirm({ sessionId: 's', confirmationToken: preview.confirmation_token }), { code: 'state_changed' });
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) total FROM pagamentos')).total, 0);
  } finally { await f.close(); }
});
