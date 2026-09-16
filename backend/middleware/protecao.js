const { getSegurancaService } = require('../services/segurancaService');

function exigirProtecao(chave, { service, aplicavel } = {}) {
  return async (req, res, next) => {
    try {
      if (!aplicavel || await aplicavel(req)) {
        await (service || getSegurancaService()).autorizar(chave, req.get('X-Protecao-Token'), req.body?.password);
      }
      // Não deixar credenciais legadas chegar aos logs ou à persistência dos controladores.
      if (req.body && Object.hasOwn(req.body, 'password')) delete req.body.password;
      next();
    } catch (error) {
      res.status(error.status || 503).json({ success: false, error: error.status ? error.message : 'Segurança indisponível. Operação bloqueada.' });
    }
  };
}

// Replica apenas a seleção da parcela atual da interface; não altera cálculos nem pagamentos.
async function jurosExigemProtecao(parcelaId, database = require('../models/database')) {
  const get = (sql, params) => new Promise((resolve, reject) => database.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
  const parcela = await get('SELECT id, emprestimo_id FROM parcelas WHERE id=?', [parcelaId]);
  if (!parcela) throw Object.assign(new Error('Parcela não encontrada.'), { status: 404 });
  const atual = await get(`SELECT p.id FROM parcelas p JOIN emprestimos e ON e.id=p.emprestimo_id
    WHERE p.emprestimo_id=? AND (p.versao IS NULL OR p.versao=e.versao_atual)
    AND p.numero != -1 AND COALESCE(p.pago,0)=0
    AND COALESCE(p.valor_pago,0)<=0 ORDER BY p.numero, p.id LIMIT 1`, [parcela.emprestimo_id]);
  return !atual || Number(atual.id) !== Number(parcela.id);
}
module.exports = { exigirProtecao, jurosExigemProtecao };
