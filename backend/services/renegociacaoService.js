const crypto = require('crypto');
const gerarParcelas = require('../utils/gerarParcelas');
const { runAsync, getAsync, allAsync } = require('../utils/sqliteAsync');
const { calcularCapitalRestanteComRegra, toNumberSafe } = require('./servicoemprestimo/core');
const { claimActionExecution } = require('./assistente/actions/actionIdempotency');

function actionError(code, message) { const error = new Error(message); error.code = code; return error; }
function money(value) { const number = Number(value); return Number.isFinite(number) ? Number(number.toFixed(2)) : null; }
function positiveId(value) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : null; }
function positiveInteger(value) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : null; }
function rate(value) { if (value == null || String(value).trim() === '') return null; const number = Number(value); return Number.isFinite(number) && number >= 0 ? money(number) : null; }
function positiveMoney(value) { const number = money(value); return number != null && number > 0 ? number : null; }
function isoDate(value) {
  const text = String(value || '').trim();
  const parsed = new Date(`${text}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
}

function normalizeTerms(input = {}, { strictAction = false } = {}) {
  const allowed = strictAction
    ? new Set(['action', 'cliente_id', 'emprestimo_id', 'valor', 'parcelas', 'taxa_juros', 'data', 'data_pagamento'])
    : new Set(['cliente_id', 'emprestimo_id', 'valor', 'parcelas', 'taxa_juros', 'data', 'data_pagamento', 'observacao', 'pagamento_id']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    throw actionError('invalid_action_contract', 'A renegociação contém campos não permitidos.');
  }
  const result = {
    cliente_id: positiveId(input.cliente_id),
    emprestimo_id: positiveId(input.emprestimo_id),
    valor: positiveMoney(input.valor),
    parcelas: positiveInteger(input.parcelas),
    taxa_juros: rate(input.taxa_juros),
    data: isoDate(input.data),
    data_pagamento: isoDate(input.data_pagamento),
    observacao: strictAction ? '' : String(input.observacao || '').trim(),
    pagamento_id: strictAction || input.pagamento_id == null || input.pagamento_id === '' ? null : positiveId(input.pagamento_id),
  };
  if (!result.emprestimo_id || (strictAction && !result.cliente_id)) throw actionError('entity_required', 'Cliente e empréstimo devem ser informados por ID exato.');
  if (result.valor == null) throw actionError('invalid_amount', 'O novo valor deve ser maior que zero.');
  if (!result.parcelas) throw actionError('invalid_installments', 'A quantidade de parcelas deve ser maior que zero.');
  if (result.taxa_juros == null) throw actionError('invalid_rate', 'A taxa de juros deve ser igual ou maior que zero.');
  if (strictAction && (!result.data || !result.data_pagamento)) throw actionError('invalid_date', 'As datas devem estar no formato YYYY-MM-DD.');
  return result;
}

async function ensureHistoricoTable(dbHandle) {
  await runAsync(dbHandle, `CREATE TABLE IF NOT EXISTS renegociacoes_historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER NOT NULL, versao INTEGER NOT NULL,
    snapshot_emprestimo TEXT NOT NULL, snapshot_parcelas TEXT NOT NULL, tipo TEXT, observacao TEXT,
    detalhes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await runAsync(dbHandle, 'CREATE INDEX IF NOT EXISTS idx_hist_emprestimo_id ON renegociacoes_historico(emprestimo_id)');
}

async function loadState(terms, dbHandle) {
  const emprestimo = await getAsync(dbHandle, 'SELECT * FROM emprestimos WHERE id = ?', [terms.emprestimo_id]);
  if (!emprestimo) throw actionError('loan_not_found', 'Empréstimo não encontrado.');
  if (terms.cliente_id && Number(emprestimo.cliente_id) !== terms.cliente_id) throw actionError('loan_client_mismatch', 'O empréstimo não pertence ao cliente informado.');
  const cliente = await getAsync(dbHandle, 'SELECT id, nome FROM clientes WHERE id = ?', [emprestimo.cliente_id]);
  if (!cliente) throw actionError('client_not_found', 'Cliente não encontrado.');
  if (Number(emprestimo.ativo) === 0) throw actionError('loan_inactive', 'O empréstimo não está ativo.');
  if (!terms.data) terms.data = isoDate(emprestimo.data);
  if (!terms.data_pagamento) terms.data_pagamento = terms.data;
  if (!terms.data || !terms.data_pagamento) throw actionError('invalid_date', 'As datas devem estar no formato YYYY-MM-DD.');
  const versaoAtual = Number(emprestimo.versao_atual || 1);
  const parcelas = await allAsync(dbHandle, `SELECT * FROM parcelas
    WHERE emprestimo_id = ? AND (versao IS NULL OR versao = ?) ORDER BY numero ASC, id ASC`, [terms.emprestimo_id, versaoAtual]);
  if (!parcelas.length) throw actionError('schedule_not_found', 'Não há cronograma vigente para renegociar.');
  const pagamentos = await allAsync(dbHandle, `SELECT id, valor, data, tipo_pagamento, parcela_origem, renegociacao_id
    FROM pagamentos WHERE emprestimo_id = ? ORDER BY id ASC`, [terms.emprestimo_id]);
  const recalculos = await allAsync(dbHandle, 'SELECT * FROM recalculos_atraso WHERE emprestimo_id = ? ORDER BY id ASC', [terms.emprestimo_id]).catch(() => []);
  const novasParcelas = gerarParcelas({
    capital: terms.valor, taxa_juros: terms.taxa_juros, qtdParcelas: terms.parcelas,
    dataInicio: terms.data, primeiroVencimento: terms.data_pagamento, diaPagamento: undefined,
  }).map((parcela, index) => ({
    numero: Number(parcela.numero || index + 1), valor_total: money(parcela.valor_total),
    valor_capital: money(parcela.valor_capital), valor_juros: money(parcela.valor_juros),
    vencimento: parcela.vencimento_iso || parcela.vencimento || null, pago: 0, valor_pago: 0,
    valor_excedente: 0, juros_adicionais: 0, juros_pendentes: 0, versao: versaoAtual + 1,
  }));
  const capitalAnterior = money(calcularCapitalRestanteComRegra(emprestimo, parcelas));
  const totalPrevisto = money(novasParcelas.reduce((sum, parcela) => sum + Number(parcela.valor_total || 0), 0));
  const jurosPrevistos = money(novasParcelas.reduce((sum, parcela) => sum + Number(parcela.valor_juros || 0), 0));
  return { cliente, emprestimo, parcelas, pagamentos, recalculos, versaoAtual, novaVersao: versaoAtual + 1, novasParcelas, capitalAnterior, totalPrevisto, jurosPrevistos };
}

function stateFingerprint(state, terms) {
  const loanFields = ['id', 'cliente_id', 'versao_atual', 'valor', 'valor_atual', 'capital_restante', 'taxa_juros', 'parcelas', 'data', 'dia_pagamento', 'ativo', 'updated_at'];
  const parcelaFields = ['id', 'numero', 'valor_total', 'valor_capital', 'valor_juros', 'juros_pendentes', 'juros_adicionais', 'valor_pago', 'valor_excedente', 'pago', 'vencimento', 'versao', 'data_pagamento'];
  return crypto.createHash('sha256').update(JSON.stringify({
    terms,
    emprestimo: loanFields.map((field) => state.emprestimo[field] ?? null),
    parcelas: state.parcelas.map((parcela) => parcelaFields.map((field) => parcela[field] ?? null)),
    pagamentos: state.pagamentos,
    recalculos: state.recalculos,
    novasParcelas: state.novasParcelas,
  })).digest('hex');
}

function snapshotFor(state, terms) {
  return {
    ...state.emprestimo,
    capital_restante: state.capitalAnterior,
    total_pago: money(state.pagamentos.reduce((sum, pagamento) => sum + Number(pagamento.valor || 0), 0)),
    renegociacao_tipo: 'renegociacao_manual',
    renegociacao_observacao: terms.observacao || '',
    renegociacao_detalhes: { versao_anterior: state.versaoAtual, versao_nova: state.novaVersao, valor: terms.valor, parcelas: terms.parcelas, taxa_juros: terms.taxa_juros, data: terms.data, data_pagamento: terms.data_pagamento },
  };
}

function previewFor(state, terms) {
  const preview = {
    cliente: { id: Number(state.cliente.id), nome: String(state.cliente.nome || '') },
    emprestimo: { id: Number(state.emprestimo.id), versao_atual: state.versaoAtual },
    pagamento: { valor: terms.valor, data: terms.data_pagamento, tipo_pagamento: 'renegociacao' },
    renegociacao: {
      antes: { capital_restante: state.capitalAnterior, taxa_juros: money(state.emprestimo.taxa_juros), parcelas_abertas: state.parcelas.filter((parcela) => !Number(parcela.pago || 0)).length, versao: state.versaoAtual },
      novo_acordo: { capital: terms.valor, taxa_juros: terms.taxa_juros, parcelas: terms.parcelas, data: terms.data, primeiro_vencimento: terms.data_pagamento, juros: state.jurosPrevistos, total_previsto: state.totalPrevisto, versao: state.novaVersao },
      cronograma: state.novasParcelas,
    },
    audit: { componentes: { versao_anterior: state.versaoAtual, versao_nova: state.novaVersao, capital: terms.valor, taxa_juros: terms.taxa_juros, parcelas: terms.parcelas, juros: state.jurosPrevistos, total_previsto: state.totalPrevisto } },
    impacto: { parcelas_substituidas: state.parcelas.length, parcelas_novas: state.novasParcelas.length, snapshot_preservado: true, cronograma_substituido: true },
  };
  preview.ui = { title: 'Renegociar empréstimo', fields: [['Cliente', preview.cliente.nome], ['Empréstimo', `#${preview.emprestimo.id}`], ['Versão nova', state.novaVersao]], sections: [
    { title: 'Antes', rows: [['Versão atual', state.versaoAtual], ['Capital relevante', state.capitalAnterior], ['Taxa atual', money(state.emprestimo.taxa_juros)], ['Parcelas atuais', state.parcelas.length]] },
    { title: 'Novo acordo', rows: [['Capital', terms.valor], ['Taxa de juros', terms.taxa_juros], ['Quantidade de parcelas', terms.parcelas], ['Juros previstos', state.jurosPrevistos], ['Total previsto', state.totalPrevisto], ['Primeiro vencimento', terms.data_pagamento]] },
    { title: 'Impacto', rows: [['Parcelas substituídas', state.parcelas.length], ['Novas parcelas', state.novasParcelas.length], ['Snapshot histórico', 'Será preservado antes da alteração']] },
  ], impact: [['Resultado', 'O cronograma vigente será substituído após a confirmação.']] };
  return preview;
}

async function calcularPreviewRenegociacao(input, { dbHandle } = {}) {
  if (!dbHandle) throw new Error('dbHandle é obrigatório.');
  const terms = normalizeTerms(input, { strictAction: Boolean(input && input.action) });
  const state = await loadState(terms, dbHandle);
  const actionArguments = input.action ? {
    action: input.action, cliente_id: terms.cliente_id, emprestimo_id: terms.emprestimo_id,
    valor: terms.valor, parcelas: terms.parcelas, taxa_juros: terms.taxa_juros,
    data: terms.data, data_pagamento: terms.data_pagamento,
  } : terms;
  return { action: input.action || 'renegociar_emprestimo', arguments: actionArguments, state, state_fingerprint: stateFingerprint(state, terms), preview: previewFor(state, terms) };
}

async function columnNames(dbHandle, table) { return new Set((await allAsync(dbHandle, `PRAGMA table_info(${table})`)).map((column) => column.name)); }

async function aplicarRenegociacao(input, expectedFingerprint, { dbHandle, touchAtividade = null, idempotencyKey = null } = {}) {
  if (!dbHandle) throw new Error('dbHandle é obrigatório.');
  await runAsync(dbHandle, 'BEGIN IMMEDIATE TRANSACTION');
  try {
    const prepared = await calcularPreviewRenegociacao(input, { dbHandle });
    if (expectedFingerprint && prepared.state_fingerprint !== expectedFingerprint) throw actionError('state_changed', 'Os dados mudaram desde o preview. Gere uma nova confirmação.');
    const terms = prepared.arguments;
    const { state } = prepared;
    await ensureHistoricoTable(dbHandle);
    await claimActionExecution(dbHandle, { key: idempotencyKey, action: input.action || 'renegociar_emprestimo', emprestimoId: terms.emprestimo_id });
    const historico = await runAsync(dbHandle, `INSERT INTO renegociacoes_historico
      (emprestimo_id, versao, snapshot_emprestimo, snapshot_parcelas, tipo, observacao, detalhes)
      VALUES (?, ?, ?, ?, 'renegociacao_manual', ?, ?)`, [
      terms.emprestimo_id, state.versaoAtual, JSON.stringify(snapshotFor(state, terms)), JSON.stringify(state.parcelas), terms.observacao || '',
      JSON.stringify({ versao_anterior: state.versaoAtual, versao_nova: state.novaVersao, valor: terms.valor, parcelas: terms.parcelas, taxa_juros: terms.taxa_juros, data: terms.data, data_pagamento: terms.data_pagamento }),
    ]);
    if (terms.pagamento_id) {
      const paymentColumns = await columnNames(dbHandle, 'pagamentos');
      if (paymentColumns.has('renegociacao_id')) await runAsync(dbHandle,
        'UPDATE pagamentos SET renegociacao_id = ? WHERE id = ? AND emprestimo_id = ?',
        [historico.lastID, terms.pagamento_id, terms.emprestimo_id]);
    }
    await runAsync(dbHandle, 'DELETE FROM parcelas WHERE emprestimo_id = ?', [terms.emprestimo_id]);
    await runAsync(dbHandle, 'DELETE FROM parcelas_originais WHERE emprestimo_id = ?', [terms.emprestimo_id]);
    const columns = await columnNames(dbHandle, 'emprestimos');
    const values = { valor: terms.valor, taxa_juros: terms.taxa_juros, observacao: terms.observacao || state.emprestimo.observacao || '', valor_atual: terms.valor, parcelas: terms.parcelas, data: terms.data, capital_restante: terms.valor, versao_atual: state.novaVersao, dia_pagamento: Number(terms.data_pagamento.slice(8, 10)) };
    const sets = Object.keys(values).filter((column) => columns.has(column)).map((column) => `${column} = ?`);
    const params = Object.keys(values).filter((column) => columns.has(column)).map((column) => values[column]);
    if (columns.has('updated_at')) sets.push('updated_at = CURRENT_TIMESTAMP');
    await runAsync(dbHandle, `UPDATE emprestimos SET ${sets.join(', ')} WHERE id = ?`, [...params, terms.emprestimo_id]);
    if (columns.has('last_activity_at')) await runAsync(dbHandle, "UPDATE emprestimos SET last_activity_at = datetime('now') WHERE id = ?", [terms.emprestimo_id]);
    const clientColumns = await columnNames(dbHandle, 'clientes');
    if (clientColumns.has('last_activity_at')) await runAsync(dbHandle, "UPDATE clientes SET last_activity_at = datetime('now') WHERE id = ?", [state.emprestimo.cliente_id]);
    for (const parcela of state.novasParcelas) {
      await runAsync(dbHandle, `INSERT INTO parcelas (emprestimo_id, numero, valor_total, valor_capital, valor_juros, vencimento, pago, valor_pago, valor_excedente, juros_adicionais, juros_pendentes, observacao, versao)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, '', ?)`, [terms.emprestimo_id, parcela.numero, parcela.valor_total, parcela.valor_capital, parcela.valor_juros, parcela.vencimento, state.novaVersao]);
      await runAsync(dbHandle, `INSERT INTO parcelas_originais (emprestimo_id, numero, valor_total, valor_capital, valor_juros, valor_pago, valor_excedente, pago, data_pagamento)
        VALUES (?, ?, ?, ?, ?, 0, 0, 0, NULL)`, [terms.emprestimo_id, parcela.numero, parcela.valor_total, parcela.valor_capital, parcela.valor_juros]);
    }
    await runAsync(dbHandle, 'COMMIT');
    if (typeof touchAtividade === 'function') {
      try { await touchAtividade({ emprestimoId: terms.emprestimo_id }); } catch (_) { /* atividade é pós-commit e não altera o acordo */ }
    }
    return { historico_id: Number(historico.lastID), versao: state.novaVersao, parcelas_novas: state.novasParcelas, preview: prepared.preview };
  } catch (error) {
    await runAsync(dbHandle, 'ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = { normalizeTerms, calcularPreviewRenegociacao, aplicarRenegociacao, __internal: { loadState, stateFingerprint, previewFor, snapshotFor } };
