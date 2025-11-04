// routes/pagamentos.js
const express = require('express');
const router = express.Router();
const db = require('../models/database');

const aplicarPagamentoNormal = require('../utils/pagamento_comum');
const aplicarDescontoProxima = require('../utils/desconto_proxima');
const aplicarPagamentoManual = require('../utils/pagamento_manual');
const aplicarPagamentoJuros = require('../utils/pagamento_juros');
const aplicarQuitarEmprestimo = require('../utils/quitar_emprestimo'); // novo util

// meses (para formato com mês por extenso)
const mesesNome = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

// utilitária para formatar ISO -> "01 Outubro 2025"
const formatIsoToDDMonthYYYY = (iso) => {
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
};

const tipoLabel = (tipo) => {
  if (!tipo) return 'comum';
  if (tipo === 'normal') return 'comum';
  if (tipo === 'juros') return 'juros';
  if (tipo === 'manual') return 'manual';
  if (tipo === 'desconto_proxima') return 'desconto na próxima';
  if (tipo === 'quitar') return 'quitar';
  return tipo;
};

// GET /pagamentos
router.get('/', (req, res) => {
  db.all(
    `SELECT p.*, e.valor as valor_emprestimo, e.modalidade
     FROM pagamentos p 
     JOIN emprestimos e ON e.id = p.emprestimo_id`,
    (err, rows) => {
      if (err) {
        console.error('[ERRO] GET /pagamentos:', err);
        return res.status(500).json(err);
      }
      res.json(rows);
    }
  );
});

// POST /pagamentos
router.post('/', async (req, res) => {
  const {
    emprestimo_id,
    valor,
    tipoPagamento = 'normal',
    observacao = '',
    abatimentos,
    data: dataBody,
    dataPagamento: dataPagamentoBody
  } = req.body;

  console.log('[DEBUG] /pagamentos recebidos:', {
    emprestimo_id,
    valor,
    tipoPagamento,
    observacao,
    abatimentosPresent: Array.isArray(abatimentos),
    dataBody,
    dataPagamentoBody
  });

  // prioriza data enviada
  const data = (dataBody || dataPagamentoBody)
    ? new Date(dataBody || dataPagamentoBody).toISOString()
    : new Date().toISOString();

  db.get('SELECT modalidade FROM emprestimos WHERE id = ?', [emprestimo_id], (err, emprestimo) => {
    if (err || !emprestimo) {
      console.error('[ERRO] Erro ao buscar empréstimo:', err);
      return res.status(500).json({ erro: 'Erro interno ao buscar empréstimo' });
    }

    if (tipoPagamento === 'manual' && (!Array.isArray(abatimentos) || abatimentos.length === 0)) {
      return res.status(400).json({
        needModal: true,
        message: 'Pagamento manual requer lista de abatimentos. Abra modal no frontend e envie para /pagamentos/manual ou reenviar para /pagamentos com abatimentos.'
      });
    }

    db.run(
      'INSERT INTO pagamentos (emprestimo_id, valor, data, tipo_pagamento, observacao) VALUES (?, ?, ?, ?, ?)',
      [emprestimo_id, valor, data, tipoPagamento, observacao],
      async function (err) {
        if (err) {
          console.error('[ERRO] Inserção de pagamento falhou:', err);
          return res.status(500).json({ erro: 'Erro ao registrar pagamento' });
        }

        const pagamentoId = this.lastID;

        if (emprestimo.modalidade !== 'parcelado') {
          return res.json({
            id: pagamentoId,
            emprestimo_id,
            valor,
            data,
            info: 'Pagamento registrado para empréstimo em aberto'
          });
        }

        db.all(
          `SELECT * FROM parcelas 
           WHERE emprestimo_id = ? 
           ORDER BY numero ASC`,
          [emprestimo_id],
          async (err, parcelas) => {
            if (err) {
              console.error('[ERRO] Erro ao buscar parcelas:', err);
              return res.status(500).json({ erro: 'Erro ao buscar parcelas' });
            }

            db.all(
              `SELECT * FROM parcelas_originais WHERE emprestimo_id = ?`,
              [emprestimo_id],
              async (err2, parcelasOriginais) => {
                if (err2) {
                  console.error('[ERRO] Erro ao buscar parcelas_originais:', err2);
                  parcelasOriginais = [];
                }

                const enrichedParcelas = (parcelas || []).map(p => {
                  const orig = (parcelasOriginais || []).find(o => Number(o.numero) === Number(p.numero)) || {};
                  return {
                    ...p,
                    original_valor_juros: orig.valor_juros != null ? Number(orig.valor_juros) : null,
                    original_valor_capital: orig.valor_capital != null ? Number(orig.valor_capital) : null
                  };
                });

                const atualIndex = enrichedParcelas.findIndex(p => !p.pago);
                if (atualIndex === -1) {
                  return res.json({ id: pagamentoId, emprestimo_id, valor, data, info: 'Nenhuma parcela pendente.' });
                }

                let updates = [];

                try {
                  if (tipoPagamento === 'desconto_proxima') {
                    updates = await aplicarDescontoProxima(enrichedParcelas, atualIndex, valor, data, observacao);
                  } else if (tipoPagamento === 'manual') {
                    const resultado = await aplicarPagamentoManual(emprestimo_id, Number(valor), abatimentos, data);
                    updates = resultado.parcelasAtualizadas || [];
                  } else if (tipoPagamento === 'juros') {
                    updates = await aplicarPagamentoJuros(enrichedParcelas, atualIndex, valor, data, observacao);
                  } else if (tipoPagamento === 'quitar') {
                    // delega para o util que monta os updates e as mensagens de explicacao (EMPRESTIMO QUITADO / PARCELA FANTASMA)
                    updates = await aplicarQuitarEmprestimo(enrichedParcelas, atualIndex, Number(valor), data, observacao);
                  } else {
                    updates = aplicarPagamentoNormal(enrichedParcelas, atualIndex, valor, data, observacao);
                  }

                  if (Array.isArray(updates) && updates.length > 0 && tipoPagamento !== 'manual') {
                    updates[0].valor_pago = Number(Number(updates[0].valor_pago || 0).toFixed(2));
                    if (!updates[0].observacao) {
                      updates[0].observacao = observacao || updates[0].observacao || '';
                    }
                    updates.forEach(u => {
                      if (!Object.prototype.hasOwnProperty.call(u, 'explicacao')) {
                        u.explicacao = null;
                      }
                    });
                  }
                } catch (err) {
                  console.error(`[ERRO] Erro ao processar tipoPagamento ${tipoPagamento}:`, err);
                  const message = err && err.message ? err.message : 'Erro ao processar pagamento';
                  return res.status(400).json({ erro: message });
                }

                console.log('[DEBUG] Updates a aplicar:', (updates || []).map(u => ({
                  id: u.id,
                  valor_pago: u.valor_pago,
                  valor_excedente: u.valor_excedente,
                  valor_total: u.valor_total,
                  vencimento: u.vencimento,
                  explicacao: u.explicacao
                })));

                // aplica updates sequencialmente
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

                  // ler observacao atual da parcela
                  db.get('SELECT observacao FROM parcelas WHERE id = ?', [up.id], (errRead, row) => {
                    if (errRead) {
                      console.error('[ERRO] Falha ao ler parcela antes de atualizar:', errRead);
                      return res.status(500).json({ erro: 'Erro ao ler parcela antes de atualizar' });
                    }

                    const existingObs = (row && row.observacao) ? String(row.observacao) : '';

                    let candidateObs = null;
                    if (up.observacao && String(up.observacao).trim()) {
                      candidateObs = String(up.observacao).trim();
                    } else if (i === 0 && observacao && String(observacao).trim()) {
                      candidateObs = String(observacao).trim();
                    } else {
                      candidateObs = null;
                    }

                    let mergedObservacao = existingObs;
                    if (candidateObs) {
                      const suffixParts = [];
                      if (tipoPagamento) suffixParts.push(tipoLabel(tipoPagamento));
                      if (data) suffixParts.push(formatIsoToDDMonthYYYY(data));
                      const suffix = suffixParts.length ? ` — ${suffixParts.join(' · ')}` : '';
                      const note = `${candidateObs}${suffix}`;
                      mergedObservacao = existingObs ? `${existingObs}\n${note}` : note;
                    }

                    const sql = `
                      UPDATE parcelas SET 
                        valor_pago = COALESCE(?, valor_pago),
                        valor_excedente = COALESCE(?, valor_excedente),
                        data_pagamento = COALESCE(?, data_pagamento),
                        vencimento = COALESCE(?, vencimento),
                        pago = COALESCE(?, pago),
                        valor_total = COALESCE(?, valor_total),
                        valor_capital = COALESCE(?, valor_capital),
                        valor_juros = COALESCE(?, valor_juros),
                        observacao = COALESCE(?, observacao),
                        explicacao = CASE WHEN ? IS NULL THEN explicacao ELSE ? END,
                        tipo_pagamento = COALESCE(?, tipo_pagamento)
                      WHERE id = ?`;

                    const params = [
                      up.valor_pago,
                      up.valor_excedente,
                      up.data_pagamento,
                      up.vencimento,
                      up.pago,
                      up.valor_total,
                      up.valor_capital,
                      up.valor_juros,
                      mergedObservacao,
                      up.explicacao,
                      up.explicacao,
                      up.tipo_pagamento,
                      up.id
                    ];

                    console.log('[DEBUG] Aplicando update -> id:', up.id, 'params:', {
                      valor_pago: up.valor_pago,
                      valor_excedente: up.valor_excedente,
                      data_pagamento: up.data_pagamento,
                      vencimento: up.vencimento,
                      pago: up.pago,
                      valor_total: up.valor_total,
                      explicacao: up.explicacao,
                      observacao_before: existingObs ? existingObs.slice(0, 120) : '(vazia)',
                      observacao_after: (mergedObservacao ? mergedObservacao.slice(0, 120) : '(vazia)')
                    });

                    db.run(sql, params, (errRun) => {
                      if (errRun) {
                        console.error('[ERRO] Erro ao atualizar parcela:', errRun);
                        return res.status(500).json({ erro: 'Erro ao atualizar parcela' });
                      }
                      aplicarUpdate(i + 1);
                    });
                  });
                };

                aplicarUpdate(0);
              }
            );
          }
        );
      }
    );
  });
});

// POST /pagamentos/manual (mantido como antes)
router.post('/manual', async (req, res) => {
  const { emprestimoId, valorPagamento, abatimentos, data: dataBody, dataPagamento: dataPagamentoBody } = req.body;

  if (!emprestimoId || (typeof valorPagamento === 'undefined') || !Array.isArray(abatimentos)) {
    return res.status(400).json({ erro: 'Dados incompletos ou inválidos' });
  }

  const dataPagamento = (dataBody || dataPagamentoBody)
    ? new Date(dataBody || dataPagamentoBody).toISOString()
    : new Date().toISOString();

  try {
    const resultado = await aplicarPagamentoManual(emprestimoId, Number(valorPagamento), abatimentos, dataPagamento);

    const observacao = 'Pagamento manual registrado via modal';
    db.run(
      `INSERT INTO pagamentos (emprestimo_id, valor, data, tipo_pagamento, observacao) VALUES (?, ?, ?, ?, ?)`,
      [emprestimoId, valorPagamento, dataPagamento, 'manual', observacao],
      function(err) {
        if (err) {
          console.error('[ERRO] Falha ao registrar pagamento:', err);
          return res.status(500).json({ erro: 'Erro ao registrar pagamento' });
        }

        res.json({
          pagamentoId: this.lastID,
          saldoRestante: resultado.saldoRestante,
          parcelasAtualizadas: resultado.parcelasAtualizadas
        });
      }
    );
  } catch (err) {
    console.error('[ERRO] pagamento_manual falhou:', err);
    res.status(500).json({ erro: 'Erro ao processar pagamento manual' });
  }
});

module.exports = router;