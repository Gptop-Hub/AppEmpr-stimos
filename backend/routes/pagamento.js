// backend/routes/pagamento.js 
const express = require('express');
const router = express.Router();
const db = require('../models/database');

const aplicarPagamentoNormal = require('../utils/pagamento_comum');
const aplicarDescontoProxima = require('../utils/desconto_proxima');
const aplicarPagamentoManual = require('../utils/pagamento_manual');
const aplicarPagamentoJuros = require('../utils/pagamento_juros');
const aplicarQuitarEmprestimo = require('../utils/quitar_emprestimo');

// -------------------- helpers de data/labels --------------------
const mesesNome = [
  "Janeiro","Fevereiro","Março","Abril","Maio","Junho",
  "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"
];

function formatIsoToDDMonthYYYY(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
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
  const d = input ? new Date(input) : new Date();
  if (isNaN(d.getTime())) {
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
    dataPagamento: dataPagamentoBody
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
      'INSERT INTO pagamentos (emprestimo_id, valor, data, tipo_pagamento, observacao) VALUES (?, ?, ?, ?, ?)',
      [emprestimo_id, valor, data, tipoPagamento, observacao],
      function (errIns) {
        if (errIns) {
          console.error('[ERRO] Inserção de pagamento:', errIns);
          return res.status(500).json({ erro: 'Erro ao registrar pagamento' });
        }

        const pagamentoId = this.lastID;

        // Se não for parcelado, terminou
        if (emprestimo.modalidade !== 'parcelado') {
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
          `SELECT * FROM parcelas WHERE emprestimo_id = ? ORDER BY numero ASC`,
          [emprestimo_id],
          async (errParc, parcelas) => {
            if (errParc) {
              console.error('[ERRO] Buscar parcelas:', errParc);
              return res.status(500).json({ erro: 'Erro ao buscar parcelas' });
            }

            const cronogramaAtual = parcelas || [];
            const atualIndex = cronogramaAtual.findIndex((p) => !p.pago);
            if (atualIndex === -1) {
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
            const aplicarUpdate = (i) => {
              if (i >= updates.length) {
                return res.json({
                  id: pagamentoId,
                  emprestimo_id,
                  valor,
                  data,
                  info: `Parcelas atualizadas: ${updates.length}`
                });
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
                      valor_pago     = COALESCE(?, valor_pago),
                      valor_excedente= COALESCE(?, valor_excedente),
                      data_pagamento = COALESCE(?, data_pagamento),
                      vencimento     = COALESCE(?, vencimento),
                      pago           = COALESCE(?, pago),
                      valor_total    = COALESCE(?, valor_total),
                      valor_capital  = COALESCE(?, valor_capital),
                      valor_juros    = COALESCE(?, valor_juros),
                      observacao     = COALESCE(?, observacao),
                      explicacao     = CASE WHEN ? IS NULL THEN explicacao ELSE ? END,
                      tipo_pagamento = COALESCE(?, tipo_pagamento)
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
    observacaoParcela
  } = req.body || {};

  if (!emprestimoId || typeof valorPagamento === 'undefined' || !Array.isArray(abatimentos)) {
    return res.status(400).json({ erro: 'Dados incompletos ou inválidos' });
  }

  const dataPagamento = toLocalISODateOnly(dataBody || dataPagamentoBody);

  try {
    const resultado = await aplicarPagamentoManual(
      Number(emprestimoId),
      Number(valorPagamento),
      abatimentos,
      dataPagamento
    );

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
      `INSERT INTO pagamentos (emprestimo_id, valor, data, tipo_pagamento, observacao)
         VALUES (?, ?, ?, ?, ?)`,
      [emprestimoId, valorPagamento, dataPagamento, 'manual', observacao],
      function (err) {
        if (err) {
          console.error('[ERRO] Registrar pagamento/manual:', err);
          return res.status(500).json({ erro: 'Erro ao registrar pagamento manual' });
        }

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
      dataPagamento,
      observacaoParcela = ''
    } = req.body || {};

    if (!emprestimoId || !valorPagamento) {
      return res.status(400).json({ erro: 'Dados incompletos.' });
    }

    const resp = await pagarJurosParcial(
      Number(emprestimoId),
      Number(valorPagamento),
      dataPagamento,
      observacaoParcela
    );

    // registrar log em "pagamentos"
    db.run(
      `INSERT INTO pagamentos (emprestimo_id, valor, data, tipo_pagamento, observacao)
         VALUES (?, ?, ?, ?, ?)`,
      [
        emprestimoId,
        valorPagamento,
        dataPagamento,
        'manual_juros_parcial',
        'Pagamento manual de juros parcial'
      ],
      function (err) {
        if (err) {
          console.error('[ERRO] registrar log juros parcial:', err);
          return res.status(500).json({ erro: 'Erro ao registrar log de juros parcial.' });
        }

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
