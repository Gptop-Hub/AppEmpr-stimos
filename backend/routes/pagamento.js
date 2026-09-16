const express = require('express');
const router = express.Router();
const db = require('../models/database');
const { parseToDate } = require('../services/dateUtils');

const aplicarPagamentoNormal = require('../utils/pagamento_comum');
const aplicarDescontoProxima = require('../utils/desconto_proxima');
const aplicarPagamentoManual = require('../utils/pagamento_manual');
const aplicarPagamentoJuros = require('../utils/pagamento_juros');
const aplicarQuitarEmprestimo = require('../utils/quitar_emprestimo');
const { touchAtividade } = require('../utils/touchAtividade');
const { registrarEntradaPagamento } = require('../services/caixaService');
const { splitNormalPaymentFromParcela } = require('../services/pagamentos/paymentSplit');

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function f2(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function toMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? f2(n) : 0;
}

function parcelaJurosTotal(parcela) {
  if (!parcela) return 0;
  return f2(
    toMoney(parcela.valor_juros) +
      toMoney(parcela.juros_pendentes) +
      toMoney(parcela.juros_adicionais)
  );
}

function splitJurosCapitalFromParcela(parcela, valorTotal) {
  return splitNormalPaymentFromParcela(parcela, valorTotal);
}

function buildParcelaMapById(parcelas = []) {
  const map = new Map();
  for (const item of parcelas || []) {
    if (!item || item.id == null) continue;
    map.set(Number(item.id), item);
  }
  return map;
}

function resolveParcelaReferencia({
  cronogramaAtual = [],
  updates = [],
  atualIndex = -1,
  parcelaOrigem = null,
}) {
  if (Number.isFinite(Number(parcelaOrigem))) {
    const numero = Number(parcelaOrigem) + 1;
    const byNumero = (cronogramaAtual || []).find(
      (parcela) => Number(parcela && parcela.numero) === numero
    );
    if (byNumero) {
      return {
        id: byNumero.id != null ? Number(byNumero.id) : null,
        numero,
        vencimento: byNumero.vencimento || null,
      };
    }
  }

  const firstUpdate = Array.isArray(updates) ? updates.find((item) => item && item.id != null) : null;
  if (firstUpdate) {
    const before = (cronogramaAtual || []).find((item) => Number(item && item.id) === Number(firstUpdate.id));
    return {
      id: Number(firstUpdate.id),
      numero: before && before.numero != null ? Number(before.numero) : null,
      vencimento: (before && before.vencimento) || firstUpdate.vencimento || null,
    };
  }

  if (atualIndex >= 0 && cronogramaAtual[atualIndex]) {
    const parcela = cronogramaAtual[atualIndex];
    return {
      id: parcela.id != null ? Number(parcela.id) : null,
      numero: parcela.numero != null ? Number(parcela.numero) : null,
      vencimento: parcela.vencimento || null,
    };
  }

  return {
    id: null,
    numero: null,
    vencimento: null,
  };
}

function computeManualDeltaSplit({
  parcelasAntes = [],
  parcelasDepois = [],
  valorPagamento = 0,
  parcelaFallback = null,
}) {
  const beforeMap = buildParcelaMapById(parcelasAntes);
  let jurosAplicado = 0;
  let capitalAplicado = 0;

  for (const after of parcelasDepois || []) {
    if (!after || after.id == null) continue;
    const before = beforeMap.get(Number(after.id));
    if (!before) continue;

    const jurosAntes = parcelaJurosTotal(before);
    const jurosDepois = parcelaJurosTotal(after);
    jurosAplicado += Math.max(0, f2(jurosAntes - jurosDepois));

    const capitalAntes = toMoney(before.valor_capital);
    const capitalDepois = toMoney(after.valor_capital);
    capitalAplicado += Math.max(0, f2(capitalAntes - capitalDepois));
  }

  const valor = toMoney(valorPagamento);
  jurosAplicado = Math.min(valor, f2(jurosAplicado));

  if (jurosAplicado <= 0 && capitalAplicado <= 0) {
    return splitJurosCapitalFromParcela(parcelaFallback, valor);
  }

  const capitalRestante = Math.max(0, f2(valor - jurosAplicado));
  const capitalFinal = capitalAplicado > 0
    ? Math.min(capitalRestante, f2(capitalAplicado))
    : capitalRestante;

  return {
    juros: f2(jurosAplicado),
    capital: f2(Math.max(0, capitalFinal)),
  };
}

function calcularSplitPagamento({
  tipoPagamento,
  valorPagamento,
  cronogramaAtual = [],
  atualIndex = -1,
  updates = [],
}) {
  const valor = toMoney(valorPagamento);
  const parcelaAtual = atualIndex >= 0 ? cronogramaAtual[atualIndex] : null;

  if (tipoPagamento === 'juros' || tipoPagamento === 'manual_juros_parcial') {
    return { juros: valor, capital: 0 };
  }

  if (tipoPagamento === 'quitar') {
    const juros = Math.min(valor, toMoney(parcelaAtual && parcelaAtual.valor_juros));
    return {
      juros: f2(juros),
      capital: f2(Math.max(0, valor - juros)),
    };
  }

  if (tipoPagamento === 'manual') {
    return computeManualDeltaSplit({
      parcelasAntes: cronogramaAtual,
      parcelasDepois: updates,
      valorPagamento: valor,
      parcelaFallback: parcelaAtual,
    });
  }

  return splitJurosCapitalFromParcela(parcelaAtual, valor);
}

function getParcelaTotalReferencia(parcela) {
  if (!parcela) return 0;
  const total = toMoney(parcela.valor_total);
  if (total > 0) return total;
  return f2(toMoney(parcela.valor_capital) + parcelaJurosTotal(parcela));
}

function findParcelaByReference(parcelas = [], referencia = {}) {
  const idRef = referencia && referencia.id != null ? Number(referencia.id) : null;
  if (Number.isFinite(idRef)) {
    const byId = (parcelas || []).find((item) => Number(item && item.id) === idRef);
    if (byId) return byId;
  }

  const numeroRef =
    referencia && referencia.numero != null ? Number(referencia.numero) : null;
  if (Number.isFinite(numeroRef)) {
    const byNumero = (parcelas || []).find(
      (item) => Number(item && item.numero) === numeroRef
    );
    if (byNumero) return byNumero;
  }

  return (parcelas && parcelas.length > 0) ? parcelas[0] : null;
}

function buildDescricaoFluxoPagamento({
  tipoPagamento,
  valorPagamento = 0,
  parcelaReferencia = null,
}) {
  const tipo = String(tipoPagamento || '').trim().toLowerCase();
  const valor = toMoney(valorPagamento);
  const margem = 0.01;

  if (tipo === 'normal' || tipo === 'comum') return 'Pagou a parcela inteira.';
  if (tipo === 'juros' || tipo === 'pagamento_juros') return 'Pagou somente os juros.';
  if (tipo === 'quitar' || tipo === 'quitacao' || tipo === 'quitação') {
    return 'Quitou completamente o empréstimo.';
  }
  if (
    tipo === 'manual_juros_parcial' ||
    tipo === 'juros_parcial' ||
    tipo === 'somente_juros'
  ) {
    return 'Pagou menos que os juros.';
  }
  if (tipo !== 'manual') return 'Pagamento registrado.';

  const jurosReferencia = parcelaJurosTotal(parcelaReferencia);
  const totalParcelaReferencia = getParcelaTotalReferencia(parcelaReferencia);

  if (jurosReferencia > 0 && valor < jurosReferencia - margem) {
    return 'Pagou menos que os juros.';
  }
  if (jurosReferencia > 0 && Math.abs(valor - jurosReferencia) <= margem) {
    return 'Pagou somente os juros.';
  }
  if (
    jurosReferencia > 0 &&
    totalParcelaReferencia > jurosReferencia + margem &&
    valor > jurosReferencia + margem &&
    valor < totalParcelaReferencia - margem
  ) {
    return 'Pagou mais que os juros, porém menos que o valor da parcela.';
  }
  if (totalParcelaReferencia > 0 && Math.abs(valor - totalParcelaReferencia) <= margem) {
    return 'Pagou a parcela inteira.';
  }
  if (totalParcelaReferencia > 0 && valor > totalParcelaReferencia + margem) {
    return 'Pagou mais que o valor da parcela.';
  }

  return 'Pagamento manual registrado.';
}

async function registrarEntradaPagamentoSafe(payload, contextLabel = 'pagamento') {
  try {
    await registrarEntradaPagamento(payload);
  } catch (err) {
    console.error(`[caixa] falha ao registrar entrada (${contextLabel}):`, err);
  }
}

async function carregarParcelasPorIds(emprestimoId, parcelaIds = []) {
  const ids = [...new Set((parcelaIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(', ');
  return allAsync(
    `SELECT *
       FROM parcelas
      WHERE emprestimo_id = ?
        AND id IN (${marks})`,
    [Number(emprestimoId), ...ids]
  );
}

async function logLastActivityAt(phase, emprestimoId) {
  if (!emprestimoId) return { clienteId: null };
  const emprestimoRow = await getAsync(
    'SELECT id, cliente_id, last_activity_at FROM emprestimos WHERE id = ?',
    [emprestimoId]
  );
  const empTs = emprestimoRow ? emprestimoRow.last_activity_at : null;
  console.log(
    `[touchAtividade] ${phase} emprestimo id=${emprestimoId} last_activity_at=`,
    empTs
  );

  const clienteId = emprestimoRow && emprestimoRow.cliente_id ? emprestimoRow.cliente_id : null;
  if (clienteId) {
    const clienteRow = await getAsync(
      'SELECT id, last_activity_at FROM clientes WHERE id = ?',
      [clienteId]
    );
    const clienteTs = clienteRow ? clienteRow.last_activity_at : null;
    console.log(
      `[touchAtividade] ${phase} cliente id=${clienteId} last_activity_at=`,
      clienteTs
    );
  }

  return { clienteId };
}

async function runTouchWithLogs(context, emprestimoId) {
  try {
    await logLastActivityAt(`${context} before`, emprestimoId);
  } catch (logErr) {
    console.error(`[touchAtividade] ${context} before log error:`, logErr);
  }

  try {
    await touchAtividade({ emprestimoId });
  } catch (touchErr) {
    console.error(`[touchAtividade] ${context}:`, touchErr);
  }

  try {
    await logLastActivityAt(`${context} after`, emprestimoId);
  } catch (logErr) {
    console.error(`[touchAtividade] ${context} after log error:`, logErr);
  }
}

// -------------------- helpers de data/labels --------------------
const mesesNome = [
  "Janeiro","Fevereiro","Março","Abril","Maio","Junho",
  "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"
];

function formatIsoToDDMonthYYYY(iso) {
  try {
    const d = parseToDate(iso);
    if (!d || isNaN(d.getTime())) return iso;
    const dd = String(d.getDate()).padStart(2, '0');
    const mmName = mesesNome[d.getMonth()];
    const yyyy = d.getFullYear();
    return `${dd} ${mmName} ${yyyy}`;
  } catch {
    return iso;
  }
}

function tipoLabel(tipo) {
  if (!tipo) return 'comum';
  if (tipo === 'normal') return 'comum';
  if (tipo === 'juros') return 'juros';
  if (tipo === 'manual') return 'manual';
  if (tipo === 'desconto_proxima') return 'desconto na próxima';
  if (tipo === 'quitar') return 'quitar';
  return tipo;
}

// YYYY-MM-DD local (sem timezone) para salvar como TEXT no SQLite
function toLocalISODateOnly(input) {
  const d = input ? parseToDate(input) : new Date();
  if (!d || isNaN(d.getTime())) {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// 🔵 helper para anexar observação do usuário na 1ª parcela afetada
function anexarObservacaoManual(parcelaId, textoObs, dataPagamentoISO) {
  return new Promise((resolve, reject) => {
    if (!parcelaId || !textoObs) return resolve();

    const dataFormatada = formatIsoToDDMonthYYYY(dataPagamentoISO);
    const nota = `${textoObs} — manual · ${dataFormatada}`;

    db.get('SELECT observacao FROM parcelas WHERE id = ?', [parcelaId], (err, row) => {
      if (err) {
        console.error('[ERRO] Ler observação da parcela (manual):', err);
        return reject(err);
      }

      const existente = row && row.observacao ? String(row.observacao) : '';
      const merged = existente ? `${existente}\n${nota}` : nota;

      db.run(
        'UPDATE parcelas SET observacao = ? WHERE id = ?',
        [merged, parcelaId],
        (err2) => {
          if (err2) {
            console.error('[ERRO] Atualizar observação da parcela (manual):', err2);
            return reject(err2);
          }
          resolve();
        }
      );
    });
  });
}

// -------------------- GET /pagamentos --------------------
router.get('/', (req, res) => {
  db.all(
    `SELECT p.*, e.valor AS valor_emprestimo, e.modalidade
       FROM pagamentos p
       JOIN emprestimos e ON e.id = p.emprestimo_id`,
    (err, rows) => {
      if (err) {
        console.error('[ERRO] GET /pagamentos:', err);
        return res.status(500).json({ erro: 'Erro ao listar pagamentos' });
      }
      res.json(rows || []);
    }
  );
});

// -------------------- POST /pagamentos --------------------
router.post('/', async (req, res) => {
  const {
    emprestimo_id,
    valor,
    tipoPagamento = 'normal',
    observacao = '',
    abatimentos,
    data: dataBody,
    dataPagamento: dataPagamentoBody,
    parcela_numero: parcelaNumeroBody,
    parcela_origem: parcelaOrigemBody,
  } = req.body || {};

  console.log('[DEBUG] /pagamentos payload:', {
    emprestimo_id, valor, tipoPagamento,
    hasAbatimentos: Array.isArray(abatimentos),
    dataBody, dataPagamentoBody
  });

  if (!emprestimo_id || !valor) {
    return res.status(400).json({ erro: 'emprestimo_id e valor são obrigatórios.' });
  }

  const data = toLocalISODateOnly(dataBody || dataPagamentoBody);
  const valorPagamentoNum = toMoney(valor);

  // Normaliza parcela_origem (0-based)
  let parcela_origem = null;
  if (parcelaNumeroBody != null && parcelaNumeroBody !== '') {
    const n = Number(parcelaNumeroBody);
    if (Number.isFinite(n)) parcela_origem = Math.max(0, Math.trunc(n - 1));
  } else if (parcelaOrigemBody != null && parcelaOrigemBody !== '') {
    const n = Number(parcelaOrigemBody);
    if (Number.isFinite(n)) parcela_origem = Math.max(0, Math.trunc(n));
  }

  // Confirma modalidade
  db.get('SELECT modalidade FROM emprestimos WHERE id = ?', [emprestimo_id], (err, emprestimo) => {
    if (err || !emprestimo) {
      console.error('[ERRO] Buscar empréstimo:', err);
      return res.status(500).json({ erro: 'Erro ao buscar empréstimo' });
    }

    // Se veio "manual" sem abatimentos, avisar o front para abrir a modal
    if (tipoPagamento === 'manual' && (!Array.isArray(abatimentos) || abatimentos.length === 0)) {
      return res.status(400).json({
        needModal: true,
        message:
          'Pagamento manual requer lista de abatimentos. Abra a modal e envie para /pagamentos/manual ou reenvie aqui com abatimentos.'
      });
    }

    // Registra o pagamento (log) na tabela pagamentos
    db.run(
      'INSERT INTO pagamentos (emprestimo_id, valor, data, tipo_pagamento, observacao, parcela_origem) VALUES (?, ?, ?, ?, ?, ?)',
      [emprestimo_id, valor, data, tipoPagamento, observacao, parcela_origem],
      async function (errIns) {
        if (errIns) {
          console.error('[ERRO] Inserção de pagamento:', errIns);
          return res.status(500).json({ erro: 'Erro ao registrar pagamento' });
        }

        const pagamentoId = this.lastID;

        // Se não for parcelado, terminou
        if (emprestimo.modalidade !== 'parcelado') {
          const descricaoFluxo = buildDescricaoFluxoPagamento({
            tipoPagamento,
            valorPagamento: valorPagamentoNum,
            parcelaReferencia: null,
          });
          await registrarEntradaPagamentoSafe(
            {
              emprestimo_id,
              data,
              data_pagamento: data,
              valor_total: valorPagamentoNum,
              valor_juros: 0,
              valor_capital: valorPagamentoNum,
              descricao: descricaoFluxo,
              meta: {
                origem: '/pagamentos',
                pagamento_id: pagamentoId,
                tipo_pagamento: tipoPagamento || null,
                observacao: observacao || null,
                parcela_origem,
              },
            },
            'pagamento-nao-parcelado'
          );
          await runTouchWithLogs('pagamento/nao-parcelado', emprestimo_id);
          return res.json({
            id: pagamentoId,
            emprestimo_id,
            valor,
            data,
            info: 'Pagamento registrado (empréstimo em aberto).'
          });
        }

        // Carrega somente as parcelas atuais (cronograma vigente)
        db.all(
          `SELECT p.*
             FROM parcelas p
             JOIN emprestimos e ON e.id = p.emprestimo_id
            WHERE p.emprestimo_id = ?
              AND (p.versao IS NULL OR p.versao = e.versao_atual)
            ORDER BY p.numero ASC`,
          [emprestimo_id],
          async (errParc, parcelas) => {
            if (errParc) {
              console.error('[ERRO] Buscar parcelas:', errParc);
              return res.status(500).json({ erro: 'Erro ao buscar parcelas' });
            }

            const cronogramaAtual = parcelas || [];
            const atualIndex = cronogramaAtual.findIndex((p) => !p.pago);
            const parcelaAtual = atualIndex >= 0 ? cronogramaAtual[atualIndex] : null;
            if (atualIndex === -1) {
              const descricaoFluxo = buildDescricaoFluxoPagamento({
                tipoPagamento,
                valorPagamento: valorPagamentoNum,
                parcelaReferencia: null,
              });
              await registrarEntradaPagamentoSafe(
                {
                  emprestimo_id,
                  data,
                  data_pagamento: data,
                  valor_total: valorPagamentoNum,
                  valor_juros: 0,
                  valor_capital: valorPagamentoNum,
                  descricao: descricaoFluxo,
                  meta: {
                    origem: '/pagamentos',
                    pagamento_id: pagamentoId,
                    tipo_pagamento: tipoPagamento || null,
                    observacao: observacao || null,
                    parcela_origem,
                    info: 'sem_parcelas_pendentes',
                  },
                },
                'pagamento-sem-pendente'
              );
              return res.json({
                id: pagamentoId,
                emprestimo_id,
                valor,
                data,
                info: 'Nenhuma parcela pendente.'
              });
            }

            let updates = [];
            try {
              if (tipoPagamento === 'desconto_proxima') {
                updates = await aplicarDescontoProxima(
                  cronogramaAtual,
                  atualIndex,
                  valor,
                  data,
                  observacao
                );
              } else if (tipoPagamento === 'manual') {
                const resp = await aplicarPagamentoManual(
                  emprestimo_id,
                  Number(valor),
                  abatimentos,
                  data
                );
                updates = resp.parcelasAtualizadas || [];
              } else if (tipoPagamento === 'juros') {
                updates = await aplicarPagamentoJuros(
                  cronogramaAtual,
                  atualIndex,
                  valor,
                  data,
                  observacao
                );
              } else if (tipoPagamento === 'quitar') {
                updates = await aplicarQuitarEmprestimo(
                  cronogramaAtual,
                  atualIndex,
                  Number(valor),
                  data,
                  observacao
                );
              } else {
                updates = aplicarPagamentoNormal(
                  cronogramaAtual,
                  atualIndex,
                  valor,
                  data,
                  observacao
                );
              }

              // Normaliza observações/explicações quando não for manual
              if (Array.isArray(updates) && updates.length > 0 && tipoPagamento !== 'manual') {
                updates[0].valor_pago = Number(
                  Number(updates[0].valor_pago || 0).toFixed(2)
                );
                if (!updates[0].observacao) {
                  updates[0].observacao = observacao || updates[0].observacao || '';
                }
                updates.forEach((u) => {
                  if (!Object.prototype.hasOwnProperty.call(u, 'explicacao')) {
                    u.explicacao = null;
                  }
                });
              }
            } catch (procErr) {
              console.error(`[ERRO] Processar tipoPagamento=${tipoPagamento}:`, procErr);
              const message =
                (procErr && procErr.message) || 'Erro ao processar pagamento';
              return res.status(400).json({ erro: message });
            }

            console.log(
              '[DEBUG] Updates gerados:',
              (updates || []).map((u) => ({
                id: u.id,
                valor_pago: u.valor_pago,
                valor_excedente: u.valor_excedente,
                valor_total: u.valor_total,
                vencimento: u.vencimento,
                explicacao: u.explicacao
              }))
            );

            // Aplica updates 1 a 1 (mantendo observações existentes + sufixo tipo/data)
            const splitPagamento = calcularSplitPagamento({
              tipoPagamento,
              valorPagamento: valorPagamentoNum,
              cronogramaAtual,
              atualIndex,
              updates,
            });

            const parcelaReferencia = resolveParcelaReferencia({
              cronogramaAtual,
              updates,
              atualIndex,
              parcelaOrigem: parcela_origem,
            });
            const parcelaDescricaoRef =
              findParcelaByReference(cronogramaAtual, parcelaReferencia) || parcelaAtual;

            const aplicarUpdate = (i) => {
              if (i >= updates.length) {
                const finalizar = async () => {
                  const descricaoFluxo = buildDescricaoFluxoPagamento({
                    tipoPagamento,
                    valorPagamento: valorPagamentoNum,
                    parcelaReferencia: parcelaDescricaoRef,
                  });
                  await registrarEntradaPagamentoSafe(
                    {
                      emprestimo_id,
                      parcela_id: parcelaReferencia.id,
                      parcela_numero: parcelaReferencia.numero,
                      data_vencimento: parcelaReferencia.vencimento,
                      data,
                      data_pagamento: data,
                      valor_total: valorPagamentoNum,
                      valor_juros: splitPagamento.juros,
                      valor_capital: splitPagamento.capital,
                      descricao: descricaoFluxo,
                      meta: {
                        origem: '/pagamentos',
                        pagamento_id: pagamentoId,
                        tipo_pagamento: tipoPagamento || null,
                        observacao: observacao || null,
                        parcela_origem,
                        parcelas_atualizadas: updates.length,
                      },
                    },
                    'pagamento-principal'
                  );
                  await runTouchWithLogs('pagamento/parcelas', emprestimo_id);
                  return res.json({
                    id: pagamentoId,
                    emprestimo_id,
                    valor,
                    data,
                    info: `Parcelas atualizadas: ${updates.length}`
                  });
                };
                finalizar().catch((finalErr) => {
                  console.error('[touchAtividade] pagamento/parcelas finalize error:', finalErr);
                  return res.json({
                    id: pagamentoId,
                    emprestimo_id,
                    valor,
                    data,
                    info: `Parcelas atualizadas: ${updates.length}`
                  });
                });
                return;
              }

              const up = updates[i];

              db.get(
                'SELECT observacao FROM parcelas WHERE id = ?',
                [up.id],
                (readErr, rowObs) => {
                  if (readErr) {
                    console.error(
                      '[ERRO] Ler parcela antes de atualizar:',
                      readErr
                    );
                    return res
                      .status(500)
                      .json({ erro: 'Erro ao ler parcela antes de atualizar' });
                  }

                  const existingObs =
                    rowObs && rowObs.observacao
                      ? String(rowObs.observacao)
                      : '';

                  let candidateObs = null;
                  if (up.observacao && String(up.observacao).trim()) {
                    candidateObs = String(up.observacao).trim();
                  } else if (i === 0 && observacao && String(observacao).trim()) {
                    candidateObs = String(observacao).trim();
                  }

                  let mergedObservacao = existingObs;
                  if (candidateObs) {
                    const suffixParts = [];
                    if (tipoPagamento) suffixParts.push(tipoLabel(tipoPagamento));
                    if (data) suffixParts.push(formatIsoToDDMonthYYYY(data));
                    const suffix = suffixParts.length
                      ? ` — ${suffixParts.join(' · ')}`
                      : '';
                    const note = `${candidateObs}${suffix}`;
                    mergedObservacao = existingObs
                      ? `${existingObs}\n${note}`
                      : note;
                  }

                  const sql = `
                    UPDATE parcelas SET 
                      valor_pago        = COALESCE(?, valor_pago),
                      valor_excedente   = COALESCE(?, valor_excedente),
                      data_pagamento    = COALESCE(?, data_pagamento),
                      vencimento        = COALESCE(?, vencimento),
                      pago              = COALESCE(?, pago),
                      valor_total       = COALESCE(?, valor_total),
                      valor_capital     = COALESCE(?, valor_capital),
                      valor_juros       = COALESCE(?, valor_juros),
                      juros_pendentes   = COALESCE(?, juros_pendentes),
                      observacao        = COALESCE(?, observacao),
                      explicacao        = CASE WHEN ? IS NULL THEN explicacao ELSE ? END,
                      tipo_pagamento    = COALESCE(?, tipo_pagamento)
                    WHERE id = ?`;

                  const params = [
                    up.valor_pago ?? null,
                    up.valor_excedente ?? null,
                    up.data_pagamento ?? data ?? null,
                    up.vencimento ?? null,
                    up.pago ?? null,
                    up.valor_total ?? null,
                    up.valor_capital ?? null,
                    up.valor_juros ?? null,
                    up.juros_pendentes ?? null,
                    mergedObservacao ?? null,
                    up.explicacao ?? null,
                    up.explicacao ?? null,
                    up.tipo_pagamento ?? tipoPagamento ?? null,
                    up.id
                  ];

                  db.run(sql, params, (runErr) => {
                    if (runErr) {
                      console.error('[ERRO] Atualizar parcela:', runErr);
                      return res
                        .status(500)
                        .json({ erro: 'Erro ao atualizar parcela' });
                    }
                    aplicarUpdate(i + 1);
                  });
                }
              );
            };

            aplicarUpdate(0);
          }
        );
      }
    );
  });
});

// -------------------- POST /pagamentos/manual --------------------
router.post('/manual', async (req, res) => {
  const {
    emprestimoId,
    valorPagamento,
    abatimentos,
    data: dataBody,
    dataPagamento: dataPagamentoBody,
    observacao = 'Pagamento manual registrado via modal',
    observacaoParcela,
    parcela_numero: parcelaNumeroBody,
    parcela_origem: parcelaOrigemBody,
  } = req.body || {};

  if (!emprestimoId || typeof valorPagamento === 'undefined' || !Array.isArray(abatimentos)) {
    return res.status(400).json({ erro: 'Dados incompletos ou inválidos' });
  }

  const dataPagamento = toLocalISODateOnly(dataBody || dataPagamentoBody);
  let parcela_origem = null;
  if (parcelaNumeroBody != null && parcelaNumeroBody !== '') {
    const n = Number(parcelaNumeroBody);
    if (Number.isFinite(n)) parcela_origem = Math.max(0, Math.trunc(n - 1));
  } else if (parcelaOrigemBody != null && parcelaOrigemBody !== '') {
    const n = Number(parcelaOrigemBody);
    if (Number.isFinite(n)) parcela_origem = Math.max(0, Math.trunc(n));
  }

  try {
    const parcelaIdsAbatimento = (abatimentos || [])
      .map((item) => item && (item.parcelaId || item.id))
      .filter((id) => id != null);

    const parcelasAntesManual = await carregarParcelasPorIds(
      Number(emprestimoId),
      parcelaIdsAbatimento
    );

    const resultado = await aplicarPagamentoManual(
      Number(emprestimoId),
      Number(valorPagamento),
      abatimentos,
      dataPagamento
    );

    const splitManual = computeManualDeltaSplit({
      parcelasAntes: parcelasAntesManual,
      parcelasDepois: resultado.parcelasAtualizadas || [],
      valorPagamento: Number(valorPagamento),
      parcelaFallback: parcelasAntesManual[0] || null,
    });

    const parcelaManualRef = resolveParcelaReferencia({
      cronogramaAtual: parcelasAntesManual,
      updates: resultado.parcelasAtualizadas || [],
      atualIndex: 0,
      parcelaOrigem: parcela_origem,
    });
    const parcelaManualContext = findParcelaByReference(
      parcelasAntesManual,
      parcelaManualRef
    );
    const descricaoManualFluxo = buildDescricaoFluxoPagamento({
      tipoPagamento: 'manual',
      valorPagamento: Number(valorPagamento),
      parcelaReferencia: parcelaManualContext,
    });

    // 🔵 anexa observação do usuário na 1ª parcela atualizada
    const primeira = (resultado.parcelasAtualizadas || []).find((p) => p && p.id);
    if (primeira && observacaoParcela && observacaoParcela.trim()) {
      try {
        await anexarObservacaoManual(primeira.id, observacaoParcela.trim(), dataPagamento);
      } catch (e) {
        console.error('[ERRO] anexarObservacaoManual:', e);
      }
    }

    // log na tabela pagamentos
    db.run(
      `INSERT INTO pagamentos (emprestimo_id, valor, data, tipo_pagamento, observacao, parcela_origem)
         VALUES (?, ?, ?, ?, ?, ?)`,
      [emprestimoId, valorPagamento, dataPagamento, 'manual', observacao, parcela_origem],
      async function (err) {
        if (err) {
          console.error('[ERRO] Registrar pagamento/manual:', err);
          return res.status(500).json({ erro: 'Erro ao registrar pagamento manual' });
        }

        await registrarEntradaPagamentoSafe(
          {
            emprestimo_id: Number(emprestimoId),
            parcela_id: parcelaManualRef.id,
            parcela_numero: parcelaManualRef.numero,
            data_vencimento: parcelaManualRef.vencimento,
            data: dataPagamento,
            data_pagamento: dataPagamento,
            valor_total: Number(valorPagamento),
            valor_juros: splitManual.juros,
            valor_capital: splitManual.capital,
            descricao: descricaoManualFluxo,
            meta: {
              origem: '/pagamentos/manual',
              pagamento_id: this.lastID,
              tipo_pagamento: 'manual',
              observacao: observacao || null,
              parcela_origem,
              abatimentos: Array.isArray(abatimentos) ? abatimentos.length : 0,
            },
          },
          'pagamento-manual'
        );

        await runTouchWithLogs('pagamento/manual', emprestimoId);
        res.json({
          pagamentoId: this.lastID,
          saldoRestante: resultado.saldoRestante,
          parcelasAtualizadas: resultado.parcelasAtualizadas
        });
      }
    );
  } catch (e) {
    console.error('[ERRO] pagamento_manual falhou:', e);
    res.status(500).json({ erro: 'Erro ao processar pagamento manual' });
  }
});

// -------------------- POST /pagamentos/manual-juros-parcial --------------------
const pagarJurosParcial = require('../utils/pagamento_juros_parcial');

router.post('/manual-juros-parcial', async (req, res) => {
  try {
    const {
      emprestimoId,
      valorPagamento,
      data: dataBody,
      dataPagamento: dataPagamentoBody,
      observacaoParcela = '',
      parcela_numero: parcelaNumeroBody,
      parcela_origem: parcelaOrigemBody,
    } = req.body || {};

    if (!emprestimoId || !valorPagamento) {
      return res.status(400).json({ erro: 'Dados incompletos.' });
    }

    // normaliza data para o mesmo formato usado no resto do sistema
    const dataPagamentoISO = toLocalISODateOnly(dataBody || dataPagamentoBody);
    let parcela_origem = null;
    if (parcelaNumeroBody != null && parcelaNumeroBody !== '') {
      const n = Number(parcelaNumeroBody);
      if (Number.isFinite(n)) parcela_origem = Math.max(0, Math.trunc(n - 1));
    } else if (parcelaOrigemBody != null && parcelaOrigemBody !== '') {
      const n = Number(parcelaOrigemBody);
      if (Number.isFinite(n)) parcela_origem = Math.max(0, Math.trunc(n));
    }

    const resp = await pagarJurosParcial(
      Number(emprestimoId),
      Number(valorPagamento),
      dataPagamentoISO,
      observacaoParcela
    );

    // 🔵 anexa observação do usuário na parcela afetada (igual fluxo /manual)
    const primeiraParcela = resp?.parcelaAtualizada;
    if (primeiraParcela && primeiraParcela.id && observacaoParcela && observacaoParcela.trim()) {
      try {
        await anexarObservacaoManual(
          primeiraParcela.id,
          observacaoParcela.trim(),
          dataPagamentoISO
        );
      } catch (e) {
        console.error('[ERRO] anexarObservacaoManual (juros parcial):', e);
      }
    }

    // registrar log em "pagamentos"
    db.run(
      `INSERT INTO pagamentos (emprestimo_id, valor, data, tipo_pagamento, observacao, parcela_origem)
         VALUES (?, ?, ?, ?, ?, ?)`,
      [
        emprestimoId,
        valorPagamento,
        dataPagamentoISO,
        'manual_juros_parcial',
        'Pagamento manual de juros parcial',
        parcela_origem
      ],
      async function (err) {
        if (err) {
          console.error('[ERRO] registrar log juros parcial:', err);
          return res.status(500).json({ erro: 'Erro ao registrar log de juros parcial.' });
        }

        let parcelaRef = { id: null, numero: null, vencimento: null };
        const parcelaIdAtualizada = resp?.parcelaAtualizada?.id;
        if (parcelaIdAtualizada) {
          const rowParcela = await getAsync(
            'SELECT id, numero, vencimento FROM parcelas WHERE id = ?',
            [parcelaIdAtualizada]
          ).catch(() => null);
          if (rowParcela) {
            parcelaRef = {
              id: Number(rowParcela.id),
              numero: rowParcela.numero != null ? Number(rowParcela.numero) : null,
              vencimento: rowParcela.vencimento || null,
            };
          }
        }

        await registrarEntradaPagamentoSafe(
          {
            emprestimo_id: Number(emprestimoId),
            parcela_id: parcelaRef.id,
            parcela_numero: parcelaRef.numero,
            data_vencimento: parcelaRef.vencimento,
            data: dataPagamentoISO,
            data_pagamento: dataPagamentoISO,
            valor_total: Number(valorPagamento),
            valor_juros: Number(valorPagamento),
            valor_capital: 0,
            descricao: buildDescricaoFluxoPagamento({
              tipoPagamento: 'manual_juros_parcial',
              valorPagamento: Number(valorPagamento),
              parcelaReferencia: null,
            }),
            meta: {
              origem: '/pagamentos/manual-juros-parcial',
              pagamento_id: this.lastID,
              tipo_pagamento: 'manual_juros_parcial',
              parcela_origem,
            },
          },
          'pagamento-manual-juros-parcial'
        );

        await runTouchWithLogs('pagamento/manual-juros-parcial', emprestimoId);
        res.json({
          ok: true,
          pagamentoId: this.lastID,
          ...resp
        });
      }
    );

  } catch (e) {
    console.error('[ERRO] /manual-juros-parcial:', e);
    res.status(400).json({ erro: e.message || 'Falha no juros parcial.' });
  }
});

module.exports = router;
