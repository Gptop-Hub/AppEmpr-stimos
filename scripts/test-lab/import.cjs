'use strict';
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { fs, path, ROOT, LAB, SEED, STAMP, mark, guard, open, close, schema, run, all } = require('./runtime.cjs');
const { collections, jsonFields, transform, validateDataset } = require('./state.cjs');
const hash = data => crypto.createHash('sha256').update(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)).digest('hex');
const DEFAULT_DB = path.join(LAB, 'app', 'emprestimos-data', 'database.db');
const EXTERNAL_DATASET = path.resolve(ROOT, '../DADOS-TESTE-EMPRESTIMOS/dataset-v1.json');
function safePath(file) {
  const target = path.resolve(file);
  const rel = path.relative(LAB, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('Banco permitido somente dentro de .test-lab. O banco real não é um destino aceito.');
  // Reject junctions/symlinks, including the .test-lab directory itself.
  let cursor = target;
  while (cursor !== ROOT) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw Error(`Link/junction não permitido: ${cursor}`);
    const parent = path.dirname(cursor);
    if (parent === cursor) throw Error('Destino fora do checkout.');
    cursor = parent;
  }
  if (fs.existsSync(target) && fs.statSync(target).nlink > 1) throw Error(`Hardlink não permitido: ${target}`);
  return target;
}
function readDataset(file) {
  const bytes = fs.readFileSync(file);
  const data = JSON.parse(bytes);
  validateDataset(data);
  for (const [key, [, fields]] of Object.entries(collections)) for (const row of data[key]) {
    const allowed = new Set(['id', ...fields.split(' ')]);
    for (const name of Object.keys(row)) if (!allowed.has(name)) throw Error(`Campo não permitido: ${key}.${name}`);
  }
  return { data, sha256: hash(bytes) };
}
async function ownedRows(db, manifest) {
  const result = {};
  for (const [key, [table]] of Object.entries(collections)) {
    result[key] = [];
    for (const id of manifest.ids[key]) {
      const rows = await all(db, `SELECT * FROM ${table} WHERE id=?`, [id]);
      if (rows.length !== 1) throw Error(`Manifesto divergente: ${table} id=${id}. Nenhum registro removido.`);
      result[key].push(rows[0]);
    }
  }
  return result;
}
async function assertOwnership(db, manifest) {
  assert.equal(manifest.seed, SEED);
  const rows = await ownedRows(db, manifest);
  if (hash(rows) !== manifest.rowsHash) throw Error('Registros do laboratório foram alterados. Limpeza/importação recusada para preservar alterações; nenhum registro removido.');
  for (const c of rows.clientes) assert.equal(c.observacao, mark(c.referencia));
  for (const e of rows.emprestimos) assert.equal(e.observacao, mark(e.codigo_cliente));
  const clients = new Set(manifest.ids.clientes), loans = new Set(manifest.ids.emprestimos), parcels = new Set(manifest.ids.parcelas), payments = new Set(manifest.ids.pagamentos), histories = new Set(manifest.ids.historicos);
  const standard = { cliente_id: clients, emprestimo_id: loans, antigo_id: loans, novo_id: loans, renegociacao_de: loans, substituido_por: loans, parcela_id: parcels, parcela_destino_id: parcels, pagamento_id: payments, renegociacao_id: histories };
  const knownTables = Object.fromEntries(Object.entries(collections).map(([key,[table]]) => [table, new Set(manifest.ids[key])]));
  const tables = await all(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const columns = await all(db, `PRAGMA table_info(${quoted})`);
    const foreignKeys = await all(db, `PRAGMA foreign_key_list(${quoted})`);
    const references = { ...standard };
    for (const fk of foreignKeys) if (knownTables[fk.table]) references[fk.from] = knownTables[fk.table];
    const relevant = columns.map(c => c.name).filter(c => references[c]);
    if (!relevant.length) continue;
    const data = await all(db, `SELECT * FROM ${quoted}`);
    for (const row of data) {
      if (knownTables[name]?.has(row.id)) continue;
      if (relevant.some(column => references[column].has(row[column]))) throw Error(`Dependência externa em ${name}. Nenhum dado será removido.`);
    }
  }
  return rows;
}
async function rowsForClear(db, manifest) {
  assert.equal(manifest.seed, SEED);
  const clients = new Set(manifest.ids.clientes);
  const loans = new Set(manifest.ids.emprestimos);
  const clientRows = await all(db, 'SELECT * FROM clientes');
  const loanRows = await all(db, 'SELECT * FROM emprestimos');
  for (const id of clients) {
    const row = clientRows.find(r => r.id === id);
    if (!row || row.referencia !== manifest.clientIdentity[id] || !/^TEST-C\d{3}$/.test(row.referencia)) throw Error('Identidade do cliente de teste mudou. Limpeza recusada.');
  }
  for (const id of loans) {
    const row = loanRows.find(r => r.id === id);
    if (!row || row.codigo_cliente !== manifest.loanIdentity[id] || !/^TEST-C\d{3}-L\d{2}$/.test(row.codigo_cliente) || !clients.has(row.cliente_id)) throw Error('Identidade do empréstimo de teste mudou. Limpeza recusada.');
  }
  const tableRows = {};
  const schemaRows = await all(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of schemaRows) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    tableRows[name] = await all(db, `SELECT * FROM ${quoted}`);
  }
  const parcelIds = new Set((tableRows.parcelas || []).filter(r => loans.has(r.emprestimo_id)).map(r => r.id));
  const payments = new Set((tableRows.pagamentos || []).filter(r => loans.has(r.emprestimo_id)).map(r => r.id));
  const histories = new Set((tableRows.renegociacoes_historico || []).filter(r => loans.has(r.emprestimo_id)).map(r => r.id));
  const namedRefs = { cliente_id: clients, emprestimo_id: loans, antigo_id: loans, novo_id: loans, renegociacao_de: loans, substituido_por: loans, parcela_id: parcelIds, parcela_destino_id: parcelIds, pagamento_id: payments, renegociacao_id: histories };
  const tableRefs = { clientes: clients, emprestimos: loans, parcelas: parcelIds, pagamentos: payments, renegociacoes_historico: histories };
  const knownLoanTables = new Set(['parcelas', 'parcelas_originais', 'pagamentos', 'renegociacoes_historico', 'caixa_movimentos', 'recalculos_atraso', 'assistant_action_executions']);
  const selected = {};
  for (const { name } of schemaRows) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const columns = await all(db, `PRAGMA table_info(${quoted})`);
    const fks = await all(db, `PRAGMA foreign_key_list(${quoted})`);
    const refs = { ...namedRefs };
    for (const fk of fks) if (tableRefs[fk.table]) refs[fk.from] = tableRefs[fk.table];
    const relevant = columns.map(c => c.name).filter(c => refs[c]);
    const owned = [];
    for (const row of tableRows[name]) {
      const linked = relevant.some(c => refs[c].has(row[c]));
      let isOwned = name === 'clientes' ? clients.has(row.id) : name === 'emprestimos' ? loans.has(row.id) :
        knownLoanTables.has(name) ? loans.has(row.emprestimo_id) :
        name === 'clientes_telefones' ? clients.has(row.cliente_id) :
        name === 'notificacoes' ? loans.has(row.emprestimo_id) || parcelIds.has(row.parcela_id) :
        name === 'renegociacoes' ? loans.has(row.antigo_id) && loans.has(row.novo_id) : false;
      if (isOwned) {
        if (row.cliente_id != null && name !== 'clientes_telefones' && name !== 'clientes' && !clients.has(row.cliente_id)) throw Error(`Referência de cliente externo em ${name}. Limpeza recusada.`);
        if (name === 'notificacoes' && row.emprestimo_id != null && !loans.has(row.emprestimo_id)) throw Error('Notificação também ligada a empréstimo externo. Limpeza recusada.');
        owned.push(row.id);
      } else if (linked) throw Error(`Dependência externa em ${name}. Limpeza recusada.`);
    }
    selected[name] = owned;
  }
  return selected;
}
async function importDataset(file, datasetFile) {
  guard();
  file = safePath(file);
  const { data, sha256 } = readDataset(datasetFile);
  console.log(`DADOS DE TESTE — importar 20 clientes e 100 empréstimos a 10%.\nBanco isolado: ${file}\nDataset SHA-256: ${sha256}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  safePath(file);
  const manifestFile = `${file}.lab-manifest.json`;
  safePath(manifestFile);
  const exists = fs.existsSync(file);
  const db = await open(file);
  let wroteManifest = false;
  try {
    if (!exists) await schema(db);
    await run(db, 'BEGIN IMMEDIATE');
    if (fs.existsSync(manifestFile)) {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (manifest.datasetHash !== sha256) throw Error('Já existe outro dataset/versão neste banco.');
      await assertOwnership(db, manifest);
      await run(db, 'ROLLBACK');
      return { status: 'already_imported', manifest };
    }
    const collisions = await all(db, "SELECT id FROM clientes WHERE instr(COALESCE(observacao,''), ?) > 0 OR referencia LIKE 'TEST-C%' UNION ALL SELECT id FROM emprestimos WHERE instr(COALESCE(observacao,''), ?) > 0 OR codigo_cliente LIKE 'TEST-C%'", [SEED, SEED]);
    if (collisions.length) throw Error('Marcadores existentes sem manifesto. Importação recusada.');
    const maps = {}, ids = {};
    for (const [key, [table]] of Object.entries(collections)) {
      const row = (await all(db, `SELECT MAX(id) AS maximum FROM ${table}`))[0];
      const sequence = (await all(db, 'SELECT seq FROM sqlite_sequence WHERE name=?', [table]))[0];
      let next = Math.max(row.maximum || 0, sequence?.seq || 0) + 1;
      maps[key] = new Map();
      const keys = data[key].map(r => r.id);
      if (key === 'parcelas') for (const h of data.historicos) for (const p of h.snapshot_parcelas) keys.push(p.id);
      for (const id of [...new Set(keys)].sort()) maps[key].set(id, next++);
      ids[key] = data[key].map(r => maps[key].get(r.id));
    }
    for (const key of ['clientes', 'emprestimos', 'parcelas', 'parcelasOriginais', 'historicos', 'pagamentos', 'caixa']) {
      const [table] = collections[key];
      const cols = (await all(db, `PRAGMA table_info(${table})`)).map(c => c.name);
      for (const source of data[key]) {
        const row = transform(source, maps, key);
        for (const field of jsonFields) if (row[field] != null) row[field] = JSON.stringify(row[field]);
        for (const timestamp of ['created_at', 'updated_at', 'last_activity_at']) if (cols.includes(timestamp)) row[timestamp] = STAMP;
        for (const name of Object.keys(row)) if (!cols.includes(name)) throw Error(`Schema PC incompatível: ${table}.${name}`);
        const names = Object.keys(row);
        await run(db, `INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`, Object.values(row));
      }
    }
    // Historical snapshot parcel IDs can still be referenced by cash entries.
    // Reserve them so future PC inserts cannot silently reuse those numbers.
    await run(db, "UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'parcelas'", [Math.max(...maps.parcelas.values())]);
    const manifest = { manifestVersion: 1, seed: SEED, datasetHash: sha256, ids,
      clientIdentity: Object.fromEntries(data.clientes.map(c => [maps.clientes.get(c.id), c.id])),
      loanIdentity: Object.fromEntries(data.emprestimos.map(e => [maps.emprestimos.get(e.id), e.id])),
    };
    manifest.rowsHash = hash(await ownedRows(db, manifest));
    assert.equal((await all(db, 'PRAGMA foreign_key_check')).length, 0);
    // Persist ownership before COMMIT. A crash cannot leave committed rows without a manifest.
    // A crash before COMMIT leaves a conservative manifest mismatch, never a guessed deletion.
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    wroteManifest = true;
    await run(db, 'COMMIT');
    return { status: 'imported', manifest };
  } catch (error) {
    await run(db, 'ROLLBACK').catch(() => {});
    if (wroteManifest) fs.unlinkSync(manifestFile);
    throw error;
  } finally { await close(db); }
}
async function clearDataset(file) {
  guard(); file = safePath(file);
  const manifestFile = safePath(`${file}.lab-manifest.json`);
  console.log(`DADOS DE TESTE — limpeza exclusiva pelo manifesto, marcadores e conteúdo verificado.\nBanco isolado: ${file}`);
  if (!fs.existsSync(file) && !fs.existsSync(manifestFile)) return { status: 'nothing_to_clear' };
  if (!fs.existsSync(file) || !fs.existsSync(manifestFile)) throw Error('Banco/manifesto ausente. Nenhum dado será removido.');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const db = await open(file);
  try {
    await run(db, 'BEGIN IMMEDIATE');
    const selected = await rowsForClear(db, manifest);
    for (const table of ['assistant_action_executions', 'notificacoes', 'recalculos_atraso', 'renegociacoes', 'clientes_telefones', 'caixa_movimentos', 'pagamentos', 'renegociacoes_historico', 'parcelas_originais', 'parcelas', 'emprestimos', 'clientes']) {
      for (const id of selected[table] || []) await run(db, `DELETE FROM ${table} WHERE id=?`, [id]);
    }
    assert.equal((await all(db, 'PRAGMA foreign_key_check')).length, 0);
    await run(db, 'COMMIT');
    fs.unlinkSync(manifestFile);
    return { status: 'cleared', clientes: 20, emprestimos: 100 };
  } catch (e) { await run(db, 'ROLLBACK').catch(() => {}); throw e; }
  finally { await close(db); }
}
async function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (!['--db', '--dataset'].includes(key) || !args.length) throw Error('Uso: import.cjs import|clear [--db caminho em .test-lab] [--dataset arquivo]');
    options[key] = args.shift();
  }
  const file = options['--db'] || DEFAULT_DB;
  const dataset = options['--dataset'] || (fs.existsSync(EXTERNAL_DATASET) ? EXTERNAL_DATASET : path.join(LAB, 'dataset-v1.json'));
  if (!['import', 'clear'].includes(mode)) throw Error('Comando explícito import ou clear obrigatório.');
  console.log(JSON.stringify(mode === 'import' ? await importDataset(file, dataset) : await clearDataset(file), (key,value) => key === 'manifest' ? '[manifesto auxiliar gravado/verificado]' : value, 2));
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { importDataset, clearDataset, readDataset, assertOwnership, hash, DEFAULT_DB, EXTERNAL_DATASET, safePath };
