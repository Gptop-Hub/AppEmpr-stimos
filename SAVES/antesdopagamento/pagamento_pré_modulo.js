const express = require('express');
const router = express.Router();
const db = require('../models/database');
const calcularAbateCapital = require('../utils/pagamento_abate_capital'); // import do módulo para abate de capital

// Buscar todos os pagamentos com dados do empréstimo
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

// Registrar novo pagamento
router.post('/', async (req, res) => {  // async para usar await
  const { emprestimo_id, valor, tipoPagamento = 'normal', observacao = '' } = req.body;

  // DEBUG: log do que chegou na rota
  console.log('[DEBUG] /pagamentos recebidos:', { emprestimo_id, valor, tipoPagamento, observacao });

  const data = new Date().toISOString();

  db.get('SELECT modalidade FROM emprestimos WHERE id = ?', [emprestimo_id], (err, emprestimo) => {
    if (err || !emprestimo) {
      console.error('[ERRO] Erro ao buscar empréstimo:', err);
      return res.status(500).json({ erro: 'Erro interno ao buscar empréstimo' });
    }

    db.run(
      'INSERT INTO pagamentos (emprestimo_id, valor, data, tipo_pagamento, observacao) VALUES (?, ?, ?, ?, ?)',
      [emprestimo_id, valor, data, tipoPagamento, observacao],
      async function (err) {  // async para usar await dentro
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

            let restante = valor;
            const updates = [];

            const atualIndex = parcelas.findIndex(p => !p.pago);
            if (atualIndex === -1) {
              return res.json({ id: pagamentoId, emprestimo_id, valor, data, info: 'Nenhuma parcela pendente.' });
            }
            const atual = parcelas[atualIndex];

            if (tipoPagamento === 'desconto_proxima') {
              const novoValorPagoAtual = (atual.valor_pago || 0) + restante;
              const excedenteInicial = novoValorPagoAtual > atual.valor_total ? novoValorPagoAtual - atual.valor_total : 0;
              const valorPagoAtual = Math.min(novoValorPagoAtual, atual.valor_total);

              updates.push({
                id: atual.id,
                valor_pago: valorPagoAtual,
                valor_excedente: 0,
                data_pagamento: data,
                pago: valorPagoAtual >= atual.valor_total ? 1 : 0,
                valor_total: atual.valor_total,
                valor_capital: atual.valor_capital,
                valor_juros: atual.valor_juros,
                observacao: observacao || atual.observacao || '',
                tipo_pagamento: tipoPagamento
              });

              let excedente = excedenteInicial;
              let i = atualIndex + 1;

              while (excedente > 0 && i < parcelas.length) {
                const prox = parcelas[i];
                const valorOriginal = prox.valor_total;
                const novoValorTotal = +(prox.valor_total - excedente).toFixed(2);
                const capitalOriginal = prox.valor_capital;
                const novoCapital = Math.min(capitalOriginal, novoValorTotal);
                const novoJuros = +(novoValorTotal - novoCapital).toFixed(2);
                const descontoAplicado = prox.valor_total - novoValorTotal;

                db.get(
                  `SELECT 1 FROM parcelas_originais WHERE emprestimo_id = ? AND numero = ?`,
                  [prox.emprestimo_id, prox.numero],
                  (errCheck, rowCheck) => {
                    if (errCheck) {
                      console.error('[ERRO] Verificando parcela_original:', errCheck);
                    } else if (!rowCheck) {
                      db.run(
                        `INSERT INTO parcelas_originais (emprestimo_id, numero, valor_total, valor_capital, valor_juros)
                         VALUES (?, ?, ?, ?, ?)`,
                        [prox.emprestimo_id, prox.numero, prox.valor_total, prox.valor_capital, prox.valor_juros],
                        errInsert => {
                          if (errInsert) {
                            console.error('[ERRO] Salvando parcela_original:', errInsert);
                          }
                        }
                      );
                    }
                  }
                );

                const explicacao = `Desconto de R$ ${descontoAplicado.toFixed(2)} aplicado na próxima parcela (parcela ${prox.numero}) devido ao pagamento excedente da parcela ${atual.numero}.`;

                updates.push({
                  id: prox.id,
                  valor_total: novoValorTotal < 0 ? 0 : novoValorTotal,
                  valor_capital: novoCapital < 0 ? 0 : novoCapital,
                  valor_juros: novoJuros < 0 ? 0 : novoJuros,
                  observacao: prox.observacao || '',
                  explicacao,
                  valor_pago: prox.valor_pago,
                  pago: (prox.valor_pago || 0) >= novoValorTotal ? 1 : 0,
                  data_pagamento: (prox.valor_pago || 0) >= novoValorTotal ? data : prox.data_pagamento,
                  valor_excedente: 0,
                  tipo_pagamento: null
                });

                excedente = novoValorTotal < 0 ? Math.abs(novoValorTotal) : 0;
                i++;
              }

            } else if (tipoPagamento === 'abate_capital') {
              // DEBUG antes da chamada
              console.log('[DEBUG] Chamando abate_capital com:', {
                emprestimo_id,
                parcelaAtual: atual.id,
                valorPago: valor,
                data,
                observacao
              });

              // Usando async/await e passando objeto correto
              try {
                const updatesCalculados = await calcularAbateCapital({
                  emprestimo_id,
                  parcelaAtual: atual.id,
                  valorPago: valor,
                  data,
                  observacao
                });
                console.log('[DEBUG] Updates calculados:', updatesCalculados);

                updates.push(...updatesCalculados);
              } catch (err) {
                console.error('[ERRO] pagamento_abate_capital:', err);
                return res.status(500).json({ erro: 'Erro no processamento do pagamento com abate de capital.' });
              }

            } else {
              // Mantém só o 'normal' aqui, sem 'abatimento' duplicado
              for (let i = atualIndex; i < parcelas.length && restante > 0; i++) {
                const p = parcelas[i];

                if (tipoPagamento === 'normal') {
                  updates.push({
                    id: p.id,
                    valor_pago: (p.valor_pago || 0) + restante,
                    valor_excedente: 0,
                    data_pagamento: data,
                    pago: ((p.valor_pago || 0) + restante) >= p.valor_total ? 1 : 0,
                    valor_total: p.valor_total,
                    valor_capital: p.valor_capital,
                    valor_juros: p.valor_juros,
                    observacao: observacao || p.observacao || '',
                    tipo_pagamento: tipoPagamento
                  });
                  restante = 0;
                  break;
                }

                // Se receber algum outro tipo, pode colocar mais casos aqui (exemplo: juros adicionais)
              }
            }

            const aplicarUpdate = i => {
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
              const sql = `
                UPDATE parcelas SET 
                  valor_pago = COALESCE(?, valor_pago),
                  valor_excedente = COALESCE(?, valor_excedente),
                  data_pagamento = COALESCE(?, data_pagamento),
                  pago = COALESCE(?, pago),
                  valor_total = COALESCE(?, valor_total),
                  valor_capital = COALESCE(?, valor_capital),
                  valor_juros = COALESCE(?, valor_juros),
                  observacao = COALESCE(?, observacao),
                  explicacao = COALESCE(?, explicacao),
                  tipo_pagamento = COALESCE(?, tipo_pagamento)
                WHERE id = ?`;

              db.run(
                sql,
                [
                  up.valor_pago,
                  up.valor_excedente,
                  up.data_pagamento,
                  up.pago,
                  up.valor_total,
                  up.valor_capital,
                  up.valor_juros,
                  up.observacao,
                  up.explicacao,
                  up.tipo_pagamento,
                  up.id
                ],
                err => {
                  if (err) {
                    console.error('[ERRO] Erro ao atualizar parcela:', err);
                    return res.status(500).json({ erro: 'Erro ao atualizar parcela' });
                  }
                  aplicarUpdate(i + 1);
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

module.exports = router;