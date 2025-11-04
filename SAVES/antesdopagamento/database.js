// backend/models/database.js
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const dbPath = path.resolve(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath);

/**
 * Verifica se uma coluna existe em uma tabela (callback boolean)
 */
function colunaExiste(tabela, coluna, callback) {
  db.all(`PRAGMA table_info(${tabela});`, (err, colunas) => {
    if (err) {
      console.error(`[ERRO] Verificando coluna ${coluna} na tabela ${tabela}:`, err.message);
      return callback(false);
    }
    const existe = Array.isArray(colunas) && colunas.some(col => col && col.name === coluna);
    callback(existe);
  });
}

/**
 * Aplica uma migration condicionalmente (só se a coluna não existir).
 * Trata erros 'duplicate column' como informativos (não falha).
 */
function aplicarMigracaoCondicional(file, tabela, coluna) {
  const migrationsDir = path.resolve(__dirname, '../migrations');
  const caminho = path.join(migrationsDir, file);
  if (!fs.existsSync(caminho)) {
    // arquivo de migração ausente: apenas ignore
    return;
  }
  const sql = fs.readFileSync(caminho, 'utf8');

  colunaExiste(tabela, coluna, (existe) => {
    if (existe) {
      console.log(`[INFO] Coluna '${coluna}' já existe na tabela '${tabela}'. Ignorando ${file}`);
      return;
    }

    // executa SQL e trata erro de coluna duplicada como não-fatal
    db.exec(sql, (err) => {
      if (err) {
        const msg = (err && err.message) ? String(err.message) : String(err);
        if (msg.toLowerCase().includes('duplicate column') || msg.toLowerCase().includes('already exists')) {
          console.log(`[INFO] Migração ${file} não aplicada pois a coluna já existe (${coluna}). Mensagem: ${msg}`);
          return;
        }
        console.error(`[ERRO] Aplicando migração ${file}:`, msg);
        return;
      }
      console.log(`[MIGRAÇÃO] Aplicada: ${file}`);
    });
  });
}

/**
 * Aplica várias migrações (chamadas idempotentes)
 */
function aplicarMigracoes() {
  aplicarMigracaoCondicional('add_coluna_data_pagamento.sql', 'parcelas', 'data_pagamento');
  aplicarMigracaoCondicional('add_coluna_juros_adicionais.sql', 'parcelas', 'juros_adicionais');
  aplicarMigracaoCondicional('add_coluna_dia_pagamento.sql', 'emprestimos', 'dia_pagamento');
  aplicarMigracaoCondicional('add_coluna_valor_pago.sql', 'parcelas', 'valor_pago');
  aplicarMigracaoCondicional('add_coluna_observacao_parcelas.sql', 'parcelas', 'observacao');
  aplicarMigracaoCondicional('add_coluna_pago.sql', 'parcelas', 'pago');
  aplicarMigracaoCondicional('add_coluna_valor_excedente.sql', 'parcelas', 'valor_excedente');
  aplicarMigracaoCondicional('add_coluna_parcela_origem_em_pagamentos.sql', 'pagamentos', 'parcela_origem');
  aplicarMigracaoCondicional('capital_restante.sql', 'parcelas', 'capital_restante');
  aplicarMigracaoCondicional('create_table_parcelas_originais.sql', 'parcelas_originais', 'id');
  aplicarMigracaoCondicional('add_coluna_parcela_origem_numero.sql', 'parcelas', 'parcela_origem_numero');
  aplicarMigracaoCondicional('add_coluna_parcela_id.sql', 'parcelas_originais', 'parcela_id');
  aplicarMigracaoCondicional('add_coluna_valor_pago_parcelas_originais.sql', 'parcelas_originais', 'valor_pago');
  aplicarMigracaoCondicional('add_coluna_valor_excedente_parcelas_originais.sql', 'parcelas_originais', 'valor_excedente');
  aplicarMigracaoCondicional('add_coluna_data_pagamento_parcelas_originais.sql', 'parcelas_originais', 'data_pagamento');
  aplicarMigracaoCondicional('add_coluna_pago_parcelas_originais.sql', 'parcelas_originais', 'pago');
}

/* ---------- criação de tabelas (idempotente) ---------- */
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    cpf TEXT,
    telefone TEXT,
    endereco TEXT,
    trabalho TEXT,
    referencia TEXT,
    observacao TEXT,
    criadoEm TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS emprestimos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER,
    codigo_cliente TEXT,
    valor REAL,
    data TEXT,
    modalidade TEXT,
    taxa_juros REAL,
    observacao TEXT,
    dia_pagamento INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS parcelas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emprestimo_id INTEGER,
    numero INTEGER,
    valor_total REAL,
    valor_capital REAL,
    valor_juros REAL,
    vencimento TEXT,
    pago INTEGER,
    observacao TEXT,
    valor_pago REAL,
    data_pagamento TEXT,
    juros_adicionais REAL,
    valor_excedente REAL,
    explicacao TEXT,
    tipo_pagamento TEXT,
    capital_restante REAL,
    parcela_origem_numero INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emprestimo_id INTEGER,
    valor REAL,
    data TEXT,
    tipo_pagamento TEXT,
    observacao TEXT,
    parcela_origem INTEGER,
    FOREIGN KEY (emprestimo_id) REFERENCES emprestimos(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS parcelas_originais (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parcela_id INTEGER,
    emprestimo_id INTEGER,
    numero INTEGER,
    valor_total REAL,
    valor_capital REAL,
    valor_juros REAL,
    valor_pago REAL,
    valor_excedente REAL,
    pago INTEGER,
    data_pagamento TEXT
  )`);

  // agora aplicamos as migrações (de forma segura / idempotente)
  aplicarMigracoes();
});

module.exports = db;