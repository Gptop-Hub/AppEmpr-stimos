'use strict';

// PC -> Android converter. The package layout and snapshot contract mirror the
// Android implementation in C:\Projetos\CELULAR\frontend\src\data\local.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const sqlite3 = require('sqlite3').verbose();

const { extractBackupBundle } = require('./backupBundleService');

const MOBILE_DATABASE_NAME = 'sistema_emprestimos_local';
const MOBILE_SCHEMA_VERSION = 5;
const SNAPSHOT_PATH = 'database.snapshot.json';
const SOURCE_TABLES = [
  'clientes', 'clientes_telefones', 'emprestimos', 'parcelas', 'pagamentos',
  'parcelas_originais', 'caixa_movimentos', 'renegociacoes_historico',
];
const MOBILE_TABLES = [
  'local_users', 'clientes', 'clientes_telefones', 'emprestimos', 'parcelas',
  'pagamentos', 'parcelas_originais', 'renegociacoes_historico',
  'caixa_movimentos', 'local_auditoria', 'local_settings',
];

function mobileBackupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// Matches Android's financial-core f2 helper.
function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function asText(value, fallback = '') {
  return value == null ? fallback : String(value);
}

function asDate(value, fallback) {
  const text = asText(value).trim();
  return text || fallback;
}

function optionalUid(row, column) {
  const uid = asText(row && row[column]).trim();
  return uid ? { [column]: uid } : {};
}

function openDatabase(file, flags) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, flags, (error) => (error ? reject(error) : resolve(db)));
  });
}

function closeDatabase(db) {
  return new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())));
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows || []))));
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (error) => (error ? reject(error) : resolve())));
}

function exec(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (error) => (error ? reject(error) : resolve())));
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function readSourceTables(databasePath) {
  const db = await openDatabase(databasePath, sqlite3.OPEN_READONLY);
  try {
    const integrity = await all(db, 'PRAGMA integrity_check');
    if (!integrity.length || integrity.some((row) => String(Object.values(row)[0]).toLowerCase() !== 'ok')) {
      throw mobileBackupError('INVALID_SQLITE', 'O banco de origem não passou na verificação de integridade.');
    }
    const schema = await all(db, "SELECT name FROM sqlite_master WHERE type = 'table'");
    const available = new Set(schema.map((row) => row.name));
    for (const required of ['clientes', 'emprestimos', 'parcelas', 'pagamentos']) {
      if (!available.has(required)) {
        throw mobileBackupError('INCOMPATIBLE_DESKTOP_DATABASE', `O banco de origem não possui a tabela obrigatória: ${required}.`);
      }
    }
    const tables = {};
    for (const table of SOURCE_TABLES) {
      tables[table] = available.has(table) ? await all(db, `SELECT * FROM ${quoteIdentifier(table)}`) : [];
    }
    return tables;
  } finally {
    await closeDatabase(db);
  }
}

// This is the same field mapping used by scripts/convert-desktop-backup-to-mobile.cjs
// in the Android repository. Do not silently repair incompatible personal data.
function convertTables(source, now, warnings = []) {
  const clientIds = new Set();
  const cpfs = new Set();
  const clientes = source.clientes.map((row) => {
    const cpf = asText(row.cpf).trim();
    const telefone = asText(row.telefone).trim();
    if (!Number.isSafeInteger(Number(row.id)) || !cpf || !telefone || cpfs.has(cpf)) {
      throw mobileBackupError(
        'INCOMPATIBLE_CLIENT',
        `Cliente incompatível para importação mobile (id ${row.id ?? '?'}): CPF e telefone devem estar preenchidos, e CPF deve ser único.`
      );
    }
    clientIds.add(Number(row.id));
    cpfs.add(cpf);
    const createdAt = asDate(row.created_at ?? row.criadoEm, now);
    return {
      id: Number(row.id), nome: asText(row.nome).trim() || `Cliente ${row.id}`, cpf, telefone,
      ...optionalUid(row, 'cliente_uid'),
      endereco: row.endereco ?? null, trabalho: row.trabalho ?? null, categoria_trabalho: row.categoria_trabalho ?? null,
      mal_pagador: asNumber(row.mal_pagador) ? 1 : 0, foto_cliente: row.foto_cliente ?? null,
      referencia: row.referencia ?? null, observacao: row.observacao ?? null,
      criadoEm: asDate(row.criadoEm, createdAt), created_at: createdAt,
      updated_at: asDate(row.updated_at, createdAt), last_activity_at: asDate(row.last_activity_at, createdAt),
      receber_notificacoes_cobranca: row.receber_notificacoes_cobranca == null || asNumber(row.receber_notificacoes_cobranca) ? 1 : 0,
      motivo_notificacoes_desativadas: row.motivo_notificacoes_desativadas ?? row.motivo_notificacoes_cobranca ?? null,
    };
  });

  const loanIds = new Set();
  const emprestimos = source.emprestimos.map((row) => {
    if (!clientIds.has(Number(row.cliente_id))) {
      throw mobileBackupError('INVALID_RELATIONSHIP', `Empréstimo ${row.id} aponta para cliente inexistente.`);
    }
    const createdAt = asDate(row.created_at ?? row.data, now);
    const valor = asNumber(row.valor, asNumber(row.valor_emprestado));
    const valorEmprestado = asNumber(row.valor_emprestado, valor);
    const valorAtual = asNumber(row.valor_atual, valorEmprestado);
    if (!Number.isSafeInteger(Number(row.id)) || !asText(row.data).trim()) {
      throw mobileBackupError('INCOMPATIBLE_LOAN', `Empréstimo inválido: ${row.id ?? '?'}.`);
    }
    loanIds.add(Number(row.id));
    return {
      id: Number(row.id), cliente_id: Number(row.cliente_id), codigo_cliente: row.codigo_cliente ?? null,
      ...optionalUid(row, 'emprestimo_uid'),
      valor, valor_emprestado: valorEmprestado, valor_atual: valorAtual, data: asText(row.data),
      modalidade: asText(row.modalidade, 'parcelado') || 'parcelado', taxa_juros: asNumber(row.taxa_juros),
      observacao: row.observacao ?? null, dia_pagamento: row.dia_pagamento == null ? null : asNumber(row.dia_pagamento),
      capital_restante: asNumber(row.capital_restante), saldo_devedor: asNumber(row.saldo_devedor),
      ativo: row.ativo == null || asNumber(row.ativo) ? 1 : 0, versao_atual: Math.max(1, asNumber(row.versao_atual, 1)),
      created_at: createdAt, updated_at: asDate(row.updated_at, createdAt), last_activity_at: asDate(row.last_activity_at, createdAt),
    };
  });

  const parcelIds = new Set();
  const parcelas = source.parcelas.map((row) => {
    if (!loanIds.has(Number(row.emprestimo_id))) {
      throw mobileBackupError('INVALID_RELATIONSHIP', `Parcela ${row.id} aponta para empréstimo inexistente.`);
    }
    if (!Number.isSafeInteger(Number(row.id)) || !asText(row.vencimento).trim()) {
      throw mobileBackupError('INCOMPATIBLE_INSTALLMENT', `Parcela inválida: ${row.id ?? '?'}.`);
    }
    parcelIds.add(Number(row.id));
    return {
      id: Number(row.id), emprestimo_id: Number(row.emprestimo_id), numero: Math.max(1, asNumber(row.numero, 1)),
      ...optionalUid(row, 'parcela_uid'),
      valor_total: asNumber(row.valor_total), valor_capital: asNumber(row.valor_capital), valor_juros: asNumber(row.valor_juros),
      vencimento: asText(row.vencimento), pago: asNumber(row.pago) ? 1 : 0, observacao: row.observacao ?? null,
      valor_pago: asNumber(row.valor_pago), data_pagamento: row.data_pagamento ?? null,
      juros_adicionais: asNumber(row.juros_adicionais), juros_pendentes: asNumber(row.juros_pendentes),
      valor_excedente: asNumber(row.valor_excedente), explicacao: row.explicacao ?? null,
      tipo_pagamento: row.tipo_pagamento ?? null, capital_restante: row.capital_restante == null ? null : asNumber(row.capital_restante),
      parcela_origem_numero: row.parcela_origem_numero == null ? null : asNumber(row.parcela_origem_numero),
      versao: Math.max(1, asNumber(row.versao, 1)),
    };
  });

  const emprestimosPorId = new Map(emprestimos.map((emprestimo) => [emprestimo.id, emprestimo]));
  const saldoDevedorPorEmprestimo = new Map();
  for (const parcela of parcelas) {
    const emprestimo = emprestimosPorId.get(parcela.emprestimo_id);
    if (!emprestimo || parcela.pago || parcela.versao !== emprestimo.versao_atual) continue;
    const saldoParcela = Math.max(0, parcela.valor_total + parcela.juros_adicionais - parcela.valor_pago);
    saldoDevedorPorEmprestimo.set(
      parcela.emprestimo_id,
      (saldoDevedorPorEmprestimo.get(parcela.emprestimo_id) || 0) + saldoParcela
    );
  }
  for (const emprestimo of emprestimos) {
    emprestimo.saldo_devedor = round2(Math.max(0, saldoDevedorPorEmprestimo.get(emprestimo.id) || 0));
  }

  const telefoneKeys = new Set();
  const clientesTelefones = source.clientes_telefones
    .filter((row) => clientIds.has(Number(row.cliente_id)) && asText(row.telefone).trim())
    .filter((row) => {
      const key = `${row.cliente_id}:${asText(row.telefone).trim()}`;
      if (telefoneKeys.has(key)) return false;
      telefoneKeys.add(key);
      return true;
    })
    .map((row) => ({ id: Number(row.id), cliente_id: Number(row.cliente_id), telefone: asText(row.telefone).trim(), created_at: asDate(row.created_at, now) }));

  const parcelasPorEmprestimoNumeroVersao = new Map();
  for (const parcela of parcelas) {
    const key = `${parcela.emprestimo_id}:${parcela.numero}:${parcela.versao}`;
    const matches = parcelasPorEmprestimoNumeroVersao.get(key) || [];
    matches.push(parcela.id);
    parcelasPorEmprestimoNumeroVersao.set(key, matches);
  }

  const pagamentos = source.pagamentos.map((row) => {
    if (!loanIds.has(Number(row.emprestimo_id))) {
      throw mobileBackupError('INVALID_RELATIONSHIP', `Pagamento ${row.id} aponta para empréstimo inexistente.`);
    }
    let parcelaOrigem = null;
    if (row.parcela_origem != null) {
      const indiceParcela = Number(row.parcela_origem);
      const emprestimo = emprestimos.find((item) => item.id === Number(row.emprestimo_id));
      const numeroParcela = indiceParcela + 1;
      const key = Number.isSafeInteger(indiceParcela) && indiceParcela >= 0
        ? `${row.emprestimo_id}:${numeroParcela}:${emprestimo.versao_atual}`
        : null;
      const matches = key ? (parcelasPorEmprestimoNumeroVersao.get(key) || []) : [];
      if (matches.length === 1) {
        parcelaOrigem = matches[0];
      } else {
        warnings.push(
          `Pagamento ${row.id}: parcela_origem ${row.parcela_origem} nao pode ser convertida para o emprestimo ${row.emprestimo_id} na versao ${emprestimo.versao_atual}; esperada exatamente uma parcela numero ${Number.isFinite(numeroParcela) ? numeroParcela : '?'}, encontradas ${matches.length}.`
        );
      }
    }
    return {
      id: Number(row.id), emprestimo_id: Number(row.emprestimo_id), valor: asNumber(row.valor),
      data: asDate(row.data, now), tipo_pagamento: asText(row.tipo_pagamento, 'manual') || 'manual',
      observacao: row.observacao ?? null, parcela_origem: parcelaOrigem,
      renegociacao_id: row.renegociacao_id ?? null, created_at: asDate(row.created_at ?? row.data, now),
    };
  });

  const parcelasOriginais = source.parcelas_originais
    .filter((row) => loanIds.has(Number(row.emprestimo_id)))
    .map((row) => ({
      id: Number(row.id), parcela_id: parcelIds.has(Number(row.parcela_id)) ? Number(row.parcela_id) : null,
      emprestimo_id: Number(row.emprestimo_id), numero: Math.max(1, asNumber(row.numero, 1)),
      valor_total: asNumber(row.valor_total), valor_capital: asNumber(row.valor_capital), valor_juros: asNumber(row.valor_juros),
      valor_pago: asNumber(row.valor_pago), valor_excedente: asNumber(row.valor_excedente), pago: asNumber(row.pago) ? 1 : 0,
      data_pagamento: row.data_pagamento ?? null, versao: Math.max(1, asNumber(row.versao, 1)),
      motivo: asText(row.motivo, 'importacao_desktop'), created_at: asDate(row.created_at, now),
    }));

  const caixaMovimentos = source.caixa_movimentos
    .map((row) => ({ ...row, tipoMobile: asText(row.tipo).trim().toLowerCase() }))
    .filter((row) => ['entrada', 'saida'].includes(row.tipoMobile))
    .map((row) => {
      const emprestimoExiste = loanIds.has(Number(row.emprestimo_id));
      const parcelaExiste = parcelIds.has(Number(row.parcela_id));
      if (row.emprestimo_id != null && !emprestimoExiste) {
        warnings.push(`Movimento de caixa ${row.id}: empréstimo ${row.emprestimo_id} inexistente; referência exportada como NULL.`);
      }
      if (row.parcela_id != null && !parcelaExiste) {
        warnings.push(`Movimento de caixa ${row.id}: parcela ${row.parcela_id} inexistente; referência exportada como NULL.`);
      }
      return {
        id: Number(row.id), tipo: row.tipoMobile, categoria: asText(row.categoria, 'outros') || 'outros', data: asDate(row.data, now),
        cliente_id: clientIds.has(Number(row.cliente_id)) ? Number(row.cliente_id) : null, cliente_nome: row.cliente_nome ?? null,
        emprestimo_id: emprestimoExiste ? Number(row.emprestimo_id) : null,
        parcela_id: parcelaExiste ? Number(row.parcela_id) : null,
        parcela_numero: row.parcela_numero == null ? null : asNumber(row.parcela_numero),
        data_vencimento: row.data_vencimento ?? null, data_pagamento: row.data_pagamento ?? null,
        valor_total: asNumber(row.valor_total), valor_juros: asNumber(row.valor_juros), valor_capital: asNumber(row.valor_capital),
        valor_emprestimo: asNumber(row.valor_emprestimo), valor_despesa: asNumber(row.valor_despesa),
        descricao: row.descricao ?? null, meta_json: row.meta_json ?? null, created_at: asDate(row.created_at, now),
      };
    });

  // Android's renegotiation history has a different structure. The official
  // Android converter preserves every desktop record in the mobile audit log.
  const localAuditoria = source.renegociacoes_historico.map((row) => ({
    entidade: 'renegociacoes_historico', entidade_id: Number(row.emprestimo_id) || null,
    acao: 'importacao_historico_desktop', dados_json: JSON.stringify(row), created_at: asDate(row.created_at, now),
  }));

  return {
    local_users: [], clientes, clientes_telefones: clientesTelefones, emprestimos, parcelas,
    pagamentos, parcelas_originais: parcelasOriginais, renegociacoes_historico: [],
    caixa_movimentos: caixaMovimentos, local_auditoria: localAuditoria, local_settings: [],
  };
}

async function collectPhotos({ zip, tables, photosDir, warnings }) {
  const photos = [];
  const files = [];
  const seen = new Set();
  for (const client of tables.clientes) {
    const originalPath = asText(client.foto_cliente).trim();
    if (!originalPath) continue;
    const name = path.basename(originalPath);
    const source = path.join(photosDir, name);
    const archivePath = `photos/${client.id}-${name}`;
    if (name !== originalPath || seen.has(archivePath.toLowerCase())) {
      warnings.push(`Foto do cliente ${client.id} tem um nome inválido e não foi incluída.`);
      continue;
    }
    try {
      const data = await fsp.readFile(source);
      zip.file(archivePath, data);
      photos.push({ clientId: client.id, originalPath, path: archivePath });
      files.push({ path: archivePath, size: data.length, sha256: sha256(data) });
      seen.add(archivePath.toLowerCase());
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        warnings.push(`Foto do cliente ${client.id} não encontrada no backup desktop.`);
        continue;
      }
      throw error;
    }
  }
  return { photos, files };
}

function snapshotFromTables(tables, createdAt) {
  const payload = {
    formatVersion: 1,
    database: MOBILE_DATABASE_NAME,
    schemaVersion: MOBILE_SCHEMA_VERSION,
    createdAt,
    tables,
  };
  return {
    ...payload,
    checksum: sha256(JSON.stringify(payload)),
    counts: Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length])),
  };
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.formatVersion !== 1 || snapshot.database !== MOBILE_DATABASE_NAME || !snapshot.tables || !snapshot.checksum) {
    throw mobileBackupError('INVALID_MOBILE_SNAPSHOT', 'Estrutura de snapshot Android inválida.');
  }
  if (Number(snapshot.schemaVersion) > MOBILE_SCHEMA_VERSION) {
    throw mobileBackupError('INVALID_MOBILE_SNAPSHOT', 'O snapshot usa uma versão Android mais nova.');
  }
  const { checksum, counts, ...payload } = snapshot;
  if (checksum !== sha256(JSON.stringify(payload))) {
    throw mobileBackupError('INVALID_MOBILE_SNAPSHOT', 'Checksum do snapshot Android inválido.');
  }
  for (const table of MOBILE_TABLES) {
    if (!Array.isArray(snapshot.tables[table])) {
      throw mobileBackupError('INVALID_MOBILE_SNAPSHOT', `Tabela Android ausente: ${table}.`);
    }
    if (Number(counts && counts[table]) !== snapshot.tables[table].length) {
      throw mobileBackupError('INVALID_MOBILE_SNAPSHOT', `Contagem Android inválida: ${table}.`);
    }
  }
}

const MOBILE_SCHEMA_SQL = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE local_users (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, password_iterations INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE clientes (id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_uid TEXT UNIQUE, nome TEXT NOT NULL, cpf TEXT NOT NULL, telefone TEXT NOT NULL, endereco TEXT, trabalho TEXT, categoria_trabalho TEXT, mal_pagador INTEGER NOT NULL DEFAULT 0 CHECK (mal_pagador IN (0, 1)), foto_cliente TEXT, referencia TEXT, observacao TEXT, criadoEm TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, receber_notificacoes_cobranca INTEGER NOT NULL DEFAULT 1 CHECK (receber_notificacoes_cobranca IN (0, 1)), motivo_notificacoes_desativadas TEXT);
  CREATE UNIQUE INDEX idx_local_clientes_cpf_unique ON clientes(cpf);
  CREATE TABLE clientes_telefones (id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_id INTEGER NOT NULL, telefone TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE, UNIQUE (cliente_id, telefone));
  CREATE TABLE emprestimos (id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_uid TEXT UNIQUE, cliente_id INTEGER NOT NULL, codigo_cliente TEXT, valor REAL NOT NULL, valor_emprestado REAL NOT NULL, valor_atual REAL NOT NULL, data TEXT NOT NULL, modalidade TEXT NOT NULL DEFAULT 'parcelado', taxa_juros REAL NOT NULL DEFAULT 0, observacao TEXT, dia_pagamento INTEGER, capital_restante REAL NOT NULL DEFAULT 0, saldo_devedor REAL NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)), versao_atual INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE RESTRICT);
  CREATE TABLE parcelas (id INTEGER PRIMARY KEY AUTOINCREMENT, parcela_uid TEXT UNIQUE, emprestimo_id INTEGER NOT NULL, numero INTEGER NOT NULL, valor_total REAL NOT NULL, valor_capital REAL NOT NULL, valor_juros REAL NOT NULL, vencimento TEXT NOT NULL, pago INTEGER NOT NULL DEFAULT 0 CHECK (pago IN (0, 1)), observacao TEXT, valor_pago REAL NOT NULL DEFAULT 0, data_pagamento TEXT, juros_adicionais REAL NOT NULL DEFAULT 0, juros_pendentes REAL NOT NULL DEFAULT 0, valor_excedente REAL NOT NULL DEFAULT 0, explicacao TEXT, tipo_pagamento TEXT, capital_restante REAL, parcela_origem_numero INTEGER, versao INTEGER NOT NULL DEFAULT 1, FOREIGN KEY (emprestimo_id) REFERENCES emprestimos(id) ON DELETE CASCADE, UNIQUE (emprestimo_id, versao, numero));
  CREATE TABLE pagamentos (id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER NOT NULL, valor REAL NOT NULL, data TEXT NOT NULL, tipo_pagamento TEXT NOT NULL, observacao TEXT, parcela_origem INTEGER, renegociacao_id INTEGER, created_at TEXT NOT NULL, FOREIGN KEY (emprestimo_id) REFERENCES emprestimos(id) ON DELETE RESTRICT, FOREIGN KEY (parcela_origem) REFERENCES parcelas(id) ON DELETE SET NULL);
  CREATE TABLE parcelas_originais (id INTEGER PRIMARY KEY AUTOINCREMENT, parcela_id INTEGER, emprestimo_id INTEGER NOT NULL, numero INTEGER NOT NULL, valor_total REAL NOT NULL, valor_capital REAL NOT NULL, valor_juros REAL NOT NULL, valor_pago REAL NOT NULL DEFAULT 0, valor_excedente REAL NOT NULL DEFAULT 0, pago INTEGER NOT NULL DEFAULT 0, data_pagamento TEXT, versao INTEGER NOT NULL, motivo TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (emprestimo_id) REFERENCES emprestimos(id) ON DELETE CASCADE);
  CREATE TABLE renegociacoes_historico (id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER NOT NULL, versao_anterior INTEGER NOT NULL, versao_nova INTEGER NOT NULL, tipo TEXT NOT NULL, capital_anterior REAL NOT NULL, capital_novo REAL NOT NULL, taxa_juros REAL NOT NULL, qtd_parcelas INTEGER NOT NULL, data_inicio TEXT NOT NULL, observacao TEXT, created_at TEXT NOT NULL, FOREIGN KEY (emprestimo_id) REFERENCES emprestimos(id) ON DELETE CASCADE);
  CREATE TABLE caixa_movimentos (id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL CHECK (tipo IN ('entrada', 'saida')), categoria TEXT NOT NULL, data TEXT NOT NULL, cliente_id INTEGER, cliente_nome TEXT, emprestimo_id INTEGER, parcela_id INTEGER, parcela_numero INTEGER, data_vencimento TEXT, data_pagamento TEXT, valor_total REAL NOT NULL DEFAULT 0, valor_juros REAL NOT NULL DEFAULT 0, valor_capital REAL NOT NULL DEFAULT 0, valor_emprestimo REAL NOT NULL DEFAULT 0, valor_despesa REAL NOT NULL DEFAULT 0, descricao TEXT, meta_json TEXT, created_at TEXT NOT NULL, FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE SET NULL, FOREIGN KEY (emprestimo_id) REFERENCES emprestimos(id) ON DELETE SET NULL, FOREIGN KEY (parcela_id) REFERENCES parcelas(id) ON DELETE SET NULL);
  CREATE TABLE local_auditoria (id INTEGER PRIMARY KEY AUTOINCREMENT, entidade TEXT NOT NULL, entidade_id INTEGER, acao TEXT NOT NULL, dados_json TEXT, created_at TEXT NOT NULL);
  CREATE TABLE local_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

async function validateRestoreAgainstMobileSchema(snapshot) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'emprestimos-mobile-validate-'));
  const dbPath = path.join(directory, 'mobile.db');
  let db;
  try {
    db = await openDatabase(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
    await exec(db, MOBILE_SCHEMA_SQL);
    await run(db, 'BEGIN IMMEDIATE TRANSACTION');
    try {
      for (const table of MOBILE_TABLES) {
        for (const row of snapshot.tables[table]) {
          const keys = Object.keys(row);
          if (!keys.length) continue;
          await run(
            db,
            `INSERT INTO ${quoteIdentifier(table)} (${keys.map(quoteIdentifier).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
            keys.map((key) => row[key])
          );
        }
      }
      const foreign = await all(db, 'PRAGMA foreign_key_check');
      if (foreign.length) {
        throw mobileBackupError('INVALID_MOBILE_RELATIONSHIP', 'O pacote mobile gerado possui relações inválidas.');
      }
      for (const table of MOBILE_TABLES) {
        const rows = await all(db, `SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)}`);
        if (Number(rows[0].total) !== snapshot.tables[table].length) {
          throw mobileBackupError('INVALID_MOBILE_COUNTS', `Contagem divergente após a restauração Android: ${table}.`);
        }
      }
      await run(db, 'COMMIT');
    } catch (error) {
      await run(db, 'ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    if (db) await closeDatabase(db);
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

async function verifyMobileBackup(filePath, expectedCounts) {
  const bytes = await fsp.readFile(filePath);
  const zip = await JSZip.loadAsync(bytes);
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) throw mobileBackupError('INVALID_MOBILE_BACKUP', 'Manifesto Android ausente.');
  let manifest;
  try {
    manifest = JSON.parse(await manifestFile.async('string'));
  } catch {
    throw mobileBackupError('INVALID_MOBILE_BACKUP', 'Manifesto Android inválido.');
  }
  if (manifest.formatVersion !== 1 || Number(manifest.schemaVersion) > MOBILE_SCHEMA_VERSION || manifest.snapshot !== SNAPSHOT_PATH || !Array.isArray(manifest.files) || !Array.isArray(manifest.photos)) {
    throw mobileBackupError('INVALID_MOBILE_BACKUP', 'Manifesto Android incompatível.');
  }
  for (const item of manifest.files) {
    const file = zip.file(item && item.path);
    if (!file) throw mobileBackupError('INVALID_MOBILE_BACKUP', `Arquivo ausente no pacote Android: ${item && item.path}.`);
    const data = await file.async('nodebuffer');
    if (data.length !== Number(item.size) || sha256(data) !== item.sha256) {
      throw mobileBackupError('INVALID_MOBILE_BACKUP', `Integridade inválida: ${item.path}.`);
    }
  }
  const snapshotFile = zip.file(SNAPSHOT_PATH);
  if (!snapshotFile) throw mobileBackupError('INVALID_MOBILE_BACKUP', 'Snapshot Android ausente.');
  let snapshot;
  try {
    snapshot = JSON.parse(await snapshotFile.async('string'));
  } catch {
    throw mobileBackupError('INVALID_MOBILE_BACKUP', 'Snapshot Android inválido.');
  }
  validateSnapshot(snapshot);
  for (const [table, count] of Object.entries(expectedCounts)) {
    if (Number(snapshot.counts[table]) !== Number(count)) {
      throw mobileBackupError('INVALID_MOBILE_COUNTS', `Contagem divergente no pacote Android: ${table}.`);
    }
  }
  const clientPhotos = new Map(snapshot.tables.clientes.map((client) => [Number(client.id), client.foto_cliente]));
  for (const photo of manifest.photos) {
    if (!clientPhotos.has(Number(photo.clientId)) || clientPhotos.get(Number(photo.clientId)) !== photo.originalPath || !zip.file(photo.path)) {
      throw mobileBackupError('INVALID_MOBILE_PHOTOS', 'As fotos do pacote Android não correspondem aos clientes.');
    }
  }
  await validateRestoreAgainstMobileSchema(snapshot);
  return { manifest, snapshot };
}

async function createMobileBackupFromDesktopBundle({ desktopBundlePath, outputPath }) {
  const stagingDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'emprestimos-mobile-export-'));
  try {
    // extractBackupBundle verifies the desktop V2 manifest and every SHA-256
    // before any desktop data is read by the converter.
    const extracted = await extractBackupBundle({ backupPath: desktopBundlePath, destinationDir: stagingDir });
    const source = await readSourceTables(extracted.dbPath);
    const createdAt = new Date().toISOString();
    const warnings = [];
    const tables = convertTables(source, createdAt, warnings);
    const snapshot = snapshotFromTables(tables, createdAt);
    const snapshotText = JSON.stringify(snapshot);
    warnings.unshift(
      `Importado do backup desktop criado em ${extracted.manifest.createdAt}.`,
      `${source.renegociacoes_historico.length} registro(s) de histórico de renegociação foram preservados no log de auditoria por usarem um formato diferente no Android.`,
      'A restauração no celular substitui os dados locais e exigirá a criação de um novo acesso local após reiniciar o aplicativo.',
    );
    const zip = new JSZip();
    zip.file(SNAPSHOT_PATH, snapshotText);
    const files = [{ path: SNAPSHOT_PATH, size: Buffer.byteLength(snapshotText), sha256: sha256(snapshotText) }];
    const photoData = await collectPhotos({ zip, tables, photosDir: extracted.photosDir, warnings });
    files.push(...photoData.files);
    const manifest = {
      formatVersion: 1,
      id: crypto.randomUUID(),
      createdAt,
      schemaVersion: MOBILE_SCHEMA_VERSION,
      snapshot: SNAPSHOT_PATH,
      photos: photoData.photos,
      files,
      warnings,
    };
    zip.file('manifest.json', JSON.stringify(manifest));
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.writeFile(outputPath, bytes, { flag: 'wx' });
    try {
      await verifyMobileBackup(outputPath, snapshot.counts);
    } catch (error) {
      await fsp.unlink(outputPath).catch(() => {});
      throw error;
    }
    return {
      path: outputPath,
      size: bytes.length,
      counts: snapshot.counts,
      photoCount: photoData.photos.length,
      warnings,
      formatVersion: 1,
      schemaVersion: MOBILE_SCHEMA_VERSION,
    };
  } finally {
    await fsp.rm(stagingDir, { recursive: true, force: true });
  }
}

module.exports = {
  MOBILE_DATABASE_NAME,
  MOBILE_SCHEMA_VERSION,
  createMobileBackupFromDesktopBundle,
  verifyMobileBackup,
  __test: { convertTables, snapshotFromTables, validateSnapshot },
};
