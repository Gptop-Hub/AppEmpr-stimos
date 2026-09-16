const express = require('express');
const { getSegurancaService } = require('../services/segurancaService');
const { jurosExigemProtecao } = require('../middleware/protecao');

function criarSegurancaRouter(service = getSegurancaService(), verificarJuros = jurosExigemProtecao) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const endpoint = fn => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (err) { res.status(err.status || 503).json({ error: err.status ? err.message : 'Não foi possível acessar a segurança.' }); }
  };
  router.get('/protecoes', endpoint(() => service.listar()));
  router.get('/protecoes/:chave', endpoint(async req => {
    const estado = await service.estado(req.params.chave);
    let exigida = estado.ativo;
    if (req.params.chave === 'adicionar_juros_parcela' && req.query.parcelaId != null) {
      const id = Number(req.query.parcelaId);
      if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('Parcela inválida.'), { status: 400 });
      exigida = await verificarJuros(id) && estado.ativo;
    }
    return { ...estado, exigida };
  }));
  router.post('/protecoes/:chave/validar', endpoint(req => service.validarSenhaProtecao(req.params.chave, req.body?.senha)));
  router.put('/protecoes/:chave/senha', endpoint(req => service.definirSenha(req.params.chave, req.body)));
  router.put('/protecoes/:chave/estado', endpoint(req => service.alterarEstado(req.params.chave, req.body)));
  return router;
}
module.exports = { criarSegurancaRouter };
