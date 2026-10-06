const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { runAsync, getAsync, allAsync } = require('../utils/sqliteAsync');
const {
  executarPagamentoNormal,
  executarPagamentoManual,
  executarPagamentoJuros,
  executarJurosParciais,
  executarQuitacao,
} = require('../services/paymentActionService');

const actionSql = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', 'create_action_tables.sql'), 'utf8');

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-actions-'));
  const db = new sqlite3.Database(path.join(directory, 'fixture.db'));
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT, cliente_uid TEXT, last_activity_at TEXT);
    CREATE TABLE emprestimos (id INTEGER PRIMARY KEY, cliente_id INTEGER, modalidade TEXT, versao_atual INTEGER, capital_restante REAL, emprestimo_uid TEXT, last_activity_at TEXT);
    CREATE TABLE parcelas (id INTEGER PRIMARY KEY, emprestimo_id INTEGER, numero INTEGER, valor_total REAL, valor_capital REAL, valor_juros REAL, juros_pendentes REAL DEFAULT 0, juros_adicionais REAL DEFAULT 0, valor_pago REAL DEFAULT 0, valor_excedente REAL DEFAULT 0, data_pagamento TEXT, vencimento TEXT, pago INTEGER DEFAULT 0, versao INTEGER, observacao TEXT, explicacao TEXT, tipo_pagamento TEXT, parcela_uid TEXT);
    CREATE TABLE pagamentos (id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER, valor REAL, data TEXT, tipo_pagamento TEXT, observacao TEXT, parcela_origem INTEGER);
    CREATE TABLE caixa_movimentos (id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT, categoria TEXT, data TEXT, cliente_id INTEGER, cliente_nome TEXT, emprestimo_id INTEGER, parcela_id INTEGER, parcela_numero INTEGER, data_vencimento TEXT, data_pagamento TEXT, valor_total REAL, valor_juros REAL, valor_capital REAL, valor_emprestimo REAL, valor_despesa REAL, descricao TEXT, meta_json TEXT);
    INSERT INTO clientes VALUES (1, 'Cliente', 'cliente-uid-1', NULL);
    INSERT INTO emprestimos VALUES (10, 1, 'parcelado', 1, 190, 'emprestimo-uid-10', NULL);
    INSERT INTO parcelas VALUES (100, 10, 1, 110, 100, 10, 0, 0, 0, 0, NULL, '2026-10-10', 0, 1, '', NULL, NULL, 'parcela-uid-100');
    INSERT INTO parcelas VALUES (101, 10, 2, 80, 70, 10, 0, 0, 0, 0, NULL, '2026-11-10', 0, 1, '', NULL, NULL, 'parcela-uid-101');
  `, (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => db.exec(actionSql, (error) => error ? reject(error) : resolve()));
  return { db, async close() { await new Promise((resolve) => db.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); } };
}

async function actionDetail(db) {
  const action = await getAsync(db, 'SELECT * FROM acoes ORDER BY id DESC LIMIT 1');
  return {
    action,
    entities: await allAsync(db, 'SELECT entidade, entidade_id, entidade_uid, papel FROM acao_entidades WHERE acao_id = ? ORDER BY id', [action.id]),
    snapshots: await allAsync(db, 'SELECT momento, dados_json FROM acao_snapshots WHERE acao_id = ? ORDER BY id', [action.id]),
  };
}

test('pagamento normal gera exatamente uma ação com UIDs, snapshots e caixa', async () => {
  const f = await fixture();
  try {
    await executarPagamentoNormal({ emprestimoId: 10, valor: 110, data: '2026-09-27', observacao: 'ok' }, { dbHandle: f.db });
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 1);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM pagamentos')).total, 1);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM caixa_movimentos')).total, 1);
    const detail = await actionDetail(f.db);
    assert.equal(detail.action.tipo, 'PAGAMENTO_NORMAL_REGISTRADO');
    assert.deepEqual(detail.entities.filter((item) => ['clientes', 'emprestimos', 'parcelas'].includes(item.entidade)).map((item) => item.entidade_uid).filter(Boolean).sort(), ['cliente-uid-1', 'emprestimo-uid-10', 'parcela-uid-100', 'parcela-uid-101'].sort());
    assert.deepEqual(detail.snapshots.map((item) => item.momento), ['antes', 'depois']);
    const depois = JSON.parse(detail.snapshots[1].dados_json);
    assert.equal(depois.estado.pagamentos.length, 1);
    assert.equal(depois.estado.caixa_movimentos.length, 1);
  } finally { await f.close(); }
});

test('pagamento manual de uma ou várias parcelas gera uma única ação por confirmação', async () => {
  const f = await fixture();
  try {
    await executarPagamentoManual({
      emprestimoId: 10, valor: 60, data: '2026-09-27',
      abatimentos: [{ parcelaId: 100, abatParcela: 60 }],
    }, { dbHandle: f.db });
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 1);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM pagamentos')).total, 1);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM caixa_movimentos')).total, 1);
    const f2 = await fixture();
    try {
      await executarPagamentoManual({
        emprestimoId: 10, valor: 150, data: '2026-09-27',
        abatimentos: [{ parcelaId: 100, abatParcela: 110 }, { parcelaId: 101, abatParcela: 40 }],
      }, { dbHandle: f2.db });
      assert.equal((await getAsync(f2.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 1);
      assert.equal((await getAsync(f2.db, 'SELECT COUNT(*) AS total FROM pagamentos')).total, 1);
      assert.equal((await getAsync(f2.db, 'SELECT COUNT(*) AS total FROM caixa_movimentos')).total, 1);
      const detail = await actionDetail(f2.db);
      assert.equal(detail.action.tipo, 'PAGAMENTO_MANUAL_REGISTRADO');
      assert.equal(detail.snapshots.length, 2);
    } finally { await f2.close(); }
  } finally { await f.close(); }
});

test('falha ao gravar ação desfaz parcelas, pagamento, caixa e reserva de sequência', async () => {
  const f = await fixture();
  try {
    await runAsync(f.db, "CREATE TRIGGER falha_pagamento_acao BEFORE INSERT ON acao_snapshots WHEN NEW.momento = 'depois' BEGIN SELECT RAISE(ABORT, 'falha acao'); END");
    await assert.rejects(
      () => executarPagamentoNormal({ emprestimoId: 10, valor: 110, data: '2026-09-27' }, { dbHandle: f.db }),
      /falha acao/
    );
    assert.equal((await getAsync(f.db, 'SELECT valor_pago FROM parcelas WHERE id = 100')).valor_pago, 0);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM pagamentos')).total, 0);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM caixa_movimentos')).total, 0);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 0);
    await runAsync(f.db, 'DROP TRIGGER falha_pagamento_acao');
    const result = await executarPagamentoNormal({ emprestimoId: 10, valor: 110, data: '2026-09-27' }, { dbHandle: f.db });
    assert.equal(result.action.origin_sequence, 1);
  } finally { await f.close(); }
});

test('juros integral gera somente JUROS_REGISTRADOS com UIDs e snapshots completos', async () => {
  const f = await fixture();
  try {
    await executarPagamentoJuros({ emprestimoId: 10, valor: 10, data: '2026-09-27' }, { dbHandle: f.db });
    const detail = await actionDetail(f.db);
    assert.equal(detail.action.tipo, 'JUROS_REGISTRADOS');
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acoes WHERE tipo LIKE ?', ['PAGAMENTO_%'])).total, 0);
    assert.equal(detail.snapshots.length, 2);
    assert.equal(JSON.parse(detail.snapshots[1].dados_json).estado.pagamentos.length, 1);
    assert.equal(JSON.parse(detail.snapshots[1].dados_json).estado.caixa_movimentos.length, 1);
    assert.ok(detail.entities.some((entity) => entity.entidade === 'clientes' && entity.entidade_uid === 'cliente-uid-1'));
    assert.ok(detail.entities.some((entity) => entity.entidade === 'emprestimos' && entity.entidade_uid === 'emprestimo-uid-10'));
    assert.ok(detail.entities.some((entity) => entity.entidade === 'parcelas' && entity.entidade_uid === 'parcela-uid-100'));
  } finally { await f.close(); }
});

test('juros parciais preserva cascata e gera somente uma JUROS_PARCIAIS_REGISTRADOS', async () => {
  const f = await fixture();
  try {
    await executarJurosParciais({
      emprestimoId: 10, valor: 5, data: '2026-09-27', proximoVencimento: '2026-11-25',
    }, { dbHandle: f.db });
    assert.deepEqual((await allAsync(f.db, 'SELECT vencimento FROM parcelas ORDER BY numero')).map((row) => row.vencimento), ['2026-11-25', '2026-12-25']);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 1);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acoes WHERE tipo = ?', ['JUROS_PARCIAIS_REGISTRADOS'])).total, 1);
    assert.equal((await getAsync(f.db, "SELECT COUNT(*) AS total FROM acoes WHERE tipo IN ('PAGAMENTO_NORMAL_REGISTRADO', 'PAGAMENTO_MANUAL_REGISTRADO')")).total, 0);
    const detail = await actionDetail(f.db);
    assert.equal(detail.snapshots.length, 2);
    assert.equal(JSON.parse(detail.snapshots[1].dados_json).estado.caixa_movimentos.length, 1);
  } finally { await f.close(); }
});

test('quitação de várias parcelas gera somente EMPRESTIMO_QUITADO', async () => {
  const f = await fixture();
  try {
    await executarQuitacao({ emprestimoId: 10, valor: 180, data: '2026-09-27' }, { dbHandle: f.db });
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 1);
    assert.equal((await getAsync(f.db, 'SELECT tipo FROM acoes')).tipo, 'EMPRESTIMO_QUITADO');
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM parcelas WHERE pago = 1')).total, 2);
    const detail = await actionDetail(f.db);
    const depois = JSON.parse(detail.snapshots[1].dados_json);
    assert.equal(depois.estado.pagamentos.length, 1);
    assert.equal(depois.estado.caixa_movimentos.length, 1);
  } finally { await f.close(); }
});

test('falha na ação de juros parciais desfaz cascata, caixa e sequência', async () => {
  const f = await fixture();
  try {
    await runAsync(f.db, "CREATE TRIGGER falha_juros_acao BEFORE INSERT ON acao_snapshots WHEN NEW.momento = 'depois' BEGIN SELECT RAISE(ABORT, 'falha juros acao'); END");
    await assert.rejects(
      () => executarJurosParciais({ emprestimoId: 10, valor: 5, data: '2026-09-27', proximoVencimento: '2026-11-25' }, { dbHandle: f.db }),
      /falha juros acao/
    );
    assert.deepEqual((await allAsync(f.db, 'SELECT vencimento, juros_pendentes FROM parcelas ORDER BY numero')).map((row) => ({ ...row })), [
      { vencimento: '2026-10-10', juros_pendentes: 0 },
      { vencimento: '2026-11-10', juros_pendentes: 0 },
    ]);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM pagamentos')).total, 0);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM caixa_movimentos')).total, 0);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 0);
    await runAsync(f.db, 'DROP TRIGGER falha_juros_acao');
    const retry = await executarJurosParciais({ emprestimoId: 10, valor: 5, data: '2026-09-27', proximoVencimento: '2026-11-25' }, { dbHandle: f.db });
    assert.equal(retry.action.origin_sequence, 1);
  } finally { await f.close(); }
});
