const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'models', 'database.db'); // Ajuste se necessário
const db = new sqlite3.Database(dbPath);

const colunas = [
  { nome: 'pago', tipo: 'BOOLEAN', default: 'FALSE' },
  { nome: 'valor_pago', tipo: 'REAL', default: 'NULL' },
  { nome: 'data_pagamento', tipo: 'TEXT', default: 'NULL' },
  { nome: 'juros_adicionais', tipo: 'REAL', default: 'NULL' }
];

function adicionarColunas(index = 0) {
  if (index >= colunas.length) {
    console.log('Todas as colunas foram verificadas.');
    db.close();
    return;
  }

  const { nome, tipo, default: padrao } = colunas[index];
  db.run(
    `ALTER TABLE parcelas ADD COLUMN ${nome} ${tipo} DEFAULT ${padrao}`,
    (err) => {
      if (err) {
        if (err.message.includes('duplicate column name')) {
          console.log(`Coluna '${nome}' já existe.`);
        } else {
          console.error(`Erro ao adicionar coluna '${nome}':`, err.message);
        }
      } else {
        console.log(`Coluna '${nome}' adicionada com sucesso.`);
      }
      adicionarColunas(index + 1);
    }
  );
}

adicionarColunas();