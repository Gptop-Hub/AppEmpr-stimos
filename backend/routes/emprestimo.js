// backend/routes/emprestimo.js
const express = require('express');
const router = express.Router();

const emprestimosController = require('../controllers/emprestimosController');
const renegociacaoController = require('../controllers/renegociacaoController');

// histórico precisa vir antes de '/:id'
router.get('/historico', emprestimosController.listarHistorico);

// CRUD
router.get('/', emprestimosController.listarTodos);
router.get('/:id', emprestimosController.buscarPorId);
router.post('/', emprestimosController.criar);
router.put('/:id', emprestimosController.atualizar);
router.delete('/:id', emprestimosController.excluir);

// renegociação in-place + histórico
router.post('/:id/renegociar-inplace', renegociacaoController.renegociarInplace);
router.get('/:id/versoes', renegociacaoController.listarVersoesHistorico);
router.get('/:id/versoes/:versao', renegociacaoController.obterVersaoHistorico);

module.exports = router;