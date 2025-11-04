const express = require('express');
const router = express.Router();
const db = require('../models/database');

// Buscar todos os clientes
router.get('/', (req, res) => {
  db.all('SELECT * FROM clientes', (err, rows) => {
    if (err) {
      console.error('Erro ao buscar clientes:', err.message);
      return res.status(500).json({ error: 'Erro ao buscar clientes.' });
    }
    res.json(rows);
  });
});

// Buscar cliente por ID
router.get('/:id', (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM clientes WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error('Erro ao buscar cliente:', err.message);
      return res.status(500).json({ error: 'Erro ao buscar cliente.' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    res.json(row);
  });
});

// Checar se ID existe (rota para validação no frontend)
router.get('/check-id/:id', (req, res) => {
  const id = req.params.id;
  db.get('SELECT id FROM clientes WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error('Erro ao checar ID:', err.message);
      return res.status(500).json({ error: 'Erro no servidor.' });
    }
    res.json({ exists: !!row });
  });
});

// Cadastrar novo cliente (id manual opcional)
router.post('/', (req, res) => {
  const {
    id,
    nome, cpf, telefone,
    endereco, trabalho,
    referencia, observacao,
    criadoEm
  } = req.body;

  // Validação: só campos obrigatórios nome, cpf, telefone e criadoEm
  if (!nome || !cpf || !telefone || !criadoEm) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  // Função para inserir cliente com id definido
  const inserir = (novoId) => {
    const cols = [];
    const placeholders = [];
    const values = [];

    if (novoId) {
      cols.push('id');
      placeholders.push('?');
      values.push(novoId);
    }

    cols.push('nome','cpf','telefone','endereco','trabalho','referencia','observacao','criadoEm');
    placeholders.push('?','?','?','?','?','?','?','?');
    values.push(nome, cpf, telefone, endereco || '', trabalho || '', referencia || '', observacao || '', criadoEm);

    const sql = `INSERT INTO clientes (${cols.join(',')}) VALUES (${placeholders.join(',')})`;

    db.run(sql, values, function(err) {
      if (err) {
        console.error('Erro ao inserir cliente:', err.message);
        if (err.message.includes('UNIQUE constraint failed') || err.message.includes('constraint failed')) {
          return res.status(409).json({ error: `ID ${novoId} já existe.` });
        }
        return res.status(500).json({ error: 'Erro ao salvar cliente.' });
      }

      res.status(201).json({
        id: novoId || this.lastID,
        nome, cpf, telefone, endereco, trabalho,
        referencia, observacao, criadoEm
      });
    });
  };

  // Se o ID foi informado no corpo da requisição, tenta usar ele
  if (id) {
    // Verifica se o ID já existe para evitar conflito
    db.get('SELECT id FROM clientes WHERE id = ?', [id], (err, row) => {
      if (err) {
        console.error('Erro ao verificar ID:', err.message);
        return res.status(500).json({ error: 'Erro ao salvar cliente.' });
      }
      if (row) {
        return res.status(409).json({ error: `ID ${id} já existe.` });
      }
      inserir(id);
    });
  } else {
    // Se ID não foi informado, buscar todos os IDs existentes ordenados
    db.all('SELECT id FROM clientes ORDER BY id ASC', (err, rows) => {
      if (err) {
        console.error('Erro ao buscar IDs:', err.message);
        return res.status(500).json({ error: 'Erro ao salvar cliente.' });
      }

      // Se não tem clientes, id começa em 1
      if (!rows || rows.length === 0) {
        return inserir(1);
      }

      // Agora procura o menor ID livre (buraco)
      let nextId = 1;
      for (let i = 0; i < rows.length; i++) {
        const currentId = rows[i].id;
        if (currentId !== nextId) {
          // achou o buraco
          break;
        }
        nextId++;
      }
      inserir(nextId);
    });
  }
});

// Editar cliente existente
router.put('/:id', (req, res) => {
  const id = req.params.id;
  const {
    nome, cpf, telefone,
    endereco, trabalho,
    referencia, observacao,
    criadoEm
  } = req.body;

  // Validação campos obrigatórios só esses 4
  if (!nome || !cpf || !telefone || !criadoEm) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const sql = `UPDATE clientes
               SET nome = ?, cpf = ?, telefone = ?, endereco = ?, trabalho = ?,
                   referencia = ?, observacao = ?, criadoEm = ?
               WHERE id = ?`;

  db.run(sql,[nome, cpf, telefone, endereco || '', trabalho || '', referencia || '', observacao || '', criadoEm, id], function (err) {
    if (err) {
      return res.status(500).json({ error: 'Erro ao editar cliente.' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    res.json({ id, nome, cpf, telefone, endereco, trabalho, referencia, observacao, criadoEm });
  });
});

// Excluir cliente
router.delete('/:id', (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM clientes WHERE id = ?', [id], function (err) {
    if (err) {
      return res.status(500).json({ error: 'Erro ao excluir cliente.' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    res.json({ message: 'Cliente excluído com sucesso.' });
  });
});

module.exports = router;