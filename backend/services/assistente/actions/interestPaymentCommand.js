const crypto = require('crypto');
const aplicarPagamentoJuros = require('../../../utils/pagamento_juros');
const { runAsync, getAsync, allAsync } = require('../../../utils/sqliteAsync');
const { claimActionExecution } = require('./actionIdempotency');

function money(value) { const n = Number(value); return Number.isFinite(n) ? Number(n.toFixed(2)) : null; }
function positiveId(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : null; }
function isoDate(value) { const s = String(value || '').trim(); const d = new Date(`${s}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null; }
function error(code, message) { const e = new Error(message); e.code = code; return e; }
function defaultDb() { return require('../../../models/database'); }
function defaultRegistrarEntradaPagamento() { return require('../../caixaService').registrarEntradaPagamento; }

function normalizeIntent(intent = {}) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw error('invalid_action', 'Intencao de acao invalida.');
  const allowed = new Set(['action', 'cliente_id', 'emprestimo_id', 'valor', 'data']);
  if (Object.keys(intent).some((key) => !allowed.has(key))) throw error('invalid_action_contract', 'A intencao contem campos nao permitidos.');
  if (String(intent.action || '') !== 'registrar_pagamento_juros') throw error('unsupported_action', 'Acao nao suportada.');
  const normalized = { action: 'registrar_pagamento_juros', cliente_id: positiveId(intent.cliente_id), emprestimo_id: positiveId(intent.emprestimo_id), valor: money(intent.valor), data: isoDate(intent.data) };
  if (!normalized.cliente_id || !normalized.emprestimo_id) throw error('entity_required', 'Cliente e emprestimo devem ser informados por ID exato.');
  if (normalized.valor == null || normalized.valor <= 0) throw error('invalid_amount', 'O valor dos juros deve ser positivo.');
  if (!normalized.data) throw error('invalid_date', 'A data do pagamento deve estar no formato YYYY-MM-DD.');
  return normalized;
}

async function resolveState(normalized, dbHandle) {
  const cliente = await getAsync(dbHandle, 'SELECT id, nome FROM clientes WHERE id = ?', [normalized.cliente_id]);
  if (!cliente) throw error('client_not_found', 'Cliente nao encontrado.');
  const emprestimo = await getAsync(dbHandle, 'SELECT id, cliente_id, modalidade, versao_atual FROM emprestimos WHERE id = ?', [normalized.emprestimo_id]);
  if (!emprestimo) throw error('loan_not_found', 'Emprestimo nao encontrado.');
  if (Number(emprestimo.cliente_id) !== normalized.cliente_id) throw error('loan_client_mismatch', 'O emprestimo nao pertence ao cliente informado.');
  if (String(emprestimo.modalidade || '').toLowerCase() !== 'parcelado') throw error('unsupported_loan_type', 'A acao exige um emprestimo parcelado.');
  const parcelas = await allAsync(dbHandle, `SELECT p.* FROM parcelas p JOIN emprestimos e ON e.id = p.emprestimo_id WHERE p.emprestimo_id = ? AND (p.versao IS NULL OR p.versao = e.versao_atual) ORDER BY p.numero ASC, p.id ASC`, [normalized.emprestimo_id]);
  const atualIndex = parcelas.findIndex((p) => Number(p.pago || 0) === 0);
  if (atualIndex < 0) throw error('loan_closed', 'O emprestimo nao possui parcela em aberto.');
  return { cliente, emprestimo, parcelas, atualIndex };
}

function fingerprint(state, normalized) {
  const source = JSON.stringify({ emprestimo: { id: Number(state.emprestimo.id), cliente_id: Number(state.emprestimo.cliente_id), versao_atual: Number(state.emprestimo.versao_atual || 0) }, parcelas: state.parcelas.map((p) => ({ id: Number(p.id), pago: Number(p.pago || 0), vencimento: p.vencimento || null, valor_capital: money(p.valor_capital), valor_juros: money(p.valor_juros), juros_pendentes: money(p.juros_pendentes || 0), juros_adicionais: money(p.juros_adicionais || 0), versao: Number(p.versao || 0) })), arguments: normalized });
  return crypto.createHash('sha256').update(source).digest('hex');
}

function ui(preview) {
  const i = preview.impacto;
  return { title: 'Registrar pagamento de juros', fields: [
    ['Cliente', preview.cliente.nome || `Cliente #${preview.cliente.id}`], ['Empréstimo', `#${preview.emprestimo.id}`], ['Valor de juros', preview.pagamento.valor], ['Data', preview.pagamento.data], ['Parcela afetada', `#${i.parcela.numero}`], ['Novo vencimento', i.vencimento_posterior],
  ], impact: [['Juros pendentes após', i.juros.pendentes_depois], ['Capital mantido', i.capital_posterior], ['Parcelas reagendadas', i.parcelas_reagendadas]] };
}

async function createPaymentPreview(intent, { dbHandle = defaultDb() } = {}) {
  const normalized = normalizeIntent(intent); const state = await resolveState(normalized, dbHandle); const current = state.parcelas[state.atualIndex];
  const total = money(Number(current.valor_juros || 0) + Number(current.juros_pendentes || 0) + Number(current.juros_adicionais || 0));
  if (normalized.valor !== total) throw error('interest_amount_mismatch', 'O valor deve corresponder exatamente aos juros atuais da parcela.');
  const updates = await aplicarPagamentoJuros(state.parcelas, state.atualIndex, normalized.valor, normalized.data, '', { dbHandle }); const update = updates[0];
  const preview = { cliente: { id: Number(state.cliente.id), nome: String(state.cliente.nome || '') }, emprestimo: { id: Number(state.emprestimo.id) }, pagamento: { valor: normalized.valor, data: normalized.data, tipo_pagamento: 'juros' }, impacto: { parcela: { id: Number(current.id), numero: Number(current.numero) }, juros: { base: money(current.valor_juros || 0), pendentes_antes: money(current.juros_pendentes || 0), adicionais_antes: money(current.juros_adicionais || 0), total_antes: total, pendentes_depois: money(update.juros_pendentes || 0), adicionais_depois: money(update.juros_adicionais || 0) }, capital_anterior: money(current.valor_capital || 0), capital_posterior: money(update.valor_capital || 0), vencimento_anterior: current.vencimento || null, vencimento_posterior: update.vencimento || null, parcelas_reagendadas: Math.max(0, updates.filter((p) => Number(p.id) !== Number(current.id) && p.vencimento).length) } };
  preview.ui = ui(preview); return { action: normalized.action, arguments: normalized, state_fingerprint: fingerprint(state, normalized), preview, updates };
}

async function executePayment(normalized, expectedFingerprint, { dbHandle = defaultDb(), registrarEntradaPagamento = defaultRegistrarEntradaPagamento(), idempotencyKey = null } = {}) {
  await runAsync(dbHandle, 'BEGIN IMMEDIATE TRANSACTION');
  try {
    const fresh = await createPaymentPreview(normalized, { dbHandle });
    if (fresh.state_fingerprint !== expectedFingerprint) throw error('state_changed', 'Os dados mudaram desde o preview. Gere uma nova confirmacao.');
    await claimActionExecution(dbHandle, { key: idempotencyKey, action: normalized.action, emprestimoId: normalized.emprestimo_id });
    const payment = await runAsync(dbHandle, `INSERT INTO pagamentos (emprestimo_id, valor, data, tipo_pagamento, observacao, parcela_origem) VALUES (?, ?, ?, 'juros', '', ?)`, [normalized.emprestimo_id, normalized.valor, normalized.data, Number(fresh.preview.impacto.parcela.numero) - 1]);
    for (const update of fresh.updates) await runAsync(dbHandle, `UPDATE parcelas SET valor_pago=?, valor_excedente=?, data_pagamento=?, vencimento=?, pago=?, valor_total=?, valor_capital=?, valor_juros=?, juros_pendentes=?, juros_adicionais=?, observacao=?, explicacao=?, tipo_pagamento=? WHERE id=?`, [update.valor_pago ?? null, update.valor_excedente ?? null, update.data_pagamento ?? null, update.vencimento ?? null, update.pago ? 1 : 0, update.valor_total ?? null, update.valor_capital ?? null, update.valor_juros ?? null, update.juros_pendentes ?? null, update.juros_adicionais ?? null, update.observacao ?? null, update.explicacao ?? null, update.tipo_pagamento ?? null, update.id]);
    await registrarEntradaPagamento({ emprestimo_id: normalized.emprestimo_id, cliente_id: normalized.cliente_id, parcela_id: fresh.preview.impacto.parcela.id, parcela_numero: fresh.preview.impacto.parcela.numero, data: normalized.data, data_pagamento: normalized.data, valor_total: normalized.valor, valor_juros: normalized.valor, valor_capital: 0, descricao: 'Pagamento de juros registrado pela assistente', meta: { origem: 'assistente_action_gateway', pagamento_id: payment.lastID } }, dbHandle);
    await runAsync(dbHandle, 'COMMIT'); return { pagamento_id: Number(payment.lastID), preview: fresh.preview };
  } catch (err) { await runAsync(dbHandle, 'ROLLBACK').catch(() => {}); throw err; }
}
module.exports = { normalizeIntent, createPaymentPreview, executePayment };
