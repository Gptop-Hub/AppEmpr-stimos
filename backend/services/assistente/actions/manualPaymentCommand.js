const crypto = require('crypto');
const aplicarPagamentoManual = require('../../../utils/pagamento_manual');
const { runAsync, getAsync, allAsync } = require('../../../utils/sqliteAsync');
const { claimActionExecution } = require('./actionIdempotency');

function money(value) { const n = Number(value); return Number.isFinite(n) ? Number(n.toFixed(2)) : null; }
function positiveId(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : null; }
function isoDate(value) { const s = String(value || '').trim(); const d = new Date(`${s}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null; }
function error(code, message) { const e = new Error(message); e.code = code; return e; }
function defaultDb() { return require('../../../models/database'); }
function defaultRegistrarEntradaPagamento() { return require('../../caixaService').registrarEntradaPagamento; }
function normalizeAbatimentos(value) {
  if (!Array.isArray(value) || !value.length || value.length > 50) throw error('invalid_allocations', 'Informe ao menos um abatimento manual por parcela.');
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !['parcela_id', 'valor'].includes(key))) throw error('invalid_action_contract', 'Os abatimentos possuem campos nao permitidos.');
    const parcelaId = positiveId(item.parcela_id); const amount = money(item.valor);
    if (!parcelaId || amount == null || amount <= 0 || seen.has(parcelaId)) throw error('invalid_allocations', 'Cada abatimento deve ter parcela e valor positivo unicos.');
    seen.add(parcelaId); return { parcela_id: parcelaId, valor: amount };
  });
}
function normalizeIntent(intent = {}) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw error('invalid_action', 'Intencao de acao invalida.');
  const allowed = new Set(['action', 'cliente_id', 'emprestimo_id', 'valor', 'data', 'abatimentos']);
  if (Object.keys(intent).some((key) => !allowed.has(key))) throw error('invalid_action_contract', 'A intencao contem campos nao permitidos.');
  if (String(intent.action || '') !== 'registrar_pagamento_manual') throw error('unsupported_action', 'Acao nao suportada.');
  const normalized = { action: 'registrar_pagamento_manual', cliente_id: positiveId(intent.cliente_id), emprestimo_id: positiveId(intent.emprestimo_id), valor: money(intent.valor), data: isoDate(intent.data), abatimentos: normalizeAbatimentos(intent.abatimentos) };
  if (!normalized.cliente_id || !normalized.emprestimo_id) throw error('entity_required', 'Cliente e emprestimo devem ser informados por ID exato.');
  if (normalized.valor == null || normalized.valor <= 0) throw error('invalid_amount', 'O valor do pagamento deve ser positivo.');
  if (!normalized.data) throw error('invalid_date', 'A data deve estar no formato YYYY-MM-DD.');
  if (money(normalized.abatimentos.reduce((total, item) => total + item.valor, 0)) > normalized.valor) throw error('invalid_allocations', 'A soma dos abatimentos nao pode exceder o pagamento.');
  return normalized;
}
function officialAllocations(abatimentos) { return abatimentos.map((item) => ({ parcelaId: item.parcela_id, abatParcela: item.valor })); }
async function loadState(normalized, dbHandle) {
  const cliente = await getAsync(dbHandle, 'SELECT id, nome FROM clientes WHERE id=?', [normalized.cliente_id]); if (!cliente) throw error('client_not_found', 'Cliente nao encontrado.');
  const emprestimo = await getAsync(dbHandle, 'SELECT id, cliente_id, modalidade, versao_atual, capital_restante FROM emprestimos WHERE id=?', [normalized.emprestimo_id]);
  if (!emprestimo) throw error('loan_not_found', 'Emprestimo nao encontrado.'); if (Number(emprestimo.cliente_id) !== normalized.cliente_id) throw error('loan_client_mismatch', 'O emprestimo nao pertence ao cliente informado.'); if (String(emprestimo.modalidade || '').toLowerCase() !== 'parcelado') throw error('unsupported_loan_type', 'A acao exige emprestimo parcelado.');
  const parcelas = await allAsync(dbHandle, `SELECT p.* FROM parcelas p JOIN emprestimos e ON e.id=p.emprestimo_id WHERE p.emprestimo_id=? AND (p.versao IS NULL OR p.versao=e.versao_atual) ORDER BY p.numero,p.id`, [normalized.emprestimo_id]);
  if (!parcelas.some((p) => !Number(p.pago || 0))) throw error('loan_closed', 'O emprestimo nao possui parcela em aberto.');
  const byId = new Map(parcelas.map((p) => [Number(p.id), p]));
  if (normalized.abatimentos.some((item) => !byId.has(item.parcela_id) || Number(byId.get(item.parcela_id).pago || 0))) throw error('invalid_allocations', 'Os abatimentos devem apontar para parcelas abertas do emprestimo.');
  return { cliente, emprestimo, parcelas, selected: normalized.abatimentos.map((item) => byId.get(item.parcela_id)) };
}
function fingerprint(state, normalized) { return crypto.createHash('sha256').update(JSON.stringify({ emprestimo: { id: state.emprestimo.id, versao: state.emprestimo.versao_atual, capital: money(state.emprestimo.capital_restante) }, parcelas: state.parcelas.map((p) => [p.id, p.valor_total, p.valor_capital, p.valor_juros, p.juros_pendentes, p.juros_adicionais, p.valor_pago, p.pago, p.versao]), arguments: normalized })).digest('hex'); }
function allocation(before, after) { const total = (field) => money(before.reduce((sum, p) => sum + Math.max(0, Number(p[field] || 0) - Number((after.get(Number(p.id)) || {})[field] || 0)), 0)); return { juros_adicionais: total('juros_adicionais'), juros_pendentes: total('juros_pendentes'), juros_base: total('valor_juros'), capital: total('valor_capital') }; }
async function createPaymentPreview(intent, { dbHandle = defaultDb() } = {}) {
  const normalized = normalizeIntent(intent); await runAsync(dbHandle, 'BEGIN IMMEDIATE TRANSACTION');
  try {
    const state = await loadState(normalized, dbHandle); const result = await aplicarPagamentoManual(normalized.emprestimo_id, normalized.valor, officialAllocations(normalized.abatimentos), normalized.data, { dbHandle, manageTransaction: false });
    const afterRows = await allAsync(dbHandle, `SELECT * FROM parcelas WHERE id IN (${normalized.abatimentos.map(() => '?').join(',')})`, normalized.abatimentos.map((item) => item.parcela_id)); const after = new Map(afterRows.map((p) => [Number(p.id), p])); const split = allocation(state.selected, after);
    const reference = state.selected[0]; const afterReference = after.get(Number(reference.id)); const preview = { cliente: { id: Number(state.cliente.id), nome: String(state.cliente.nome || '') }, emprestimo: { id: Number(state.emprestimo.id) }, pagamento: { valor: normalized.valor, data: normalized.data, tipo_pagamento: 'manual' }, impacto: { parcela: { id: Number(reference.id), numero: Number(reference.numero) }, distribuicao: split, saldo_nao_alocado: result.saldoRestante, estado_antes: { valor_total: money(reference.valor_total), capital: money(reference.valor_capital), juros_base: money(reference.valor_juros), juros_pendentes: money(reference.juros_pendentes), juros_adicionais: money(reference.juros_adicionais) }, estado_depois: { valor_total: money(afterReference.valor_total), capital: money(afterReference.valor_capital), juros_base: money(afterReference.valor_juros), juros_pendentes: money(afterReference.juros_pendentes), juros_adicionais: money(afterReference.juros_adicionais) } } };
    preview.ui = { title: 'Registrar pagamento manual', fields: [['Cliente', preview.cliente.nome], ['Empréstimo', `#${preview.emprestimo.id}`], ['Valor', normalized.valor], ['Data', normalized.data], ['Parcela afetada', `#${reference.numero}`]], sections: [{ title: 'Distribuição', rows: [['Juros adicionais', split.juros_adicionais], ['Juros pendentes', split.juros_pendentes], ['Juros base', split.juros_base], ['Capital', split.capital]] }], impact: [['Saldo não alocado', result.saldoRestante]] };
    await runAsync(dbHandle, 'ROLLBACK'); return { action: normalized.action, arguments: normalized, state_fingerprint: fingerprint(state, normalized), preview };
  } catch (err) { await runAsync(dbHandle, 'ROLLBACK').catch(() => {}); throw err; }
}
async function executePayment(normalized, expectedFingerprint, { dbHandle = defaultDb(), registrarEntradaPagamento = defaultRegistrarEntradaPagamento(), idempotencyKey = null } = {}) {
  await runAsync(dbHandle, 'BEGIN IMMEDIATE TRANSACTION');
  try {
    const clean = normalizeIntent(normalized); const state = await loadState(clean, dbHandle); if (fingerprint(state, clean) !== expectedFingerprint) throw error('state_changed', 'Os dados mudaram desde o preview. Gere uma nova confirmacao.'); await claimActionExecution(dbHandle, { key: idempotencyKey, action: clean.action, emprestimoId: clean.emprestimo_id });
    const result = await aplicarPagamentoManual(clean.emprestimo_id, clean.valor, officialAllocations(clean.abatimentos), clean.data, { dbHandle, manageTransaction: false });
    const afterRows = await allAsync(dbHandle, `SELECT * FROM parcelas WHERE id IN (${clean.abatimentos.map(() => '?').join(',')})`, clean.abatimentos.map((item) => item.parcela_id)); const after = new Map(afterRows.map((p) => [Number(p.id), p])); const split = allocation(state.selected, after); const reference = state.selected[0];
    const payment = await runAsync(dbHandle, `INSERT INTO pagamentos (emprestimo_id, valor, data, tipo_pagamento, observacao, parcela_origem) VALUES (?, ?, ?, 'manual', '', ?)`, [clean.emprestimo_id, clean.valor, clean.data, Number(reference.numero) - 1]);
    await registrarEntradaPagamento({ emprestimo_id: clean.emprestimo_id, cliente_id: clean.cliente_id, parcela_id: reference.id, parcela_numero: reference.numero, data: clean.data, data_pagamento: clean.data, valor_total: clean.valor, valor_juros: money(split.juros_adicionais + split.juros_pendentes + split.juros_base), valor_capital: split.capital, descricao: 'Pagamento manual registrado pela assistente', meta: { origem: 'assistente_action_gateway', pagamento_id: payment.lastID, abatimentos: clean.abatimentos.length } }, dbHandle);
    await runAsync(dbHandle, 'COMMIT'); return { pagamento_id: Number(payment.lastID), preview: { impacto: { distribuicao: split, saldo_nao_alocado: result.saldoRestante } } };
  } catch (err) { await runAsync(dbHandle, 'ROLLBACK').catch(() => {}); throw err; }
}
module.exports = { normalizeIntent, createPaymentPreview, executePayment };
