// backend/controllers/emprestimosController.js
const emprestimoService = require('../services/servicoemprestimo');
const gerarParcelas = require('../utils/gerarParcelas'); // para endpoint de preview (opcional)
const db = require('../models/database'); // adicionado para exclusão direta

/**
 * Helpers locais de parsing (mantive as funções existentes)
 */
function toNumberSafe(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  const s = String(v).trim();
  if (s === '') return null;
  let t = s;
  if (t.indexOf(',') > -1 && t.indexOf('.') > -1) {
    t = t.replace(/\./g, '').replace(',', '.');
  } else if (t.indexOf(',') > -1 && t.indexOf('.') === -1) {
    t = t.replace(',', '.');
  }
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

function toIntegerSafe(v) {
  const n = toNumberSafe(v);
  if (n === null) return null;
  const i = Math.trunc(n);
  return Number.isFinite(i) ? i : null;
}

function isValidDateString(s) {
  if (!s) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

/**
 * listarTodos
 */
exports.listarTodos = async (req, res) => {
  try {
    const emprestimos = await emprestimoService.listarTodosEmprestimos();
    res.json(emprestimos);
  } catch (error) {
    console.error('listarTodos erro:', error);
    res.status(500).json({ error: error.message || 'Erro ao buscar empréstimos.' });
  }
};

/**
 * listarHistorico
 * Retorna empréstimos quitados (usa a função do service listarEmprestimosQuitados).
 */
exports.listarHistorico = async (req, res) => {
  try {
    // chama a função do service que já deve retornar apenas quitados
    if (typeof emprestimoService.listarEmprestimosQuitados !== 'function') {
      console.error('listarHistorico: serviço listarEmprestimosQuitados não encontrado.');
      return res.status(500).json({ error: 'Serviço de histórico não disponível.' });
    }

    const quitados = await emprestimoService.listarEmprestimosQuitados();
    res.json(quitados);
  } catch (error) {
    console.error('listarHistorico erro:', error);
    res.status(500).json({ error: error.message || 'Erro ao listar histórico.' });
  }
};

/**
 * buscarPorId
 */
exports.buscarPorId = async (req, res) => {
  try {
    const emprestimo = await emprestimoService.buscarEmprestimoPorId(req.params.id);
    if (!emprestimo) return res.status(404).json({ error: 'Empréstimo não encontrado.' });
    res.json(emprestimo);
  } catch (error) {
    console.error('buscarPorId erro:', error);
    res.status(500).json({ error: error.message || 'Erro ao buscar empréstimo.' });
  }
};

/**
 * atualizar
 */
exports.atualizar = async (req, res) => {
  try {
    const resultado = await emprestimoService.atualizarEmprestimo(req.params.id, req.body);
    res.json(resultado);
  } catch (error) {
    console.error('atualizar erro:', error);
    if (error.message === 'Campos obrigatórios ausentes.') return res.status(400).json({ error: error.message });
    res.status(500).json({ error: 'Erro ao atualizar empréstimo.' });
  }
};

/**
 * criar
 */
exports.criar = async (req, res) => {
  try {
    const {
      cliente_id: rawClienteId,
      valor: rawValor,
      data: rawData,
      modalidade,
      parcelas: rawParcelas,
      taxa_juros: rawTaxa,
      observacao,
      dia_pagamento: rawDiaPagamento,
      data_pagamento: rawDataPagamento,
    } = req.body;

    console.log('Criando empréstimo - payload recebido:', req.body);

    const cliente_id = toIntegerSafe(rawClienteId);
    const valor = toNumberSafe(rawValor);
    const taxa_juros = toNumberSafe(rawTaxa);
    const parcelas = rawParcelas == null ? null : toIntegerSafe(rawParcelas);
    const data = (typeof rawData === 'string') ? rawData : (rawData instanceof Date ? rawData.toISOString().split('T')[0] : null);

    if (!cliente_id) return res.status(400).json({ error: 'cliente_id inválido ou ausente.' });
    if (valor == null || valor <= 0) return res.status(400).json({ error: 'valor inválido ou ausente.' });
    if (!data || !isValidDateString(data)) return res.status(400).json({ error: 'data (data de início) inválida ou ausente. Use ISO YYYY-MM-DD.' });
    if (!modalidade) return res.status(400).json({ error: 'modalidade ausente.' });
    if (taxa_juros == null) return res.status(400).json({ error: 'taxa_juros ausente.' });

    if (modalidade === 'parcelado' && (parcelas == null || parcelas <= 0)) {
      return res.status(400).json({ error: 'parcelas ausente ou inválida para modalidade parcelado.' });
    }

    let diaToSave = null;
    if (rawDataPagamento && typeof rawDataPagamento === 'string' && isValidDateString(rawDataPagamento)) {
      diaToSave = new Date(rawDataPagamento).getDate();
    } else if (rawDiaPagamento != null && rawDiaPagamento !== '') {
      const parsed = toIntegerSafe(rawDiaPagamento);
      if (parsed != null) {
        diaToSave = Math.min(31, Math.max(1, parsed));
      }
    }

    if (diaToSave == null) {
      const dt = new Date(data);
      if (!Number.isNaN(dt.getTime())) {
        diaToSave = dt.getDate();
      } else {
        diaToSave = 15;
      }
    }

    const dadosParaCriar = {
      cliente_id,
      valor,
      data,
      modalidade,
      parcelas: parcelas,
      taxa_juros,
      observacao: observacao || '',
      dia_pagamento: Number(diaToSave)
    };

    console.log('Chamando servico.criarEmprestimo com:', dadosParaCriar);

    const resultado = await emprestimoService.criarEmprestimo(dadosParaCriar);

    console.log('Empréstimo criado:', resultado);
    res.json(resultado);
  } catch (error) {
    console.error('criar erro:', error);
    if (error.message === 'Campos obrigatórios ausentes.') return res.status(400).json({ error: error.message });
    res.status(500).json({ error: error.message || 'Erro ao criar empréstimo.' });
  }
};

/**
 * atualizarParcelaVencimento
 */
exports.atualizarParcelaVencimento = async (req, res) => {
  try {
    console.log('Recebendo requisição para atualizar vencimento - id:', req.params.id, 'body:', req.body);
    const resultado = await emprestimoService.atualizarParcelaVencimento(
      req.params.id,
      req.body.vencimento
    );
    console.log('Resultado atualizarParcelaVencimento:', resultado);
    res.json(resultado);
  } catch (error) {
    console.error('atualizarParcelaVencimento erro:', error);
    res.status(500).json({ error: error.message || 'Erro ao atualizar parcela.' });
  }
};

/**
 * previewParcelas (opcional)
 */
exports.previewParcelas = (req, res) => {
  try {
    const { valor: rawValor, taxa_juros: rawTaxa, parcelas: rawParcelas, data: rawData, data_pagamento: rawDataPagamento, dia_pagamento: rawDiaPagamento } = req.body;

    const valor = toNumberSafe(rawValor);
    const taxa_juros = toNumberSafe(rawTaxa);
    const qtdParcelas = toIntegerSafe(rawParcelas);
    const dataInicio = rawData && isValidDateString(rawData) ? rawData : (new Date()).toISOString().split('T')[0];

    if (valor == null || taxa_juros == null || qtdParcelas == null) {
      return res.status(400).json({ error: 'Parâmetros inválidos. Forneça valor, taxa_juros e parcelas.' });
    }

    let diaPagamento = undefined;
    if (rawDataPagamento && typeof rawDataPagamento === 'string' && isValidDateString(rawDataPagamento)) {
      diaPagamento = rawDataPagamento;
    } else if (rawDiaPagamento != null && rawDiaPagamento !== '') {
      const parsed = toIntegerSafe(rawDiaPagamento);
      if (parsed != null) diaPagamento = parsed;
    }

    const geradas = gerarParcelas({
      capital: Number(valor),
      taxa_juros: Number(taxa_juros),
      qtdParcelas: Number(qtdParcelas),
      dataInicio: dataInicio,
      diaPagamento: diaPagamento
    });

    return res.json({ parcelas: geradas });
  } catch (error) {
    console.error('previewParcelas erro:', error);
    res.status(500).json({ error: 'Erro ao gerar preview de parcelas.' });
  }
};

/**
 * excluir empréstimo (nova função)
 * Recebe senha no body: { password: '...' }
 */
exports.excluir = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    const provided = (req.body && req.body.password) ? String(req.body.password) : '';
    const expected = process.env.ADMIN_PASSWORD || 'admin123';

    if (provided !== expected) {
      return res.status(401).json({ error: 'Senha incorreta.' });
    }

    // exclusão em transação: pagamentos, parcelas, parcelas_originais, emprestimos
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run('DELETE FROM pagamentos WHERE emprestimo_id = ?', [id], (err) => {
        if (err) {
          console.error('Erro ao deletar pagamentos:', err);
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'Erro ao excluir (pagamentos).' });
        }

        db.run('DELETE FROM parcelas WHERE emprestimo_id = ?', [id], (err2) => {
          if (err2) {
            console.error('Erro ao deletar parcelas:', err2);
            db.run('ROLLBACK');
            return res.status(500).json({ error: 'Erro ao excluir (parcelas).' });
          }

          db.run('DELETE FROM parcelas_originais WHERE emprestimo_id = ?', [id], (err3) => {
            if (err3) {
              console.error('Erro ao deletar parcelas_originais:', err3);
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Erro ao excluir (parcelas_originais).' });
            }

            db.run('DELETE FROM emprestimos WHERE id = ?', [id], function (err4) {
              if (err4) {
                console.error('Erro ao deletar emprestimo:', err4);
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'Erro ao excluir empréstimo.' });
              }

              db.run('COMMIT', (cErr) => {
                if (cErr) {
                  console.error('Erro no COMMIT:', cErr);
                  return res.status(500).json({ error: 'Erro ao finalizar exclusão.' });
                }
                return res.json({ mensagem: 'Empréstimo excluído com sucesso.', id });
              });
            });
          });
        });
      });
    });
  } catch (error) {
    console.error('excluir erro:', error);
    res.status(500).json({ error: 'Erro ao excluir empréstimo.' });
  }
};