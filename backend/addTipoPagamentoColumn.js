const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Caminho correto para o banco
const dbPath = path.resolve(__dirname, 'models', 'database.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Erro ao conectar no banco de dados:', err.message);
    return;
  }

  console.log('✅ Conectado ao banco de dados');
  
  // Adicionar a nova coluna
  db.run(`ALTER TABLE pagamentos ADD COLUMN tipo_pagamento TEXT DEFAULT 'adiantado_total'`, (err) => {
    if (err) {
      console.error('❌ Erro ao adicionar coluna:', err);
    } else {
      console.log('✅ Coluna "tipo_pagamento" adicionada com sucesso!');
    }

    db.close();
  });
});