// backend/controllers/emprestimosController.js
const emprestimoService = require('../services/servicoemprestimo');
const gerarParcelas = require('../utils/gerarParcelas'); // usado no preview
const db = require('../models/database'); // sqlite handle
const { toISO, parseToDate } = require('../services/dateUtils');
const { getPagamentosPorEmprestimo } = require('../services/parcelasService');
const { touchAtividade } = require('../utils/touchAtividade');
const { registrarSaidaEmprestimo } = require('../services/caixaService');
const { runAsync, getAsync } = require('../utils/sqliteAsync');
const { ensureActionContractReady } = require('../services/actionIdentityService');
const { ensureEntityIdentityV1 } = require('../services/entityIdentityService');
const { capturarEstadoEmprestimo, registrarAcaoEmprestimo } = require('../services/emprestimoActionService');
const { ACTION_TYPES } = require('../services/actionTypeContract');

/**
 * Helpers locais de parsing
 */
function toNumberSafe(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  const s = String(v).trim();
  if (s === '') return null;
  let t = s;
  if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
  else if (t.includes(',') && !t.includes('.')) t = t.replace(',', '.');
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

async function tableExists(tableName) {
  const row = await getAsync(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName]
  );
  return !!row;
}

async function deleteIfTableExists(tableName, whereClause = '', params = []) {
  const exists = await tableExists(tableName);
  if (!exists) return 0;

  const sql = whereClause
    ? `DELETE FROM ${tableName} WHERE ${whereClause}`
    : `DELETE FROM ${tableName}`;
  const result = await runAsync(db, sql, params);
  return Number(result?.changes || 0);
}

/**
 * GET /emprestimos
 */
exports.listarTodos = async (req, res) => {
  try {
    // MantÃƒÂ©m comportamento atual (sem filtrar ativo). Podemos ajustar depois, se quiser.
    const emprestimos = await emprestimoService.listarTodosEmprestimos();
    res.json(emprestimos);
  } catch (error) {
    console.error('listarTodos erro:', error);
    res.status(500).json({ error: error.message || 'Erro ao buscar emprÃƒÂ©stimos.' });
  }
};

/**
 * GET /emprestimos/historico
 */
exports.listarHistorico = async (req, res) => {
  try {
    if (typeof emprestimoService.listarEmprestimosQuitados !== 'function') {
      console.error('listarHistorico: serviÃƒÂ§o listarEmprestimosQuitados nÃƒÂ£o encontrado.');
      return res.status(500).json({ error: 'ServiÃƒÂ§o de histÃƒÂ³rico nÃƒÂ£o disponÃƒÂ­vel.' });
    }
    const quitados = await emprestimoService.listarEmprestimosQuitados();
    res.json(quitados);
  } catch (error) {
    console.error('listarHistorico erro:', error);
    res.status(500).json({ error: error.message || 'Erro ao listar histÃƒÂ³rico.' });
  }
};

/**
 * GET /emprestimos/:id
 */
exports.buscarPorId = async (req, res) => {
  try {
    const emprestimo = await emprestimoService.buscarEmprestimoPorId(req.params.id);
    if (!emprestimo) return res.status(404).json({ error: 'EmprÃƒÂ©stimo nÃƒÂ£o encontrado.' });
    res.json(emprestimo);
  } catch (error) {
    console.error('buscarPorId erro:', error);
    res.status(500).json({ error: error.message || 'Erro ao buscar emprÃƒÂ©stimo.' });
  }
};

/**
 * PUT /emprestimos/:id
 */
exports.atualizar = async (req, res) => {
  try {
    await ensureActionContractReady(db);
    const emprestimoId = Number(req.params.id);
    await ensureEntityIdentityV1(db);
    await runAsync(db, 'BEGIN IMMEDIATE TRANSACTION');
    const antes = await capturarEstadoEmprestimo(emprestimoId, { dbHandle: db });
    if (!antes.emprestimo) {
      await runAsync(db, 'ROLLBACK');
      return res.status(404).json({ error: 'Empréstimo não encontrado.' });
    }
    const resultado = await emprestimoService.atualizarEmprestimo(req.params.id, req.body);
    await touchAtividade({ emprestimoId, clienteId: req.body && req.body.cliente_id ? req.body.cliente_id : null });
    const depois = await capturarEstadoEmprestimo(emprestimoId, { dbHandle: db });
    await registrarAcaoEmprestimo({
      tipo: 'EMPRESTIMO_EDITADO', origem: 'interface', emprestimoId,
      clienteId: Number(depois.emprestimo.cliente_id), antes, depois,
      parametros: { campos_confirmados: Object.keys(req.body || {}).sort() },
      resumo: `Empréstimo ${emprestimoId} editado`,
    }, { dbHandle: db });
    await runAsync(db, 'COMMIT');
    res.json(resultado);
  } catch (error) {
    await runAsync(db, 'ROLLBACK').catch(() => {});
    console.error('atualizar erro:', error);
    const msg = error && error.message ? String(error.message) : '';
    if (
      msg === 'Campos obrigatorios ausentes.' ||
      msg === 'Campos obrigatÃ³rios ausentes.' ||
      msg === 'Campos obrigatÃƒÂ³rios ausentes.' ||
      msg === 'ID de emprestimo invalido.'
    ) {
      return res.status(400).json({ error: msg });
    }
    if (error && error.code === 'LOAN_EDIT_BLOCKED_AFTER_PAYMENT') {
      return res.status(409).json({
        error: 'Este emprestimo nao pode ser editado porque ja possui parcela paga.',
      });
    }
    res.status(500).json({ error: 'Erro ao atualizar emprÃƒÂ©stimo.' });
  }
};

/**
 * POST /emprestimos
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

    console.log('Criando emprÃƒÂ©stimo - payload recebido:', req.body);

    const cliente_id = toIntegerSafe(rawClienteId);
    const valor = toNumberSafe(rawValor);
    const taxa_juros = toNumberSafe(rawTaxa);
    const parcelas = rawParcelas == null ? null : toIntegerSafe(rawParcelas);
    const data = toISO(rawData);

    if (!cliente_id) return res.status(400).json({ error: 'cliente_id invÃƒÂ¡lido ou ausente.' });
    if (valor == null || valor <= 0) return res.status(400).json({ error: 'valor invÃƒÂ¡lido ou ausente.' });
    if (!data || !isValidDateString(data)) {
      return res.status(400).json({ error: 'data (inÃƒÂ­cio) invÃƒÂ¡lida ou ausente. Use YYYY-MM-DD.' });
    }
    if (!modalidade) return res.status(400).json({ error: 'modalidade ausente.' });
    if (taxa_juros == null) return res.status(400).json({ error: 'taxa_juros ausente.' });
    if (modalidade === 'parcelado' && (parcelas == null || parcelas <= 0)) {
      return res.status(400).json({ error: 'parcelas ausente ou invÃƒÂ¡lida para modalidade parcelado.' });
    }

    // Determinar dia_pagamento / primeira data de pagamento
    let diaToSave = null;
    let primeiraDataPagamento = null;

    if (rawDataPagamento && typeof rawDataPagamento === 'string' && isValidDateString(rawDataPagamento)) {
      const dataPagISO = toISO(rawDataPagamento);
      if (dataPagISO) {
        primeiraDataPagamento = dataPagISO;
        const dtPag = parseToDate(dataPagISO);
        diaToSave = dtPag ? dtPag.getDate() : null;
      }
    } else if (rawDiaPagamento != null && rawDiaPagamento !== '') {
      const parsed = toIntegerSafe(rawDiaPagamento);
      if (parsed != null) diaToSave = Math.min(31, Math.max(1, parsed));
    }

    if (diaToSave == null) {
      const dt = parseToDate(data);
      diaToSave = dt ? dt.getDate() : 15;
    }

    // Ã°Å¸â€˜â€¡ AQUI entra a separaÃƒÂ§ÃƒÂ£o: valor_emprestado e valor_atual comeÃƒÂ§am iguais ao valor informado
    const dadosParaCriar = {
      cliente_id,
      valor,
      data,
      modalidade,
      parcelas,
      taxa_juros,
      observacao: observacao || '',
      dia_pagamento: Number(diaToSave),
      data_pagamento: primeiraDataPagamento || null,
      valor_emprestado: valor, // novo campo sem quebrar o legado
      valor_atual: valor       // capital atual inicial = valor emprestado
    };

    console.log('Chamando servico.criarEmprestimo com:', dadosParaCriar);
    await ensureActionContractReady(db);
    await runAsync(db, 'BEGIN IMMEDIATE TRANSACTION');
    const resultado = await emprestimoService.criarEmprestimo(dadosParaCriar);
    console.log('EmprÃƒÂ©stimo criado:', resultado);
    const emprestimoId = Number(resultado.id);
    await touchAtividade({ emprestimoId, clienteId: cliente_id });
    await registrarSaidaEmprestimo({
      data,
      cliente_id,
      emprestimo_id: emprestimoId,
      valor_emprestimo: valor,
      descricao: 'Emprestimo concedido',
      meta: {
        origem: '/emprestimos',
        data_contrato: data || null,
        modalidade: modalidade || null,
        parcelas: parcelas != null ? Number(parcelas) : null,
        taxa_juros: taxa_juros != null ? Number(taxa_juros) : null,
      },
    }, db);
    const depois = await capturarEstadoEmprestimo(emprestimoId, { dbHandle: db });
    await registrarAcaoEmprestimo({
      tipo: 'EMPRESTIMO_CRIADO', origem: 'interface', emprestimoId, clienteId: cliente_id,
      antes: { emprestimo: null, cliente: depois.cliente, parcelas: [], parcelas_originais: [], pagamentos: [], caixa_movimentos: [], renegociacoes_historico: [] },
      depois,
      parametros: { valor, taxa_juros, modalidade, data, dia_pagamento: diaToSave, primeiro_vencimento: primeiraDataPagamento, parcelas },
      resumo: `Empréstimo ${emprestimoId} criado`,
    }, { dbHandle: db });
    await runAsync(db, 'COMMIT');
    res.json(resultado);
  } catch (error) {
    await runAsync(db, 'ROLLBACK').catch(() => {});
    console.error('criar erro:', error);
    if (error.message === 'Campos obrigatÃƒÂ³rios ausentes.') {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message || 'Erro ao criar emprÃƒÂ©stimo.' });
  }
};

/**
 * PATCH/PUT /parcelas/:id (vencimento)
 */
exports.atualizarParcelaVencimento = async (req, res) => {
  try {
    console.log('Recebendo requisiÃƒÂ§ÃƒÂ£o para atualizar vencimento - id:', req.params.id, 'body:', req.body);
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
 * POST /emprestimos/preview
 */
exports.previewParcelas = (req, res) => {
  try {
    const {
      valor: rawValor,
      taxa_juros: rawTaxa,
      parcelas: rawParcelas,
      data: rawData,
      data_pagamento: rawDataPagamento,
      dia_pagamento: rawDiaPagamento
    } = req.body;

    const valor = toNumberSafe(rawValor);
    const taxa_juros = toNumberSafe(rawTaxa);
    const qtdParcelas = toIntegerSafe(rawParcelas);
    const dataInicio = rawData && isValidDateString(rawData)
      ? toISO(rawData)
      : toISO(new Date());

    if (valor == null || taxa_juros == null || qtdParcelas == null) {
      return res.status(400).json({ error: 'ParÃƒÂ¢metros invÃƒÂ¡lidos. ForneÃƒÂ§a valor, taxa_juros e parcelas.' });
    }

    let primeiroVencimento = null;
    let diaPagamento = undefined;

    if (rawDataPagamento && typeof rawDataPagamento === 'string' && isValidDateString(rawDataPagamento)) {
      const dataPagISO = toISO(rawDataPagamento);
      if (dataPagISO) {
        primeiroVencimento = dataPagISO;
        const dtPag = parseToDate(dataPagISO);
        diaPagamento = dtPag ? dtPag.getDate() : undefined;
      }
    } else if (rawDiaPagamento != null && rawDiaPagamento !== '') {
      const parsed = toIntegerSafe(rawDiaPagamento);
      if (parsed != null) diaPagamento = parsed;
    }

    const geradas = gerarParcelas({
      capital: Number(valor),
      taxa_juros: Number(taxa_juros),
      qtdParcelas: Number(qtdParcelas),
      dataInicio: dataInicio,
      diaPagamento,
      primeiroVencimento
    });

    return res.json({ parcelas: geradas });
  } catch (error) {
    console.error('previewParcelas erro:', error);
    res.status(500).json({ error: 'Erro ao gerar preview de parcelas.' });
  }
};

/**
 * DELETE /emprestimos/:id (com senha)
 */
exports.excluir = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inv\u00E1lido.' });

    await ensureEntityIdentityV1(db);
    await ensureActionContractReady(db);
    await runAsync(db, 'BEGIN IMMEDIATE TRANSACTION');
    const antes = await capturarEstadoEmprestimo(id, { dbHandle: db });

    const removidos = {};
    removidos.notificacoes = await deleteIfTableExists(
      'notificacoes',
      'emprestimo_id = ?',
      [id]
    );
    removidos.caixa_movimentos = await deleteIfTableExists(
      'caixa_movimentos',
      'emprestimo_id = ?',
      [id]
    );
    removidos.recalculos_atraso = await deleteIfTableExists(
      'recalculos_atraso',
      'emprestimo_id = ?',
      [id]
    );
    removidos.renegociacoes_historico = await deleteIfTableExists(
      'renegociacoes_historico',
      'emprestimo_id = ?',
      [id]
    );
    removidos.renegociacoes = await deleteIfTableExists(
      'renegociacoes',
      'antigo_id = ? OR novo_id = ?',
      [id, id]
    );
    removidos.pagamentos = await deleteIfTableExists(
      'pagamentos',
      'emprestimo_id = ?',
      [id]
    );
    removidos.parcelas_originais = await deleteIfTableExists(
      'parcelas_originais',
      'emprestimo_id = ?',
      [id]
    );
    removidos.parcelas = await deleteIfTableExists(
      'parcelas',
      'emprestimo_id = ?',
      [id]
    );

    await runAsync(db, 'DELETE FROM emprestimos WHERE id = ?', [id]);
    if (antes.emprestimo) {
      const depois = Object.fromEntries(Object.keys(antes).map((key) => [
        key,
        key === 'cliente' ? antes.cliente : (key === 'emprestimo' ? null : []),
      ]));
      await registrarAcaoEmprestimo({
        tipo: ACTION_TYPES.EMPRESTIMO_EXCLUIDO,
        origem: 'interface',
        emprestimoId: id,
        clienteId: antes.emprestimo.cliente_id == null ? null : Number(antes.emprestimo.cliente_id),
        antes,
        depois,
        parametros: { removidos },
        resumo: `Empréstimo ${id} excluído`,
      }, { dbHandle: db });
    }
    await runAsync(db, 'COMMIT');
    return res.json({ mensagem: 'Empr\u00E9stimo exclu\u00EDdo com sucesso.', id, removidos });
  } catch (error) {
    try {
      await runAsync(db, 'ROLLBACK');
    } catch {}
    console.error('excluir erro:', error);
    res.status(500).json({ error: 'Erro ao excluir empr\u00E9stimo.' });
  }
};

/**
 * POST /emprestimos/reset-all (com senha)
 * Remove TODO o conteÃºdo relacionado a emprÃ©stimos e mantÃ©m clientes intactos.
 */
exports.excluirTodos = async (req, res) => {
  try {
    await runAsync(db, 'BEGIN IMMEDIATE TRANSACTION');
    const removidos = {};

    // DependÃªncias e histÃ³ricos ligados a emprÃ©stimos
    removidos.notificacoes = await deleteIfTableExists(
      'notificacoes',
      "emprestimo_id IS NOT NULL OR parcela_id IS NOT NULL"
    );
    removidos.caixa_movimentos = await deleteIfTableExists(
      'caixa_movimentos',
      "emprestimo_id IS NOT NULL OR UPPER(COALESCE(categoria, '')) IN ('EMPRESTIMO', 'PAGAMENTO')"
    );
    removidos.pagamentos = await deleteIfTableExists('pagamentos');
    removidos.parcelas_originais = await deleteIfTableExists('parcelas_originais');
    removidos.parcelas = await deleteIfTableExists('parcelas');
    removidos.renegociacoes_historico = await deleteIfTableExists('renegociacoes_historico');
    removidos.renegociacoes = await deleteIfTableExists('renegociacoes');
    removidos.emprestimos = await deleteIfTableExists('emprestimos');

    await runAsync(db, 'COMMIT');
    return res.json({
      mensagem: 'Todos os emprestimos e dados relacionados foram excluidos.',
      removidos,
    });
  } catch (error) {
    try {
      await runAsync(db, 'ROLLBACK');
    } catch {}
    console.error('excluirTodos erro:', error);
    return res.status(500).json({
      error: error && error.message ? error.message : 'Erro ao excluir todos os emprestimos.',
    });
  }
};

/**
 * GET /emprestimos/:id/pagamentos
 */
exports.listarPagamentosPorEmprestimo = async (req, res) => {
  const emprestimoId = Number(req.params.id);
  if (!emprestimoId) {
    return res.status(400).json({ success: false, error: 'ID invÃƒÂ¡lido' });
  }

  try {
    const { pagamentos, total_pago } = await getPagamentosPorEmprestimo(emprestimoId);
    return res.json({
      success: true,
      emprestimoId,
      total_pago,
      pagamentos: pagamentos || [],
    });
  } catch (error) {
    console.error('listarPagamentosPorEmprestimo erro:', error);
    res.status(500).json({ success: false, error: error.message || 'Erro ao listar pagamentos.' });
  }
};


