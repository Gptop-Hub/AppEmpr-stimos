'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { fs, path, ROOT, LAB, SEED, DATE, guard, open, close, schema, bindReference, run, all } = require('./runtime.cjs');
const { importDataset, clearDataset, hash, safePath } = require('./import.cjs');
const { collections, exportState, validateDataset, summary } = require('./state.cjs');
async function main() {
  guard();
  console.log('VALIDAÇÃO DE DADOS DE TESTE: bancos descartáveis exclusivos em .test-lab.');
  fs.mkdirSync(LAB, { recursive: true });
  const dir = fs.mkdtempSync(path.join(LAB, 'validation-'));
  const file = path.join(dir, 'temporary.db');
  const datasetFile = path.join(LAB, 'dataset-v1.json');
  const firstBytes = fs.readFileSync(datasetFile);
  const child = spawnSync(process.execPath, [path.join(__dirname, 'generate.cjs')], { cwd: ROOT, env: { ...process.env, TZ: 'Pacific/Honolulu' }, encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'reproducibility.log'), child.stdout + child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(hash(fs.readFileSync(datasetFile)), hash(firstBytes), 'Regeneração deve ser byte a byte idêntica, inclusive sob outro fuso.');
  const dataset = JSON.parse(firstBytes);
  const report = validateDataset(dataset);
  let db = await open(file);
  await schema(db);
  for (const [table] of Object.values(collections)) assert.equal((await all(db, `SELECT COUNT(*) n FROM ${table}`))[0].n, 0, 'Banco novo não recebe dataset.');
  // Unrelated synthetic fixture: prove ID remapping and preservation without reading any real DB.
  await run(db, "INSERT INTO clientes(id,nome,observacao) VALUES(7000,'CONTROLE FICTICIO FORA DO DATASET','preservar exatamente')");
  await run(db, "INSERT INTO emprestimos(id,cliente_id,codigo_cliente,valor,taxa_juros) VALUES(8000,7000,'CONTROLE',123,7)");
  await run(db, "INSERT INTO parcelas(id,emprestimo_id,numero,valor_capital,valor_juros,valor_total) VALUES(9000,8000,1,123,8.61,131.61)");
  await run(db, "INSERT INTO pagamentos(id,emprestimo_id,valor,data) VALUES(10000,8000,1,'2025-01-01')");
  await run(db, "INSERT INTO caixa_movimentos(id,tipo,categoria,data,cliente_id,emprestimo_id,parcela_id,valor_total) VALUES(11000,'ENTRADA','PAGAMENTO','2025-01-01',7000,8000,9000,1)");
  const dump = async db => {
    const result = {};
    for (const [key, [table]] of Object.entries(collections)) result[key] = await all(db, `SELECT * FROM ${table} ORDER BY id`);
    return result;
  };
  const baseline = await dump(db);
  await close(db);
  const imported = await importDataset(file, datasetFile);
  assert.equal(imported.status, 'imported');
  assert(imported.manifest.ids.clientes.every(id => id > 7000));
  assert.equal((await importDataset(file, datasetFile)).status, 'already_imported');
  db = await open(file);
  bindReference(db);
  const reservedParcelIds = imported.manifest.ids.parcelas;
  const nextParcel = (await all(db, "SELECT seq FROM sqlite_sequence WHERE name='parcelas'"))[0].seq;
  const referencedParcelIds = (await all(db, 'SELECT parcela_id FROM caixa_movimentos WHERE parcela_id IS NOT NULL')).map(r => r.parcela_id);
  assert(nextParcel >= Math.max(...reservedParcelIds, ...referencedParcelIds), 'IDs de parcelas históricas devem permanecer reservados.');
  const capitalRule = require('../../backend/services/servicoemprestimo/core').calcularCapitalRestanteComRegra;
  const state = await exportState(db, dataset.cenarios, imported.manifest.ids);
  assert.deepEqual(state, dataset, 'Round-trip semântico deve preservar todo estado, snapshots e referências.');
  assert.deepEqual(await all(db, 'PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
  assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), []);
  const rows = summary(state, capitalRule);
  const lookup = require('../../backend/services/servicoemprestimo/consultas').buscarEmprestimoPorId;
  for (const loan of dataset.emprestimos) {
    const receiptCapital = dataset.caixa.filter(m => m.emprestimo_id === loan.id && m.categoria === 'PAGAMENTO').reduce((s,m) => s + Math.round(m.valor_capital * 100), 0);
    const issued = dataset.caixa.filter(m => m.emprestimo_id === loan.id && m.categoria === 'EMPRESTIMO').reduce((s,m) => s + Math.round(m.valor_emprestimo * 100), 0);
    const item = rows.find(r => r.emprestimo === loan.id);
    assert.equal(Math.round(item.capitalRestante * 100), issued - receiptCapital, `Conciliação de capital e caixa: ${loan.id}`);
    const numeric = (await all(db, 'SELECT id FROM emprestimos WHERE codigo_cliente=?', [loan.id]))[0].id;
    const pc = await lookup(numeric);
    assert.equal(Number(pc.capital_restante), item.capitalRestante, `Consulta real do PC: ${loan.id}`);
  }
  const firstClient = imported.manifest.ids.clientes[0];
  const originalReference = (await all(db, 'SELECT referencia FROM clientes WHERE id=?', [firstClient]))[0].referencia;
  await run(db, "UPDATE clientes SET nome='ALTERADO NO TESTE' WHERE id=?", [firstClient]);
  await run(db, "UPDATE clientes SET referencia='REFERENCIA ALTERADA' WHERE id=?", [firstClient]);
  await assert.rejects(clearDataset(file), /Identidade do cliente/);
  await run(db, 'UPDATE clientes SET referencia=? WHERE id=?', [originalReference, firstClient]);
  await run(db, "INSERT INTO notificacoes(tipo,titulo,mensagem,data_referencia,emprestimo_id,status) VALUES('teste','dependência externa','não remover','2026-09-14',?,'pendente')", [imported.manifest.ids.emprestimos[0]]);
  await run(db, "INSERT INTO caixa_movimentos(tipo,categoria,data,cliente_id,emprestimo_id,valor_total) VALUES('ENTRADA','CONTROLE_EXTERNO','2026-09-14',?,8000,1)", [firstClient]);
  await assert.rejects(clearDataset(file), /Dependência externa/);
  await run(db, "DELETE FROM caixa_movimentos WHERE categoria='CONTROLE_EXTERNO'");
  await run(db, 'INSERT INTO emprestimos(cliente_id,codigo_cliente,valor,taxa_juros) VALUES(?,?,100,7)', [firstClient, 'EMPRESTIMO NOVO FORA DO DATASET']);
  const extraLoan = (await all(db, "SELECT id FROM emprestimos WHERE codigo_cliente='EMPRESTIMO NOVO FORA DO DATASET'"))[0].id;
  await assert.rejects(clearDataset(file), /Dependência externa/);
  await run(db, 'DELETE FROM emprestimos WHERE id=?', [extraLoan]);
  const ownLoan = imported.manifest.ids.emprestimos[0];
  await run(db, "INSERT INTO pagamentos(emprestimo_id,valor,data,tipo_pagamento,observacao) VALUES(?,5,'2026-09-14','normal','interação de teste')", [ownLoan]);
  await run(db, "INSERT INTO caixa_movimentos(tipo,categoria,data,cliente_id,emprestimo_id,valor_total,valor_juros,valor_capital) VALUES('ENTRADA','PAGAMENTO','2026-09-14',?,?,5,0,5)", [firstClient, ownLoan]);
  await close(db);
  assert.equal((await clearDataset(file)).status, 'cleared');
  db = await open(file);
  assert.deepEqual(await dump(db), baseline, 'Limpeza deve preservar integralmente os registros de controle.');
  // Force failure late in the import to exercise rollback, not just input validation.
  await run(db, "CREATE TRIGGER lab_fail BEFORE INSERT ON caixa_movimentos WHEN NEW.cliente_nome LIKE 'TEST-C020%' BEGIN SELECT RAISE(ABORT, 'falha controlada'); END");
  await close(db);
  await assert.rejects(importDataset(file, datasetFile), /falha controlada/);
  assert(!fs.existsSync(`${file}.lab-manifest.json`));
  db = await open(file);
  assert.deepEqual(await dump(db), baseline, 'Importação interrompida deve desfazer todas as inserções.');
  await run(db, 'DROP TRIGGER lab_fail');
  await close(db);
  const second = await importDataset(file, datasetFile);
  assert.notDeepEqual(second.manifest.ids, imported.manifest.ids, 'IDs numéricos podem variar após limpeza.');
  db = await open(file);
  assert.deepEqual(await exportState(db, dataset.cenarios, second.manifest.ids), dataset);
  await close(db);
  await clearDataset(file);
  // The real PC backend must see the same isolated database when launched explicitly.
  const appRoot = path.join(dir, 'app');
  const appFile = path.join(appRoot, 'emprestimos-data', 'database.db');
  await importDataset(appFile, datasetFile);
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const selected = listener.address().port;
      listener.close(() => resolve(selected));
    });
  });
  const backendLog = fs.openSync(path.join(dir, 'backend-smoke.log'), 'w');
  const childBackend = spawn(process.execPath, [path.join(ROOT, 'backend/index.js')], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', backendLog, backendLog],
    env: { ...process.env, APP_DATA_DIR: appRoot, PORT: String(port), NOTIFICACOES_SCHEDULER: 'off' },
  });
  fs.closeSync(backendLog);
  try {
    let health = null;
    for (let i = 0; i < 100; i++) {
      if (childBackend.exitCode != null) throw Error(`Backend PC encerrou: ${childBackend.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { health = await response.json(); break; }
      } catch { /* startup ainda em curso */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(health?.ok, 'Backend PC não respondeu à rota /health.');
    assert.equal(path.resolve(health.dbPath), path.resolve(appFile));
    const clientsResponse = await fetch(`http://127.0.0.1:${port}/clientes`, { signal: AbortSignal.timeout(10000) });
    const loansResponse = await fetch(`http://127.0.0.1:${port}/emprestimos`, { signal: AbortSignal.timeout(30000) });
    assert.equal(clientsResponse.status, 200);
    assert.equal(loansResponse.status, 200);
    assert.equal((await clientsResponse.json()).length, 20);
    assert.equal((await loansResponse.json()).length, 100);
  } finally {
    if (childBackend.exitCode == null) {
      childBackend.kill();
      await new Promise(resolve => childBackend.once('exit', resolve));
    }
  }
  await clearDataset(appFile);
  assert.throws(() => safePath(path.join(ROOT, 'backend/models/data/database.db')), /somente dentro/);
  assert.throws(() => safePath(path.join(LAB, '..', 'outside.db')), /somente dentro/);
  const production = spawnSync(process.execPath, [path.join(__dirname, 'import.cjs'), 'import', '--db', file, '--dataset', datasetFile], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8' });
  assert.notEqual(production.status, 0);
  assert.match(production.stderr, /exclusivo/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const [name, command] of Object.entries(pkg.scripts)) if (!name.startsWith('seed:test')) assert(!/test-lab|seed:test/.test(command), `Acionamento automático: ${name}`);
  for (const entry of ['main.js', 'preload.js', 'backend/index.js', 'backend/models/database.js', 'backend/models/migrations/index.js']) assert(!/test-lab|seed:test|LAB-EMPRESTIMOS/.test(fs.readFileSync(path.join(ROOT, entry), 'utf8')), `Entrada de produção importa laboratório: ${entry}`);
  for (const exclusion of ['!scripts/test-lab{,/**/*}', '!.test-lab{,/**/*}', '!backend/models/data{,/**/*}', '!**/emprestimos-data{,/**/*}', '!**/dataset-v1.json', '!**/*.lab-manifest.json']) assert(pkg.build.files.includes(exclusion));
  report.datasetSHA256 = hash(firstBytes);
  report.dataReferencia = DATE;
  report.validacoes = ['regeneração byte a byte com seed fixa e fuso diferente', 'banco novo vazio', '20 clientes / 100 empréstimos / taxa 10% em todos', 'importação atômica e idempotente', 'round-trip completo com IDs diferentes e snapshots remapeados', 'integridade SQLite e referências financeiras', 'caixa conciliado com cada pagamento e capital restante dos 100 contratos', 'capital restante conferido pela consulta real do PC', 'backend PC isolado respondeu 20 clientes / 100 empréstimos pela API e permitiu limpeza após inicialização', 'limpeza preserva registros alheios integralmente e remove derivados de interação', 'limpeza recusa identidade alterada ou dependências externas', 'falha durante importação faz rollback integral', 'banco real e caminhos fora do laboratório recusados', 'NODE_ENV=production recusado', 'sem integração com startup/migrations/build/update e exclusões explícitas de empacotamento'];
  report.resultado = 'APROVADO';
  fs.writeFileSync(path.join(LAB, 'validation-v1.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(LAB, 'summary-v1.json'), JSON.stringify({ datasetVersion: 1, seed: SEED, dataReferencia: DATE, emprestimos: rows }, null, 2) + '\n');
  const columns = Object.keys(rows[0]);
  const csv = [columns.join(';'), ...rows.map(row => columns.map(k => `"${String(row[k]).replaceAll('"', '""')}"`).join(';'))].join('\r\n');
  fs.writeFileSync(path.join(LAB, 'summary-v1.csv'), '\uFEFF' + csv + '\r\n');
  console.log(JSON.stringify(report, null, 2));
}
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
