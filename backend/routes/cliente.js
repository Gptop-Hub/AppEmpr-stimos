// routes/cliente.js
const express = require('express');
const router = express.Router();
const db = require('../models/database');

/**
 * Helper: limpa CPF (remove qualquer não-dígito)
 */
function cleanCpf(cpf) {
  if (!cpf && cpf !== 0) return '';
  return String(cpf).replace(/\D/g, '');
}

/**
 * Buscar todos os clientes
 */
router.get('/', (req, res) => {
  db.all('SELECT * FROM clientes', (err, rows) => {
    if (err) {
      console.error('Erro ao buscar clientes:', err.message);
      return res.status(500).json({ error: 'Erro ao buscar clientes.' });
    }
    res.json(rows);
  });
});

/**
 * Checar se ID existe (rota para validação no frontend)
 * GET /clientes/check-id/:id
 */
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

/**
 * Checar se CPF já existe
 * GET /clientes/check-cpf?cpf=...
 */
router.get('/check-cpf', (req, res) => {
  const cpfRaw = req.query.cpf;
  if (!cpfRaw) return res.status(400).json({ error: 'CPF obrigatório' });

  const cpf = cleanCpf(cpfRaw);
  if (!cpf) return res.status(400).json({ error: 'CPF inválido' });

  // compara removendo '.' e '-' da coluna cpf
  db.get(
    `SELECT id FROM clientes WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? LIMIT 1`,
    [cpf],
    (err, row) => {
      if (err) {
        console.error('[ERRO] GET /clientes/check-cpf', err.message);
        return res.status(500).json({ error: 'Erro interno' });
      }
      res.json({ exists: !!row, id: row ? row.id : null });
    }
  );
});

/**
 * Buscar cliente por ID
 * (rota param deve vir depois das rotas específicas)
 */
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

/**
 * Cadastrar novo cliente (id manual opcional)
 */
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

  const cpfClean = cleanCpf(cpf);
  if (!cpfClean) {
    return res.status(400).json({ error: 'CPF inválido.' });
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
    values.push(nome, cpfClean, telefone, endereco || '', trabalho || '', referencia || '', observacao || '', criadoEm);

    const sql = `INSERT INTO clientes (${cols.join(',')}) VALUES (${placeholders.join(',')})`;

    db.run(sql, values, function(err) {
      if (err) {
        console.error('Erro ao inserir cliente:', err.message);

        // lidar com constraint UNIQUE no CPF (e também ID)
        if (err.code === 'SQLITE_CONSTRAINT' || err.message.includes('UNIQUE')) {
          // tentar identificar se é CPF duplicado ou ID duplicado
          if (err.message.includes('clientes.cpf') || err.message.toLowerCase().includes('cpf')) {
            return res.status(409).json({ error: 'CPF já cadastrado.' });
          }
          if (novoId && (err.message.includes('clientes.id') || err.message.toLowerCase().includes('id'))) {
            return res.status(409).json({ error: `ID ${novoId} já existe.` });
          }
          // fallback
          return res.status(409).json({ error: 'Registro duplicado (constraint).' });
        }

        return res.status(500).json({ error: 'Erro ao salvar cliente.' });
      }

      res.status(201).json({
        id: novoId || this.lastID,
        nome, cpf: cpfClean, telefone, endereco, trabalho,
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

      // Também checar CPF existente (entre IDs)
      db.get(
        `SELECT id FROM clientes WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? LIMIT 1`,
        [cpfClean],
        (err2, row2) => {
          if (err2) {
            console.error('Erro ao verificar CPF:', err2.message);
            return res.status(500).json({ error: 'Erro ao salvar cliente.' });
          }
          if (row2) {
            return res.status(409).json({ error: 'CPF já cadastrado.' });
          }
          inserir(id);
        }
      );
    });
  } else {
    // Se ID não foi informado, buscar todos os IDs existentes ordenados
    // Antes de inserir, checar CPF duplicado
    db.get(
      `SELECT id FROM clientes WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? LIMIT 1`,
      [cpfClean],
      (errCpf, rowCpf) => {
        if (errCpf) {
          console.error('Erro ao checar CPF antes de inserir:', errCpf.message);
          return res.status(500).json({ error: 'Erro ao salvar cliente.' });
        }
        if (rowCpf) {
          return res.status(409).json({ error: 'CPF já cadastrado.' });
        }

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
    );
  }
});

/**
 * Editar cliente existente
 */
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

  const cpfClean = cleanCpf(cpf);
  if (!cpfClean) {
    return res.status(400).json({ error: 'CPF inválido.' });
  }

  // Verifica se cpf já pertence a outro cliente
  db.get(
    `SELECT id FROM clientes WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? AND id != ? LIMIT 1`,
    [cpfClean, id],
    (errCheck, rowCheck) => {
      if (errCheck) {
        console.error('Erro ao checar CPF para edição:', errCheck.message);
        return res.status(500).json({ error: 'Erro ao editar cliente.' });
      }
      if (rowCheck) {
        return res.status(409).json({ error: 'CPF já cadastrado para outro cliente.' });
      }

      const sql = `UPDATE clientes
                   SET nome = ?, cpf = ?, telefone = ?, endereco = ?, trabalho = ?,
                       referencia = ?, observacao = ?, criadoEm = ?
                   WHERE id = ?`;

      db.run(sql,[nome, cpfClean, telefone, endereco || '', trabalho || '', referencia || '', observacao || '', criadoEm, id], function (err) {
        if (err) {
          console.error('Erro ao atualizar cliente:', err.message);

          // tratar constraint inesperada
          if (err.code === 'SQLITE_CONSTRAINT' || err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: 'CPF já cadastrado (constraint).' });
          }
          return res.status(500).json({ error: 'Erro ao editar cliente.' });
        }
        if (this.changes === 0) {
          return res.status(404).json({ error: 'Cliente não encontrado.' });
        }
        res.json({ id, nome, cpf: cpfClean, telefone, endereco, trabalho, referencia, observacao, criadoEm });
      });
    }
  );
});

/**
 * Excluir cliente
 */
router.delete('/:id', (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM clientes WHERE id = ?', [id], function (err) {
    if (err) {
      console.error('Erro ao excluir cliente:', err.message);
      return res.status(500).json({ error: 'Erro ao excluir cliente.' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    res.json({ message: 'Cliente excluído com sucesso.' });
  });
});

module.exports = router;