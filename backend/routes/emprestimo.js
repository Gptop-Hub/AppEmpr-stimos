// backend/routes/emprestimo.js

const express = require('express');
const router = express.Router();

// Importa o controller de empréstimos (garanta que o arquivo exista em backend/controllers/emprestimosController.js)
const emprestimosController = require('../controllers/emprestimosController');

// Rotas de empréstimos

// 🔹 Rota para histórico (deve vir antes de '/:id' para não conflitar)
router.get('/historico', emprestimosController.listarHistorico);

// 🔹 CRUD principal
router.get('/', emprestimosController.listarTodos);
router.get('/:id', emprestimosController.buscarPorId);
router.post('/', emprestimosController.criar);
router.put('/:id', emprestimosController.atualizar);
router.delete('/:id', emprestimosController.excluir);

module.exports = router;