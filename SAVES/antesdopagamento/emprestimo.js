const express = require('express');   
const router = express.Router();
const db = require('../models/database');

function calcularMesesDeDiferenca(dataInicial, dataFinal) {
  const inicio = new Date(dataInicial);
  const fim = new Date(dataFinal);
  let anos = fim.getFullYear() - inicio.getFullYear();
  let meses = fim.getMonth() - inicio.getMonth();
  let totalMeses = anos * 12 + meses;
  if (fim.getDate() < inicio.getDate()) totalMeses--;
  return totalMeses < 0 ? 0 : totalMeses;
}

// GET - listar todos os empréstimos com parcelas detalhadas
router.get('/', (req, res) => {
  db.all(
    `SELECT e.*, c.nome AS cliente_nome
     FROM emprestimos e
     JOIN clientes c ON c.id = e.cliente_id`,
    (err, emprestimos) => {
      if (err) {
        console.error('[GET /emprestimos] Erro ao buscar empréstimos:', err.message);
        return res.status(500).json({ error: 'Erro ao buscar empréstimos.' });
      }

      const emprestimosComParcelas = [];

      const carregarParcelas = (index) => {
        if (index >= emprestimos.length) {
          return res.json(emprestimosComParcelas);
        }

        const e = emprestimos[index];

        db.all(
          `SELECT 
             p.numero, p.valor_total, p.valor_capital, p.valor_juros, p.pago, 
             p.valor_pago, p.data_pagamento, p.juros_adicionais, p.observacao, p.explicacao,
             po.valor_total AS valor_original,
             p.tipo_pagamento
           FROM parcelas p
           LEFT JOIN parcelas_originais po 
             ON po.emprestimo_id = p.emprestimo_id 
            AND po.numero = p.numero
           WHERE p.emprestimo_id = ?
           ORDER BY p.numero ASC`,
          [e.id],
          (err2, parcelas) => {
            if (err2) {
              console.error(
                `[GET /emprestimos] Erro ao buscar parcelas para empréstimo ${e.id}:`,
                err2.message
              );
              e.parcelasDetalhes = [];
              emprestimosComParcelas.push(e);
              carregarParcelas(index + 1);
              return;
            }

            db.all(
              `SELECT valor, data, tipo_pagamento, parcela_origem 
                 FROM pagamentos 
                WHERE emprestimo_id = ? 
             ORDER BY data ASC`,
              [e.id],
              (err4, pagamentos) => {
                if (err4) {
                  console.error(
                    `[GET /emprestimos] Erro ao buscar pagamentos para empréstimo ${e.id}:`,
                    err4.message
                  );
                  pagamentos = [];
                }

                // monta parcelasDetalhes incluindo explicacao, tipo_pagamento e a flag renegociada
                e.parcelasDetalhes = parcelas.map(p => {
                  let explicacao = p.explicacao || null;

                  // para a explicação, mantemos:
                  // desconto na próxima: pg.parcela_origem + 1 === p.numero
                  const pgParaExplicacao = pagamentos.find(pg =>
                    pg.parcela_origem + 1 === p.numero
                  );

                  // para o TIPO DE PAGAMENTO, só exibimos 
                  // quando houve pagamento naquela própria parcela:
                  // pg.parcela_origem === p.numero
                  const pgParaTipo = pagamentos.find(pg =>
                    pg.parcela_origem === p.numero
                  );

                  // FLAG para indicar se a parcela é renegociada (nova)
                  const renegociada = !parcelas.find(orig =>
                    orig.numero === p.numero && orig.valor_total === p.valor_total
                  );

                  return {
                    ...p,
                    explicacao: pgParaExplicacao ? p.explicacao : explicacao,
                    tipo_pagamento: pgParaTipo ? pgParaTipo.tipo_pagamento : null,
                    renegociada
                  };
                });

                db.all(
                  `SELECT 
                     numero, valor_total, valor_capital, valor_juros
                   FROM parcelas_originais
                  WHERE emprestimo_id = ?
                  ORDER BY numero ASC`,
                  [e.id],
                  (err3, parcelasOriginais) => {
                    if (err3) {
                      console.error(
                        `[GET /emprestimos] Erro ao buscar parcelas originais para empréstimo ${e.id}:`,
                        err3.message
                      );
                      e.parcelasOriginais = [];
                    } else {
                      e.parcelasOriginais = parcelasOriginais || [];
                    }

                    const hoje = new Date();
                    const meses = calcularMesesDeDiferenca(e.data, hoje);
                    e.meses_passados = meses;
                    e.valor_com_juros = Number(
                      (e.valor * Math.pow(1 + (e.taxa_juros || 0) / 100, meses)).toFixed(2)
                    );

                    e.total_pago = pagamentos.reduce((soma, p) => soma + p.valor, 0);
                    e.pagamentos = pagamentos;

                    emprestimosComParcelas.push(e);
                    carregarParcelas(index + 1);
                  }
                );
              }
            );
          }
        );
      };

      carregarParcelas(0);
    }
  );
});

// GET - empréstimo por ID com valor_total ajustado se houver desconto
router.get('/:id', (req, res) => {
  const id = req.params.id;

  db.get('SELECT * FROM emprestimos WHERE id = ?', [id], (err, emprestimo) => {
    if (err) {
      console.error(
        `[GET /emprestimos/${id}] Erro ao buscar empréstimo:`,
        err.message
      );
      return res.status(500).json({ error: 'Erro ao buscar empréstimo.' });
    }
    if (!emprestimo) return res.status(404).json({ error: 'Empréstimo não encontrado.' });

    db.all(
      `SELECT 
         p.numero, p.valor_total, p.valor_capital, p.valor_juros, p.pago, 
         p.valor_pago, p.data_pagamento, p.juros_adicionais, p.observacao, p.explicacao,
         po.valor_total AS valor_original,
         p.tipo_pagamento
       FROM parcelas p
       LEFT JOIN parcelas_originais po 
         ON po.emprestimo_id = p.emprestimo_id 
        AND po.numero = p.numero
       WHERE p.emprestimo_id = ?
       ORDER BY p.numero ASC`,
      [id],
      (err2, parcelas) => {
        if (err2) {
          console.error(
            `[GET /emprestimos/${id}] Erro ao buscar parcelas:`,
            err2.message
          );
          emprestimo.parcelasDetalhes = [];
          return res.json(emprestimo);
        }

        db.all(
          `SELECT valor, data, tipo_pagamento, parcela_origem 
             FROM pagamentos 
            WHERE emprestimo_id = ? 
         ORDER BY data ASC`,
          [id],
          (err4, pagamentos) => {
            if (err4) {
              console.error(
                `[GET /emprestimos/${id}] Erro ao buscar pagamentos:`,
                err4.message
              );
              pagamentos = [];
            }

            emprestimo.parcelasDetalhes = parcelas.map(p => {
              let explicacao = p.explicacao || null;
              // explicação
              const pgParaExplicacao = pagamentos.find(pg =>
                pg.parcela_origem + 1 === p.numero
              );
              // tipo
              const pgParaTipo = pagamentos.find(pg =>
                pg.parcela_origem === p.numero
              );

              return {
                ...p,
                explicacao: pgParaExplicacao ? explicacao : explicacao,
                tipo_pagamento: pgParaTipo ? pgParaTipo.tipo_pagamento : null
              };
            });

            emprestimo.total_pago = pagamentos.reduce((s, p) => s + p.valor, 0);
            return res.json(emprestimo);
          }
        );
      }
    );
  });
});

router.put('/:id', (req, res) => {
  const id = req.params.id;
  const { cliente_id, valor, data, modalidade, parcelas, taxa_juros, observacao, dia_pagamento } = req.body;

  if (!cliente_id || !valor || !data || !modalidade || taxa_juros === undefined) {
    console.error('[PUT /emprestimos] Dados incompletos:', req.body);
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  db.run(
    `UPDATE emprestimos SET
       cliente_id = ?, valor = ?, data = ?, modalidade = ?, taxa_juros = ?, observacao = ?, dia_pagamento = ?
     WHERE id = ?`,
    [cliente_id, valor, data, modalidade, taxa_juros, observacao, dia_pagamento, id],
    function(err) {
      if (err) {
        console.error(
          `[PUT /emprestimos/${id}] Erro ao atualizar empréstimo:`,
          err.message
        );
        return res.status(500).json({ error: 'Erro ao atualizar empréstimo.' });
      }
      res.json({ mensagem: 'Empréstimo atualizado com sucesso!' });
    }
  );
});

router.post('/', (req, res) => {
  console.log('[POST /emprestimos] Dados recebidos:', req.body);

  const { cliente_id, valor, data, modalidade, parcelas, taxa_juros, observacao, dia_pagamento } = req.body;

  if (!cliente_id || !valor || !data || !modalidade || taxa_juros === undefined) {
    console.error('[POST /emprestimos] Dados incompletos:', req.body);
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  db.get(
    'SELECT COUNT(*) AS total FROM emprestimos WHERE cliente_id = ?',
    [cliente_id],
    (err, row) => {
      if (err) {
        console.error(
          '[POST /emprestimos] Erro ao contar empréstimos do cliente:',
          err.message
        );
        return res.status(500).json({ error: 'Erro interno.' });
      }

      const sequencia = row.total + 1;
      const codigo_cliente = `${cliente_id}-${sequencia}`;

      const sql = `INSERT INTO emprestimos
                     (cliente_id, codigo_cliente, valor, data, modalidade, taxa_juros, observacao, dia_pagamento)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

      db.run(
        sql,
        [cliente_id, codigo_cliente, valor, data, modalidade, taxa_juros, observacao, dia_pagamento],
        function(err) {
          if (err) {
            console.error(
              '[POST /emprestimos] Erro ao inserir empréstimo:',
              err.message
            );
            return res.status(500).json({ error: 'Erro ao salvar empréstimo no banco.' });
          }

          const emprestimoId = this.lastID;
          console.log(
            `[POST /emprestimos] Empréstimo criado com ID ${emprestimoId} e código ${codigo_cliente}`
          );

          if (modalidade === 'parcelado' && parcelas > 0) {
            const taxa = taxa_juros / 100;
            const amort = valor / parcelas;
            let saldo = valor;
            const stmt = db.prepare(
              `INSERT INTO parcelas
                 (emprestimo_id, numero, valor_total, valor_capital, valor_juros, vencimento, pago, observacao, valor_pago, data_pagamento, juros_adicionais)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );

            const stmtOriginais = db.prepare(
              `INSERT INTO parcelas_originais
                 (emprestimo_id, numero, valor_total, valor_capital, valor_juros)
               VALUES (?, ?, ?, ?, ?)`
            );

            for (let i = 1; i <= parcelas; i++) {
              const jurosVal = saldo * taxa;
              const totalParc = amort + jurosVal;

              const venc = new Date(data);
              venc.setMonth(venc.getMonth() + i);
              venc.setDate(dia_pagamento || 15);

              stmt.run(
                emprestimoId,
                i,
                totalParc.toFixed(2),
                amort.toFixed(2),
                jurosVal.toFixed(2),
                venc.toISOString().split('T')[0],
                0,
                '',
                null,
                null,
                0
              );

              stmtOriginais.run(
                emprestimoId,
                i,
                totalParc.toFixed(2),
                amort.toFixed(2),
                jurosVal.toFixed(2)
              );

              saldo -= amort;
            }

            stmt.finalize(err2 => {
              if (err2) {
                console.error(
                  '[POST /emprestimos] Erro ao inserir parcelas:',
                  err2.message
                );
                return res.status(500).json({ error: 'Erro ao criar parcelas.' });
              }

              stmtOriginais.finalize();
              console.log(
                `[POST /emprestimos] Parcelas criadas para empréstimo ${emprestimoId}`
              );
              return res.json({ id: emprestimoId, codigo_cliente });
            });
          } else {
            res.json({ id: emprestimoId, codigo_cliente });
          }
        }
      );
    }
  );
});

module.exports = router;