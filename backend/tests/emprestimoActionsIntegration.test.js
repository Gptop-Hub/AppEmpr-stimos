const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { runAsync, getAsync } = require('../utils/sqliteAsync');
const actions = require('../services/actionService');
const { capturarEstadoEmprestimo, registrarAcaoEmprestimo } = require('../services/emprestimoActionService');

const migrationSql = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', 'create_action_tables.sql'), 'utf8');

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'emprestimo-actions-'));
  const db = new sqlite3.Database(path.join(directory, 'fixture.db'));
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT);
    CREATE TABLE emprestimos (id INTEGER PRIMARY KEY, cliente_id INTEGER, valor REAL, taxa_juros REAL, versao_atual INTEGER, observacao TEXT);
    CREATE TABLE parcelas (id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER, numero INTEGER, valor_total REAL);
    CREATE TABLE parcelas_originais (id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER, numero INTEGER, valor_total REAL);
    CREATE TABLE pagamentos (id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER, valor REAL);
    CREATE TABLE caixa_movimentos (id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER, valor_total REAL);
    CREATE TABLE renegociacoes_historico (id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER, versao INTEGER, detalhes TEXT);
    INSERT INTO clientes VALUES (1, 'Cliente');
    INSERT INTO emprestimos VALUES (10, 1, 100, 10, 1, 'antes');
    INSERT INTO parcelas (emprestimo_id, numero, valor_total) VALUES (10, 1, 110);
  `, (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => db.exec(migrationSql, (error) => error ? reject(error) : resolve()));
  return { db, async close() { await new Promise((resolve) => db.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); } };
}

async function registerMutation(db, { tipo, loanId = 10, mutate, parametros = {} }) {
  await runAsync(db, 'BEGIN IMMEDIATE');
  try {
    const antes = await capturarEstadoEmprestimo(loanId, { dbHandle: db });
    await mutate();
    const depois = await capturarEstadoEmprestimo(loanId, { dbHandle: db });
    const action = await registrarAcaoEmprestimo({
      tipo, origem: 'interface', emprestimoId: loanId, clienteId: 1, antes, depois,
      parametros, resumo: tipo,
    }, { dbHandle: db });
    await runAsync(db, 'COMMIT');
    return action;
  } catch (error) {
    await runAsync(db, 'ROLLBACK').catch(() => {});
    throw error;
  }
}

test('Fase 2B mantém uma ação V1 por operação e snapshots completos antes/depois', async () => {
  const f = await fixture();
  try {
    await registerMutation(f.db, {
      tipo: 'EMPRESTIMO_CRIADO', loanId: 11, parametros: { modalidade: 'parcelado', valor: 200 },
      mutate: async () => {
        await runAsync(f.db, "INSERT INTO emprestimos VALUES (11, 1, 200, 8, 1, 'novo')");
        await runAsync(f.db, 'INSERT INTO parcelas (emprestimo_id,numero,valor_total) VALUES (11,1,216)');
        await runAsync(f.db, 'INSERT INTO caixa_movimentos (emprestimo_id,valor_total) VALUES (11,200)');
      },
    });
    await registerMutation(f.db, {
      tipo: 'EMPRESTIMO_EDITADO', parametros: { campos_confirmados: ['observacao'] },
      mutate: () => runAsync(f.db, "UPDATE emprestimos SET observacao = 'depois' WHERE id = 10"),
    });
    await registerMutation(f.db, {
      tipo: 'CAPITAL_ADICIONADO', parametros: { valor_adicionado: 30, qtd_parcelas: 2 },
      mutate: async () => {
        await runAsync(f.db, 'UPDATE emprestimos SET valor = 130, versao_atual = 2 WHERE id = 10');
        await runAsync(f.db, 'INSERT INTO parcelas (emprestimo_id,numero,valor_total) VALUES (10,2,71),(10,3,71)');
        await runAsync(f.db, 'INSERT INTO caixa_movimentos (emprestimo_id,valor_total) VALUES (10,30)');
        await runAsync(f.db, "INSERT INTO renegociacoes_historico (emprestimo_id,versao,detalhes) VALUES (10,1,'capital')");
      },
    });
    await registerMutation(f.db, {
      tipo: 'EMPRESTIMO_RENEGOCIADO', parametros: { valor: 150, parcelas: 3, taxa_juros: 5 },
      mutate: async () => {
        await runAsync(f.db, 'UPDATE emprestimos SET valor = 150, taxa_juros = 5, versao_atual = 3 WHERE id = 10');
        await runAsync(f.db, "INSERT INTO renegociacoes_historico (emprestimo_id,versao,detalhes) VALUES (10,2,'renegociacao')");
      },
    });

    const listed = await actions.listarAcoes({ status: 'aplicada', limit: 10 }, { dbHandle: f.db });
    assert.deepEqual(new Set(listed.map((action) => action.tipo)), new Set([
      'EMPRESTIMO_CRIADO', 'EMPRESTIMO_EDITADO', 'CAPITAL_ADICIONADO', 'EMPRESTIMO_RENEGOCIADO',
    ]));
    assert.equal(listed.length, 4);
    for (const action of listed) {
      assert.ok(action.acao_uid);
      assert.ok(action.origin_device_id);
      assert.ok(action.origin_sequence > 0);
      assert.equal(action.metadata_version, 1);
      const detail = await actions.buscarAcaoPorId(action.id, { dbHandle: f.db });
      assert.equal(detail.snapshots.length, 2);
      assert.ok(detail.snapshots.every((snapshot) => snapshot.dados.estado));
    }
  } finally { await f.close(); }
});

test('falha no snapshot desfaz negócio, ação e reserva da sequência', async () => {
  const f = await fixture();
  try {
    await runAsync(f.db, "CREATE TRIGGER falha_acao BEFORE INSERT ON acao_snapshots WHEN NEW.momento = 'depois' BEGIN SELECT RAISE(ABORT, 'falha auditoria'); END;");
    await assert.rejects(() => registerMutation(f.db, {
      tipo: 'EMPRESTIMO_EDITADO',
      mutate: () => runAsync(f.db, 'UPDATE emprestimos SET valor = 999 WHERE id = 10'),
    }), /falha auditoria/);
    assert.equal((await getAsync(f.db, 'SELECT valor FROM emprestimos WHERE id=10')).valor, 100);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 0);
    await runAsync(f.db, 'DROP TRIGGER falha_acao');
    const action = await registerMutation(f.db, {
      tipo: 'EMPRESTIMO_EDITADO',
      mutate: () => runAsync(f.db, 'UPDATE emprestimos SET valor = 101 WHERE id = 10'),
    });
    assert.equal(action.origin_sequence, 1);
  } finally { await f.close(); }
});
