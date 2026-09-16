const { db, toNumberSafe } = require('./core');
const { toISO } = require('../dateUtils');
const gerarParcelas = require('../../utils/gerarParcelas');

exports.atualizarEmprestimo = (id, dados) => {
  return new Promise((resolve, reject) => {
    const {
      cliente_id,
      valor,
      data,
      modalidade,
      parcelas,
      taxa_juros,
      observacao,
      dia_pagamento,
    } = dados;

    if (!cliente_id || !valor || !data || !modalidade || taxa_juros === undefined) {
      return reject(new Error('Campos obrigatorios ausentes.'));
    }

    const emprestimoId = Number(id);
    if (!Number.isFinite(emprestimoId) || emprestimoId <= 0) {
      return reject(new Error('ID de emprestimo invalido.'));
    }

    db.get(
      `SELECT COUNT(1) AS total
         FROM parcelas
        WHERE emprestimo_id = ?
          AND (
            COALESCE(pago, 0) = 1
            OR COALESCE(valor_pago, 0) > 0
          )`,
      [emprestimoId],
      (checkErr, row) => {
        if (checkErr) return reject(checkErr);

        const totalPagas = Number((row && row.total) || 0);
        if (totalPagas > 0) {
          const blocked = new Error('Emprestimo com parcela paga nao pode ser editado.');
          blocked.code = 'LOAN_EDIT_BLOCKED_AFTER_PAYMENT';
          return reject(blocked);
        }

        db.run(
          `UPDATE emprestimos SET
             cliente_id = ?, valor = ?, data = ?, modalidade = ?, taxa_juros = ?, observacao = ?, dia_pagamento = ?
           WHERE id = ?`,
          [cliente_id, valor, data, modalidade, taxa_juros, observacao, dia_pagamento, emprestimoId],
          function (err) {
            if (err) return reject(err);
            resolve({ mensagem: 'Emprestimo atualizado com sucesso!' });
          }
        );
      }
    );
  });
};

exports.criarEmprestimo = (dados) => {
  return new Promise((resolve, reject) => {
    const {
      cliente_id,
      valor,
      data,
      modalidade,
      parcelas,
      taxa_juros,
      observacao,
      dia_pagamento,
      data_pagamento,
      valor_emprestado,
      valor_atual,
    } = dados;

    const valorEmprestado = toNumberSafe(
      valor_emprestado != null ? valor_emprestado : valor
    );
    const valorAtual = toNumberSafe(valor_atual != null ? valor_atual : valor);

    if (
      !cliente_id ||
      !valorEmprestado ||
      !data ||
      !modalidade ||
      taxa_juros === undefined ||
      dia_pagamento === undefined
    ) {
      return reject(new Error('Campos obrigatÃ³rios ausentes.'));
    }

    const dataCriacao = toISO(data) ? new Date(toISO(data)) : null;
    if (!dataCriacao) return reject(new Error('Data invÃ¡lida'));

    db.get(
      'SELECT COUNT(*) AS total FROM emprestimos WHERE cliente_id = ?',
      [cliente_id],
      (err, row) => {
        if (err) return reject(err);

        const sequencia = row && row.total ? row.total + 1 : 1;
        const codigo_cliente = `${cliente_id}-${sequencia}`;

        const sql = `INSERT INTO emprestimos
                       (cliente_id, codigo_cliente, valor, valor_emprestado, valor_atual, data, modalidade, taxa_juros, observacao, dia_pagamento)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        db.run(
          sql,
          [
            cliente_id,
            codigo_cliente,
            valorAtual,
            valorEmprestado,
            valorAtual,
            data,
            modalidade,
            taxa_juros,
            observacao,
            dia_pagamento,
          ],
          function (err2) {
            if (err2) return reject(err2);

            const emprestimoId = this.lastID;

            if (modalidade === 'parcelado' && parcelas > 0) {
              try {
                const geradas = gerarParcelas({
                  capital: Number(valorAtual),
                  taxa_juros: Number(taxa_juros),
                  qtdParcelas: Number(parcelas),
                  dataInicio: dataCriacao,
                  diaPagamento: Number(dia_pagamento),
                  primeiroVencimento: data_pagamento || null,
                });

                const stmt = db.prepare(
                  `INSERT INTO parcelas
                     (emprestimo_id, numero, valor_total, valor_capital, valor_juros, vencimento, pago, observacao, valor_pago, data_pagamento, juros_adicionais, juros_pendentes, versao)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                );

                const stmtOriginais = db.prepare(
                  `INSERT INTO parcelas_originais
                     (emprestimo_id, numero, valor_total, valor_capital, valor_juros)
                   VALUES (?, ?, ?, ?, ?)`
                );

                for (let i = 0; i < geradas.length; i++) {
                  const p = geradas[i];
                  stmt.run(
                    emprestimoId,
                    p.numero,
                    p.valor_total.toFixed(2),
                    p.valor_capital.toFixed(2),
                    p.valor_juros.toFixed(2),
                    p.vencimento_iso,
                    0,
                    '',
                    null,
                    null,
                    0,
                    0,
                    1
                  );

                  stmtOriginais.run(
                    emprestimoId,
                    p.numero,
                    p.valor_total.toFixed(2),
                    p.valor_capital.toFixed(2),
                    p.valor_juros.toFixed(2)
                  );
                }

                stmt.finalize((err3) => {
                  if (err3) return reject(err3);
                  stmtOriginais.finalize();
                  resolve({ id: emprestimoId, codigo_cliente });
                });
              } catch (gErr) {
                console.error('Erro ao gerar/inserir parcelas:', gErr);
                return reject(gErr);
              }
            } else {
              resolve({ id: emprestimoId, codigo_cliente });
            }
          }
        );
      }
    );
  });
};

exports.atualizarParcelaVencimento = (parcelaId, vencimento) => {
  return new Promise((resolve, reject) => {
    const vencISO = toISO(vencimento);
    if (!vencISO) {
      return reject(new Error('Data de vencimento invÃ¡lida'));
    }

    db.run(
      'UPDATE parcelas SET vencimento = ? WHERE id = ?',
      [vencISO, parcelaId],
      function (err) {
        if (err) return reject(err);
        resolve({
          mensagem: `Vencimento atualizado para parcela ${parcelaId}`,
          vencimento: vencISO,
        });
      }
    );
  });
};

exports.excluirEmprestimo = (id) => {
  return new Promise((resolve, reject) => {
    if (!id) return reject(new Error('ID invÃ¡lido'));

    db.serialize(() => {
      db.run('BEGIN TRANSACTION', (errBegin) => {
        if (errBegin) return reject(errBegin);

        db.run('DELETE FROM pagamentos WHERE emprestimo_id = ?', [id], function (errPay) {
          if (errPay) {
            db.run('ROLLBACK', () => {});
            return reject(errPay);
          }

          db.run(
            'DELETE FROM parcelas_originais WHERE emprestimo_id = ?',
            [id],
            function (errOrig) {
              if (errOrig) {
                db.run('ROLLBACK', () => {});
                return reject(errOrig);
              }

              db.run('DELETE FROM parcelas WHERE emprestimo_id = ?', [id], function (errParc) {
                if (errParc) {
                  db.run('ROLLBACK', () => {});
                  return reject(errParc);
                }

                db.run('DELETE FROM emprestimos WHERE id = ?', [id], function (errEmp) {
                  if (errEmp) {
                    db.run('ROLLBACK', () => {});
                    return reject(errEmp);
                  }

                  db.run('COMMIT', (errCommit) => {
                    if (errCommit) {
                      db.run('ROLLBACK', () => {});
                      return reject(errCommit);
                    }
                    resolve({ mensagem: `EmprÃ©stimo ${id} excluÃ­do com sucesso.` });
                  });
                });
              });
            }
          );
        });
      });
    });
  });
};

