const db = require('../models/database');
const aplicarPagamentoNormal = require('../utils/pagamento_comum');
const aplicarPagamentoManual = require('../utils/pagamento_manual');
const aplicarPagamentoJuros = require('../utils/pagamento_juros');
const pagarJurosParcial = require('../utils/pagamento_juros_parcial');
const aplicarQuitarEmprestimo = require('../utils/quitar_emprestimo');
const { registrarEntradaPagamento } = require('./caixaService');
const { touchAtividade } = require('../utils/touchAtividade');
const { runAsync, getAsync, allAsync } = require('../utils/sqliteAsync');
const { ensureActionContractReady } = require('./actionIdentityService');
const { capturarEstadoEmprestimo, registrarAcaoEmprestimo } = require('./emprestimoActionService');

function f2(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function toMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? f2(number) : 0;
}

function jurosDaParcela(parcela) {
  return f2(
    Number(parcela?.valor_juros || 0) +
    Number(parcela?.juros_pendentes || 0) +
    Number(parcela?.juros_adicionais || 0)
  );
}

function splitNormal(parcela, valor) {
  const total = toMoney(valor);
  const juros = Math.min(total, jurosDaParcela(parcela));
  return { juros: f2(juros), capital: f2(Math.max(0, total - juros)) };
}

function splitManual(parcelasAntes, parcelasDepois, valor, parcelaFallback) {
  const antesPorId = new Map((parcelasAntes || []).filter(Boolean).map((parcela) => [Number(parcela.id), parcela]));
  let jurosAplicado = 0;
  let capitalAplicado = 0;
  for (const depois of parcelasDepois || []) {
    const antes = antesPorId.get(Number(depois?.id));
    if (!antes) continue;
    jurosAplicado += Math.max(0, f2(jurosDaParcela(antes) - jurosDaParcela(depois)));
    capitalAplicado += Math.max(0, f2(Number(antes.valor_capital || 0) - Number(depois.valor_capital || 0)));
  }
  const total = toMoney(valor);
  jurosAplicado = Math.min(total, f2(jurosAplicado));
  if (jurosAplicado <= 0 && capitalAplicado <= 0) return splitNormal(parcelaFallback, total);
  const capitalRestante = Math.max(0, f2(total - jurosAplicado));
  return {
    juros: f2(jurosAplicado),
    capital: f2(capitalAplicado > 0 ? Math.min(capitalRestante, f2(capitalAplicado)) : capitalRestante),
  };
}

function descricaoManual(parcela, valor) {
  const total = toMoney(parcela?.valor_total);
  const juros = jurosDaParcela(parcela);
  const pago = toMoney(valor);
  if (juros > 0 && pago < juros - 0.01) return 'Pagou menos que os juros.';
  if (juros > 0 && Math.abs(pago - juros) <= 0.01) return 'Pagou somente os juros.';
  if (total > juros + 0.01 && pago > juros + 0.01 && pago < total - 0.01) {
    return 'Pagou mais que os juros, porém menos que o valor da parcela.';
  }
  if (total > 0 && Math.abs(pago - total) <= 0.01) return 'Pagou a parcela inteira.';
  if (total > 0 && pago > total + 0.01) return 'Pagou mais que o valor da parcela.';
  return 'Pagamento manual registrado.';
}

function resolveParcelaReferencia(parcelas, updates, parcelaOrigem) {
  if (Number.isFinite(Number(parcelaOrigem))) {
    const byNumero = parcelas.find((parcela) => Number(parcela.numero) === Number(parcelaOrigem) + 1);
    if (byNumero) return byNumero;
  }
  const firstUpdate = (updates || []).find((update) => update && update.id != null);
  if (firstUpdate) {
    return parcelas.find((parcela) => Number(parcela.id) === Number(firstUpdate.id)) || firstUpdate;
  }
  return parcelas.find((parcela) => !parcela.pago) || parcelas[0] || null;
}

async function aplicarAtualizacoesNormais(dbHandle, updates, { data, observacao, tipoPagamento }) {
  for (let index = 0; index < updates.length; index += 1) {
    const update = updates[index];
    const row = await getAsync(dbHandle, 'SELECT observacao FROM parcelas WHERE id = ?', [update.id]);
    const existente = row?.observacao ? String(row.observacao) : '';
    const nota = update.observacao && String(update.observacao).trim()
      ? String(update.observacao).trim()
      : (index === 0 && observacao && String(observacao).trim() ? String(observacao).trim() : '');
    const observacaoFinal = nota ? (existente ? `${existente}\n${nota}` : nota) : existente;
    await runAsync(dbHandle, `UPDATE parcelas SET
      valor_pago = COALESCE(?, valor_pago), valor_excedente = COALESCE(?, valor_excedente),
      data_pagamento = COALESCE(?, data_pagamento), vencimento = COALESCE(?, vencimento),
      pago = COALESCE(?, pago), valor_total = COALESCE(?, valor_total),
      valor_capital = COALESCE(?, valor_capital), valor_juros = COALESCE(?, valor_juros),
      juros_pendentes = COALESCE(?, juros_pendentes), observacao = COALESCE(?, observacao),
      explicacao = CASE WHEN ? IS NULL THEN explicacao ELSE ? END,
      tipo_pagamento = COALESCE(?, tipo_pagamento)
      WHERE id = ?`, [
      update.valor_pago ?? null, update.valor_excedente ?? null, update.data_pagamento ?? data ?? null,
      update.vencimento ?? null, update.pago ?? null, update.valor_total ?? null,
      update.valor_capital ?? null, update.valor_juros ?? null, update.juros_pendentes ?? null,
      observacaoFinal ?? null, update.explicacao ?? null, update.explicacao ?? null,
      update.tipo_pagamento ?? tipoPagamento ?? null, update.id,
    ]);
  }
}

async function carregarParcelasAtuais(dbHandle, emprestimoId) {
  return allAsync(dbHandle, `SELECT p.* FROM parcelas p
    JOIN emprestimos e ON e.id = p.emprestimo_id
    WHERE p.emprestimo_id = ? AND (p.versao IS NULL OR p.versao = e.versao_atual)
    ORDER BY p.numero ASC`, [emprestimoId]);
}

async function anexarObservacaoManual(dbHandle, parcelaId, texto) {
  if (!parcelaId || !texto || !String(texto).trim()) return;
  const row = await getAsync(dbHandle, 'SELECT observacao FROM parcelas WHERE id = ?', [parcelaId]);
  const existente = row?.observacao ? String(row.observacao) : '';
  const merged = existente ? `${existente}\n${String(texto).trim()}` : String(texto).trim();
  await runAsync(dbHandle, 'UPDATE parcelas SET observacao = ? WHERE id = ?', [merged, parcelaId]);
}

function formatarDataManual(iso) {
  const data = new Date(`${String(iso || '').slice(0, 10)}T00:00:00`);
  if (Number.isNaN(data.getTime())) return String(iso || '');
  const meses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  return `${String(data.getDate()).padStart(2, '0')} ${meses[data.getMonth()]} ${data.getFullYear()}`;
}

async function anexarObservacaoJurosParciais(dbHandle, parcelaId, texto, dataPagamento) {
  if (!parcelaId || !texto || !String(texto).trim()) return;
  const row = await getAsync(dbHandle, 'SELECT observacao FROM parcelas WHERE id = ?', [parcelaId]);
  const nota = `${String(texto).trim()} — manual · ${formatarDataManual(dataPagamento)}`;
  const existente = row?.observacao ? String(row.observacao) : '';
  await runAsync(dbHandle, 'UPDATE parcelas SET observacao = ? WHERE id = ?', [existente ? `${existente}\n${nota}` : nota, parcelaId]);
}

async function concluirAcao({ dbHandle, tipo, emprestimoId, clienteId, antes, parametros, resumo }) {
  const depois = await capturarEstadoEmprestimo(emprestimoId, { dbHandle });
  return registrarAcaoEmprestimo({
    tipo,
    origem: 'interface',
    emprestimoId,
    clienteId,
    antes,
    depois,
    parametros,
    resumo,
  }, { dbHandle });
}

function normalizarUpdatesLegados(updates, observacao) {
  if (Array.isArray(updates) && updates.length > 0) {
    updates[0].valor_pago = Number(Number(updates[0].valor_pago || 0).toFixed(2));
    if (!updates[0].observacao) updates[0].observacao = observacao || updates[0].observacao || '';
  }
  for (const update of updates || []) {
    if (!Object.prototype.hasOwnProperty.call(update, 'explicacao')) update.explicacao = null;
  }
  return updates || [];
}

function descricaoTipoLegado(tipo) {
  if (tipo === 'juros') return 'Pagou somente os juros.';
  if (tipo === 'quitar') return 'Quitou completamente o empréstimo.';
  return 'Pagamento registrado.';
}

async function executarPagamentoLegadoComAcao({
  tipo, acaoTipo, emprestimoId, valor, data, observacao = '', parcelaOrigem = null,
}, { dbHandle = db } = {}) {
  await ensureActionContractReady(dbHandle);
  await runAsync(dbHandle, 'BEGIN IMMEDIATE');
  try {
    const emprestimo = await getAsync(dbHandle, 'SELECT * FROM emprestimos WHERE id = ?', [emprestimoId]);
    if (!emprestimo) throw new Error('Empréstimo não encontrado');
    const antes = await capturarEstadoEmprestimo(emprestimoId, { dbHandle });
    const cronograma = await carregarParcelasAtuais(dbHandle, emprestimoId);
    const atualIndex = cronograma.findIndex((parcela) => !parcela.pago);
    if (atualIndex < 0) throw new Error('Nenhuma parcela pendente.');
    const parcelaAtual = cronograma[atualIndex];
    const calculation = tipo === 'quitar'
      ? aplicarQuitarEmprestimo.calcularValorQuitacao(cronograma, atualIndex)
      : null;
    const updates = normalizarUpdatesLegados(
      tipo === 'juros'
        ? await aplicarPagamentoJuros(cronograma, atualIndex, valor, data, observacao, { dbHandle })
        : await aplicarQuitarEmprestimo(cronograma, atualIndex, Number(valor), data, observacao),
      observacao
    );
    await aplicarAtualizacoesNormais(dbHandle, updates, { data, observacao, tipoPagamento: tipo });
    const pagamento = await runAsync(dbHandle, `INSERT INTO pagamentos
      (emprestimo_id, valor, data, tipo_pagamento, observacao, parcela_origem)
      VALUES (?, ?, ?, ?, ?, ?)`, [emprestimoId, valor, data, tipo, observacao, parcelaOrigem]);
    const referencia = resolveParcelaReferencia(cronograma, updates, parcelaOrigem);
    const juros = tipo === 'juros'
      ? toMoney(valor)
      : Math.min(toMoney(valor), toMoney(parcelaAtual?.valor_juros));
    await registrarEntradaPagamento({
      emprestimo_id: emprestimoId, parcela_id: referencia?.id || null,
      parcela_numero: referencia?.numero || null, data_vencimento: referencia?.vencimento || null,
      data, data_pagamento: data, valor_total: valor,
      valor_juros: juros, valor_capital: tipo === 'juros' ? 0 : f2(Math.max(0, toMoney(valor) - juros)),
      descricao: descricaoTipoLegado(tipo),
      meta: { origem: '/pagamentos', pagamento_id: pagamento.lastID, tipo_pagamento: tipo, observacao: observacao || null, parcela_origem: parcelaOrigem, parcelas_atualizadas: updates.length },
    }, dbHandle);
    await touchAtividade({ emprestimoId, dbHandle, strict: true });
    const action = await concluirAcao({
      dbHandle, tipo: acaoTipo, emprestimoId, clienteId: emprestimo.cliente_id, antes,
      parametros: {
        valor: toMoney(valor), data_pagamento: data, observacao: observacao || null,
        parcela_origem: parcelaOrigem, tipo_pagamento: tipo,
        valor_exigido: calculation?.expected ?? null,
        capital_exigido: calculation?.somaCapital ?? null,
        juros_exigidos: calculation?.jurosAtual ?? (tipo === 'juros' ? toMoney(valor) : null),
      },
      resumo: tipo === 'juros' ? 'Pagamento de juros registrado' : 'Empréstimo quitado',
    });
    await runAsync(dbHandle, 'COMMIT');
    return { pagamentoId: Number(pagamento.lastID), updates, action };
  } catch (error) {
    await runAsync(dbHandle, 'ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function executarPagamentoJuros(input, options) {
  return executarPagamentoLegadoComAcao({ ...input, tipo: 'juros', acaoTipo: 'JUROS_REGISTRADOS' }, options);
}

async function executarQuitacao(input, options) {
  return executarPagamentoLegadoComAcao({ ...input, tipo: 'quitar', acaoTipo: 'EMPRESTIMO_QUITADO' }, options);
}

async function executarJurosParciais({
  emprestimoId, valor, data, proximoVencimento, observacaoParcela = '', parcelaOrigem = null,
}, { dbHandle = db } = {}) {
  await ensureActionContractReady(dbHandle);
  await runAsync(dbHandle, 'BEGIN IMMEDIATE');
  try {
    const emprestimo = await getAsync(dbHandle, 'SELECT * FROM emprestimos WHERE id = ?', [emprestimoId]);
    if (!emprestimo) throw new Error('Empréstimo não encontrado');
    const antes = await capturarEstadoEmprestimo(emprestimoId, { dbHandle });
    const resultado = await pagarJurosParcial(
      emprestimoId, valor, data, observacaoParcela, proximoVencimento,
      { dbHandle, manageTransaction: false }
    );
    const parcela = resultado?.parcelaAtualizada?.id
      ? await getAsync(dbHandle, 'SELECT * FROM parcelas WHERE id = ?', [resultado.parcelaAtualizada.id])
      : null;
    await anexarObservacaoJurosParciais(dbHandle, parcela?.id, observacaoParcela, data);
    const pagamento = await runAsync(dbHandle, `INSERT INTO pagamentos
      (emprestimo_id, valor, data, tipo_pagamento, observacao, parcela_origem)
      VALUES (?, ?, ?, 'manual_juros_parcial', ?, ?)`, [
      emprestimoId, valor, data, 'Pagamento manual de juros parcial', parcelaOrigem,
    ]);
    await registrarEntradaPagamento({
      emprestimo_id: emprestimoId, parcela_id: parcela?.id || null,
      parcela_numero: parcela?.numero || null, data_vencimento: parcela?.vencimento || null,
      data, data_pagamento: data, valor_total: valor, valor_juros: valor, valor_capital: 0,
      descricao: 'Pagou menos que os juros.',
      meta: { origem: '/pagamentos/manual-juros-parcial', pagamento_id: pagamento.lastID, tipo_pagamento: 'manual_juros_parcial', parcela_origem: parcelaOrigem },
    }, dbHandle);
    await touchAtividade({ emprestimoId, dbHandle, strict: true });
    const action = await concluirAcao({
      dbHandle, tipo: 'JUROS_PARCIAIS_REGISTRADOS', emprestimoId, clienteId: emprestimo.cliente_id, antes,
      parametros: {
        valor: toMoney(valor), data_pagamento: data, proximo_vencimento: proximoVencimento,
        parcela_origem: parcelaOrigem, observacao_parcela: observacaoParcela || null,
        tipo_pagamento: 'manual_juros_parcial',
      },
      resumo: 'Pagamento parcial de juros registrado',
    });
    await runAsync(dbHandle, 'COMMIT');
    return { pagamentoId: Number(pagamento.lastID), resultado, action };
  } catch (error) {
    await runAsync(dbHandle, 'ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function executarPagamentoNormal({ emprestimoId, valor, data, observacao = '', parcelaOrigem = null }, { dbHandle = db } = {}) {
  await ensureActionContractReady(dbHandle);
  await runAsync(dbHandle, 'BEGIN IMMEDIATE');
  try {
    const emprestimo = await getAsync(dbHandle, 'SELECT * FROM emprestimos WHERE id = ?', [emprestimoId]);
    if (!emprestimo) throw new Error('Empréstimo não encontrado');
    const antes = await capturarEstadoEmprestimo(emprestimoId, { dbHandle });
    const pagamento = await runAsync(dbHandle, `INSERT INTO pagamentos
      (emprestimo_id, valor, data, tipo_pagamento, observacao, parcela_origem)
      VALUES (?, ?, ?, 'normal', ?, ?)`, [emprestimoId, valor, data, observacao, parcelaOrigem]);
    if (emprestimo.modalidade !== 'parcelado') {
      await registrarEntradaPagamento({
        emprestimo_id: emprestimoId, data, data_pagamento: data,
        valor_total: valor, valor_juros: 0, valor_capital: valor,
        descricao: 'Pagamento registrado.',
        meta: { origem: '/pagamentos', pagamento_id: pagamento.lastID, tipo_pagamento: 'normal', observacao: observacao || null, parcela_origem: parcelaOrigem },
      }, dbHandle);
      await touchAtividade({ emprestimoId, dbHandle, strict: true });
      const action = await concluirAcao({
        dbHandle, tipo: 'PAGAMENTO_NORMAL_REGISTRADO', emprestimoId, clienteId: emprestimo.cliente_id, antes,
        parametros: { valor: toMoney(valor), data_pagamento: data, observacao: observacao || null, parcela_origem: parcelaOrigem, tipo_pagamento: 'normal' },
        resumo: 'Pagamento normal registrado',
      });
      await runAsync(dbHandle, 'COMMIT');
      return { pagamentoId: Number(pagamento.lastID), updates: [], action };
    }
    const parcelas = await carregarParcelasAtuais(dbHandle, emprestimoId);
    const atualIndex = parcelas.findIndex((parcela) => !parcela.pago);
    if (atualIndex < 0) throw new Error('Nenhuma parcela pendente.');
    const updates = aplicarPagamentoNormal(parcelas, atualIndex, valor, data, observacao);
    await aplicarAtualizacoesNormais(dbHandle, updates, { data, observacao, tipoPagamento: 'normal' });
    const referencia = resolveParcelaReferencia(parcelas, updates, parcelaOrigem);
    const split = splitNormal(parcelas[atualIndex], valor);
    await registrarEntradaPagamento({
      emprestimo_id: emprestimoId, parcela_id: referencia?.id || null,
      parcela_numero: referencia?.numero || null, data_vencimento: referencia?.vencimento || null,
      data, data_pagamento: data, valor_total: valor, valor_juros: split.juros, valor_capital: split.capital,
      descricao: 'Pagou a parcela inteira.',
      meta: { origem: '/pagamentos', pagamento_id: pagamento.lastID, tipo_pagamento: 'normal', observacao: observacao || null, parcela_origem: parcelaOrigem, parcelas_atualizadas: updates.length },
    }, dbHandle);
    await touchAtividade({ emprestimoId, dbHandle, strict: true });
    const action = await concluirAcao({
      dbHandle, tipo: 'PAGAMENTO_NORMAL_REGISTRADO', emprestimoId, clienteId: emprestimo.cliente_id, antes,
      parametros: { valor: toMoney(valor), data_pagamento: data, observacao: observacao || null, parcela_origem: parcelaOrigem, tipo_pagamento: 'normal' },
      resumo: 'Pagamento normal registrado',
    });
    await runAsync(dbHandle, 'COMMIT');
    return { pagamentoId: Number(pagamento.lastID), updates, action };
  } catch (error) {
    await runAsync(dbHandle, 'ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function executarPagamentoManual({ emprestimoId, valor, abatimentos, data, observacao = 'Pagamento manual registrado via modal', observacaoParcela = '', parcelaOrigem = null }, { dbHandle = db } = {}) {
  await ensureActionContractReady(dbHandle);
  await runAsync(dbHandle, 'BEGIN IMMEDIATE');
  try {
    const emprestimo = await getAsync(dbHandle, 'SELECT * FROM emprestimos WHERE id = ?', [emprestimoId]);
    if (!emprestimo) throw new Error('Empréstimo não encontrado');
    const antes = await capturarEstadoEmprestimo(emprestimoId, { dbHandle });
    const ids = [...new Set((abatimentos || []).map((item) => Number(item?.parcelaId || item?.id || 0)).filter(Boolean))];
    const marks = ids.map(() => '?').join(', ');
    const parcelasAntes = ids.length ? await allAsync(dbHandle, `SELECT * FROM parcelas WHERE emprestimo_id = ? AND id IN (${marks})`, [emprestimoId, ...ids]) : [];
    const resultado = await aplicarPagamentoManual(emprestimoId, Number(valor), abatimentos, data, { dbHandle, manageTransaction: false });
    const referencia = resolveParcelaReferencia(parcelasAntes, resultado.parcelasAtualizadas, parcelaOrigem);
    const primeira = (resultado.parcelasAtualizadas || []).find((parcela) => parcela?.id);
    await anexarObservacaoManual(dbHandle, primeira?.id, observacaoParcela);
    const pagamento = await runAsync(dbHandle, `INSERT INTO pagamentos
      (emprestimo_id, valor, data, tipo_pagamento, observacao, parcela_origem)
      VALUES (?, ?, ?, 'manual', ?, ?)`, [emprestimoId, valor, data, observacao, parcelaOrigem]);
    const split = splitManual(parcelasAntes, resultado.parcelasAtualizadas, valor, referencia);
    await registrarEntradaPagamento({
      emprestimo_id: emprestimoId, parcela_id: referencia?.id || null,
      parcela_numero: referencia?.numero || null, data_vencimento: referencia?.vencimento || null,
      data, data_pagamento: data, valor_total: valor, valor_juros: split.juros, valor_capital: split.capital,
      descricao: descricaoManual(referencia, valor),
      meta: { origem: '/pagamentos/manual', pagamento_id: pagamento.lastID, tipo_pagamento: 'manual', observacao: observacao || null, parcela_origem: parcelaOrigem, abatimentos: Array.isArray(abatimentos) ? abatimentos.length : 0 },
    }, dbHandle);
    await touchAtividade({ emprestimoId, dbHandle, strict: true });
    const action = await concluirAcao({
      dbHandle, tipo: 'PAGAMENTO_MANUAL_REGISTRADO', emprestimoId, clienteId: emprestimo.cliente_id, antes,
      parametros: { valor: toMoney(valor), data_pagamento: data, observacao: observacao || null, observacao_parcela: observacaoParcela || null, parcela_origem: parcelaOrigem, tipo_pagamento: 'manual', abatimentos: abatimentos || [] },
      resumo: 'Pagamento manual registrado',
    });
    await runAsync(dbHandle, 'COMMIT');
    return { pagamentoId: Number(pagamento.lastID), saldoRestante: resultado.saldoRestante, parcelasAtualizadas: resultado.parcelasAtualizadas, action };
  } catch (error) {
    await runAsync(dbHandle, 'ROLLBACK').catch(() => undefined);
    throw error;
  }
}

module.exports = {
  executarPagamentoNormal,
  executarPagamentoManual,
  executarPagamentoJuros,
  executarJurosParciais,
  executarQuitacao,
};
