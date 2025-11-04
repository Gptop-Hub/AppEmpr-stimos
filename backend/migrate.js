const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'models', 'database.db');
const db = new sqlite3.Database(dbPath, err => {
  if (err) {
    console.error('Erro ao abrir banco:', err.message);
    process.exit(1);
  }
  console.log('Banco aberto em', dbPath);
});

db.serialize(() => {
  // Alterações tabela emprestimos
  db.run(`ALTER TABLE emprestimos ADD COLUMN modalidade TEXT;`, err => {
    if (err && !/duplicate column/.test(err.message)) console.error(err.message);
  });
  db.run(`ALTER TABLE emprestimos ADD COLUMN taxa_juros REAL;`, err => {
    if (err && !/duplicate column/.test(err.message)) console.error(err.message);
  });
  db.run(`ALTER TABLE emprestimos ADD COLUMN observacao TEXT;`, err => {
    if (err && !/duplicate column/.test(err.message)) console.error(err.message);
  });

  // Alterações tabela parcelas
  db.run(`ALTER TABLE parcelas ADD COLUMN valor_pago REAL DEFAULT 0;`, err => {
    if (err && !/duplicate column/.test(err.message)) console.error(err.message);
  });
  db.run(`ALTER TABLE parcelas ADD COLUMN valor_excedente REAL DEFAULT 0;`, err => {
    if (err && !/duplicate column/.test(err.message)) console.error(err.message);
  });
  db.run(`ALTER TABLE parcelas ADD COLUMN data_pagamento TEXT;`, err => {
    if (err && !/duplicate column/.test(err.message)) console.error(err.message);
  });
  db.run(`ALTER TABLE parcelas ADD COLUMN pago INTEGER DEFAULT 0;`, err => {
    if (err && !/duplicate column/.test(err.message)) console.error(err.message);
  });

  // Alterações tabela pagamentos
  db.run(`ALTER TABLE pagamentos ADD COLUMN tipo_pagamento TEXT DEFAULT 'normal';`, err => {
    if (err && !/duplicate column/.test(err.message)) console.error(err.message);
  });
  db.run(`ALTER TABLE pagamentos ADD COLUMN observacao TEXT;`, err => {
    if (err && !/duplicate column/.test(err.message)) console.error(err.message);
  });
});

db.close(err => {
  if (err) console.error('Erro ao fechar banco:', err.message);
  else console.log('Migração concluída.');
});