const crypto = require('crypto');
const aplicarPagamentoNormal = require('../../../utils/pagamento_comum');
const { runAsync, getAsync } = require('../../../utils/sqliteAsync');
const { splitNormalPaymentFromParcela } = require('../../pagamentos/paymentSplit');
const { claimActionExecution } = require('./actionIdempotency');

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(2));
}

function positiveId(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function isoDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : text;
}

function error(code, message) {
  const out = new Error(message);
  out.code = code;
  return out;
}

function snapshotFingerprint({ emprestimo, parcela, normalized }) {
  const source = JSON.stringify({
    emprestimo: {
      id: Number(emprestimo.id),
      cliente_id: Number(emprestimo.cliente_id),
      modalidade: String(emprestimo.modalidade || ''),
      versao_atual: Number(emprestimo.versao_atual || 0),
    },
    parcela: {
      id: Number(parcela.id),
      numero: Number(parcela.numero),
      valor_total: money(parcela.valor_total),
      valor_pago: money(parcela.valor_pago || 0),
      pago: Number(parcela.pago || 0),
      vencimento: parcela.vencimento || null,
      versao: Number(parcela.versao || 0),
    },
    arguments: normalized,
  });
  return crypto.createHash('sha256').update(source).digest('hex');
}

function normalizeIntent(intent = {}) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw error('invalid_action', 'Intencao de acao invalida.');
  }
  const allowedFields = new Set([
    'action', 'cliente_id', 'emprestimo_id', 'valor', 'data', 'tipo_pagamento',
  ]);
  const unknownFields = Object.keys(intent).filter((key) => !allowedFields.has(key));
  if (unknownFields.length) {
    throw error('invalid_action_contract', 'A intencao contem campos nao permitidos.');
  }
  if (String(intent.action || '') !== 'registrar_pagamento') {
    throw error('unsupported_action', 'Acao nao suportada.');
  }

  const clienteId = positiveId(intent.cliente_id);
  const emprestimoId = positiveId(intent.emprestimo_id);
  const valor = money(intent.valor);
  const data = isoDate(intent.data);
  const tipoPagamento = String(intent.tipo_pagamento || '').trim().toLowerCase();

  if (!clienteId || !emprestimoId) {
    throw error('entity_required', 'Cliente e emprestimo devem ser informados por ID exato.');
  }
  if (valor == null || valor <= 0) {
    throw error('invalid_amount', 'O valor do pagamento deve ser positivo.');
  }
  if (!data) {
    throw error('invalid_date', 'A data do pagamento deve estar no formato YYYY-MM-DD.');
  }
  // A primeira acao e deliberadamente limitada ao mesmo fluxo de pagamento normal.
  if (tipoPagamento !== 'normal') {
    throw error('unsupported_payment_type', 'Nesta fase apenas pagamento normal pode ser preparado.');
  }

  return {
    action: 'registrar_pagamento',
    cliente_id: clienteId,
    emprestimo_id: emprestimoId,
    valor,
    data,
    tipo_pagamento: 'normal',
  };
}

function defaultDb() {
  return require('../../../models/database');
}

function defaultRegistrarEntradaPagamento() {
  return require('../../caixaService').registrarEntradaPagamento;
}

async function resolvePaymentState(normalized, dbHandle) {
  const cliente = await getAsync(dbHandle, 'SELECT id, nome FROM clientes WHERE id = ?', [normalized.cliente_id]);
  if (!cliente) throw error('client_not_found', 'Cliente nao encontrado.');

  const emprestimo = await getAsync(
    dbHandle,
    'SELECT id, cliente_id, modalidade, versao_atual FROM emprestimos WHERE id = ?',
    [normalized.emprestimo_id]
  );
  if (!emprestimo) throw error('loan_not_found', 'Emprestimo nao encontrado.');
  if (Number(emprestimo.cliente_id) !== normalized.cliente_id) {
    throw error('loan_client_mismatch', 'O emprestimo nao pertence ao cliente informado.');
  }
  if (String(emprestimo.modalidade || '').toLowerCase() !== 'parcelado') {
    throw error('unsupported_loan_type', 'A acao exige um emprestimo parcelado.');
  }

  const parcela = await getAsync(
    dbHandle,
    `SELECT p.*
       FROM parcelas p
       JOIN emprestimos e ON e.id = p.emprestimo_id
      WHERE p.emprestimo_id = ?
        AND (p.versao IS NULL OR p.versao = e.versao_atual)
        AND COALESCE(p.pago, 0) = 0
      ORDER BY p.numero ASC, p.id ASC
      LIMIT 1`,
    [normalized.emprestimo_id]
  );
  if (!parcela) throw error('loan_closed', 'O emprestimo nao possui parcela em aberto.');

  return { cliente, emprestimo, parcela };
}

async function createPaymentPreview(intent, { dbHandle = defaultDb() } = {}) {
  const normalized = normalizeIntent(intent);
  const state = await resolvePaymentState(normalized, dbHandle);
  const updates = aplicarPagamentoNormal([state.parcela], 0, normalized.valor, normalized.data, '');
  const update = updates[0];
  if (!update) throw error('preview_unavailable', 'Nao foi possivel calcular o impacto do pagamento.');

  const before = money(state.parcela.valor_pago || 0);
  const after = money(update.valor_pago || 0);
  const prepared = {
    action: normalized.action,
    arguments: normalized,
    state_fingerprint: snapshotFingerprint({ ...state, normalized }),
    preview: {
      cliente: { id: Number(state.cliente.id), nome: String(state.cliente.nome || '') },
      emprestimo: { id: Number(state.emprestimo.id) },
      pagamento: { valor: normalized.valor, data: normalized.data, tipo_pagamento: normalized.tipo_pagamento },
      impacto: {
        parcela: { id: Number(state.parcela.id), numero: Number(state.parcela.numero) },
        valor_pago_anterior: before,
        valor_pago_posterior: after,
        parcela_quitada: Number(update.pago || 0) === 1,
      },
    },
  };
  prepared.preview.ui = {
    title: 'Registrar pagamento',
    fields: [
      ['Cliente', prepared.preview.cliente.nome || `Cliente #${prepared.preview.cliente.id}`],
      ['Empréstimo', `#${prepared.preview.emprestimo.id}`],
      ['Valor', prepared.preview.pagamento.valor],
      ['Data', prepared.preview.pagamento.data],
      ['Parcela afetada', `#${prepared.preview.impacto.parcela.numero}`],
      ['Valor pago após', prepared.preview.impacto.valor_pago_posterior],
    ],
    impact: prepared.preview.impacto.parcela_quitada ? [['Resultado', 'A parcela ficará quitada.']] : [],
  };
  return prepared;
}

async function executePayment(normalized, expectedFingerprint, {
  dbHandle = defaultDb(),
  registrarEntradaPagamento = defaultRegistrarEntradaPagamento(),
  idempotencyKey = null,
} = {}) {
  await runAsync(dbHandle, 'BEGIN IMMEDIATE TRANSACTION');
  try {
    const fresh = await createPaymentPreview(normalized, { dbHandle });
    if (fresh.state_fingerprint !== expectedFingerprint) {
      throw error('state_changed', 'Os dados mudaram desde o preview. Gere uma nova confirmacao.');
    }
    await claimActionExecution(dbHandle, { key: idempotencyKey, action: normalized.action, emprestimoId: normalized.emprestimo_id });

    const update = aplicarPagamentoNormal(
      [await getAsync(dbHandle, 'SELECT * FROM parcelas WHERE id = ?', [fresh.preview.impacto.parcela.id])],
      0,
      normalized.valor,
      normalized.data,
      ''
    )[0];

    const paymentInsert = await runAsync(
      dbHandle,
      `INSERT INTO pagamentos (emprestimo_id, valor, data, tipo_pagamento, observacao, parcela_origem)
       VALUES (?, ?, ?, 'normal', '', ?)`,
      [normalized.emprestimo_id, normalized.valor, normalized.data, Number(fresh.preview.impacto.parcela.numero) - 1]
    );

    await runAsync(
      dbHandle,
      `UPDATE parcelas
          SET valor_pago = ?, valor_excedente = ?, data_pagamento = ?, pago = ?,
              valor_total = ?, valor_capital = ?, valor_juros = ?, tipo_pagamento = 'normal'
        WHERE id = ?`,
      [
        update.valor_pago ?? null,
        update.valor_excedente ?? null,
        update.data_pagamento ?? normalized.data,
        update.pago ?? 0,
        update.valor_total ?? null,
        update.valor_capital ?? null,
        update.valor_juros ?? null,
        fresh.preview.impacto.parcela.id,
      ]
    );

    const allocation = splitNormalPaymentFromParcela(
      await getAsync(dbHandle, 'SELECT * FROM parcelas WHERE id = ?', [fresh.preview.impacto.parcela.id]),
      normalized.valor
    );
    await registrarEntradaPagamento({
      emprestimo_id: normalized.emprestimo_id,
      cliente_id: normalized.cliente_id,
      parcela_id: fresh.preview.impacto.parcela.id,
      parcela_numero: fresh.preview.impacto.parcela.numero,
      data: normalized.data,
      data_pagamento: normalized.data,
      valor_total: normalized.valor,
      valor_juros: allocation.juros,
      valor_capital: allocation.capital,
      descricao: 'Pagamento registrado pela assistente',
      meta: { origem: 'assistente_action_gateway', pagamento_id: paymentInsert.lastID },
    }, dbHandle);

    await runAsync(dbHandle, 'COMMIT');
    return { pagamento_id: Number(paymentInsert.lastID), preview: fresh.preview };
  } catch (err) {
    await runAsync(dbHandle, 'ROLLBACK').catch(() => {});
    throw err;
  }
}

module.exports = { createPaymentPreview, executePayment, normalizeIntent, snapshotFingerprint };
