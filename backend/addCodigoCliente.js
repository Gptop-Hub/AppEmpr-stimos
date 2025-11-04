const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'models', 'database.db'); // ajuste o caminho se necessário
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Verifica as colunas atuais da tabela emprestimos
  db.all(`PRAGMA table_info(emprestimos)`, (err, rows) => {
    if (err) {
      console.error('Erro ao obter colunas da tabela emprestimos:', err.message);
      db.close();
      return;
    }

    const colunas = rows.map(col => col.name);
    console.log('Colunas atuais da tabela emprestimos:', colunas);

    if (colunas.includes('codigo_cliente')) {
      console.log('Coluna codigo_cliente já existe. Nada a fazer.');
      db.close();
    } else {
      // Adiciona a coluna codigo_cliente sem UNIQUE
      db.run(`ALTER TABLE emprestimos ADD COLUMN codigo_cliente TEXT`, (err) => {
        if (err) {
          console.error('Erro ao adicionar coluna codigo_cliente:', err.message);
        } else {
          console.log('Coluna codigo_cliente adicionada com sucesso!');
        }
        db.close();
      });
    }
  });
});