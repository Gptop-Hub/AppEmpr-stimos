// backend/routes/emprestimo.js
const express = require('express');
const router = express.Router();
const { exigirProtecao } = require('../middleware/protecao');

const emprestimosController = require('../controllers/emprestimosController');
const renegociacaoController = require('../controllers/renegociacaoController');
const recalculoAtrasoController = require('../controllers/recalculoAtrasoController');

// histórico precisa vir antes de '/:id'
router.get('/historico', emprestimosController.listarHistorico);
router.post(
  '/:id/recalcular-atraso/preview',
  recalculoAtrasoController.preview
);
router.post(
  '/:id/recalcular-atraso/aplicar',
  recalculoAtrasoController.aplicar
);

// CRUD
router.get('/', emprestimosController.listarTodos);
router.post('/reset-all', exigirProtecao('excluir_todos_emprestimos'), emprestimosController.excluirTodos);
router.get('/:id', emprestimosController.buscarPorId);
router.get('/:id/pagamentos', emprestimosController.listarPagamentosPorEmprestimo);
router.post('/', emprestimosController.criar);
router.put('/:id', exigirProtecao('editar_emprestimo'), emprestimosController.atualizar);
router.delete('/:id', exigirProtecao('excluir_emprestimo'), emprestimosController.excluir);

// renegociação in-place + histórico
router.post('/:id/renegociar-inplace', renegociacaoController.renegociarInplace);
router.post('/:id/adicionar-capital', renegociacaoController.adicionarCapital);
router.get('/:id/versoes', renegociacaoController.listarVersoesHistorico);
router.get('/:id/versoes/:versao', renegociacaoController.obterVersaoHistorico);

module.exports = router;
