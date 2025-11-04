const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, 'models', 'database.db'); // ajuste o caminho se necessário

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Erro ao conectar:', err.message);
    return;
  }

  db.run('ALTER TABLE emprestimos ADD COLUMN dia_pagamento INTEGER', (err2) => {
    if (err2) {
      if (err2.message.includes('duplicate column name')) {
        console.log('✅ A coluna "dia_pagamento" já existe.');
      } else {
        console.error('Erro ao adicionar coluna:', err2.message);
      }
    } else {
      console.log('✅ Coluna "dia_pagamento" adicionada com sucesso.');
    }
    db.close();
  });
});