// backend/services/servicoemprestimo.js
const { isLoanFinalized } = require('../utils/historicoUtils');
const db = require('../models/database');
const { toISO, toExtenso, calcularMesesDeDiferenca } = require('./dateUtils');
const { getParcelasData } = require('./parcelasService');
const gerarParcelas = require('../utils/gerarParcelas'); // util unificado

/* ---------- helpers já existentes (mantive) ---------- */

function toNumberSafe(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isNaN(v) ? 0 : v;
  let s = String(v).trim();
  if (s === '') return 0;
  if (s.indexOf(',') > -1 && s.indexOf('.') > -1) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    if (s.indexOf(',') > -1 && s.indexOf('.') === -1) s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}

function isPaidFlag(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true';
}

function calcularCapitalPagoAPartirDeParcelas(parcelas = [], parcelasOriginais = []) {
  return (parcelas || []).reduce((soma, p) => {
    const valorPago = toNumberSafe(p.valor_pago);
    const numero = p.numero != null ? Number(p.numero) : null;
    let orig = null;
    if (Array.isArray(parcelasOriginais) && numero != null) {
      orig = parcelasOriginais.find(o => Number(o.numero) === numero) || null;
    }
    if (!orig && Array.isArray(parcelasOriginais)) {
      orig = parcelasOriginais.find(o => Number(o.id) === Number(p.id)) || null;
    }

    const originalValorCapital = toNumberSafe(orig && orig.valor_capital != null ? orig.valor_capital : p.valor_capital);
    const originalValorJuros  = toNumberSafe(orig && orig.valor_juros != null ? orig.valor_juros : p.valor_juros);

    if (isPaidFlag(p.pago)) {
      return soma + originalValorCapital;
    }

    if (valorPago > 0) {
      const capitalPagoParcial = Math.max(0, valorPago - originalValorJuros);
      return soma + Math.min(capitalPagoParcial, originalValorCapital);
    }

    return soma;
  }, 0);
}

/* ---------- listarTodosEmprestimos (mantida igual) ---------- */

exports.listarTodosEmprestimos = () => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT e.*, c.nome AS cliente_nome
       FROM emprestimos e
       JOIN clientes c ON c.id = e.cliente_id`,
      (err, emprestimos) => {
        if (err) return reject(err);

        const emprestimosComParcelas = [];

        const carregarParcelas = (index) => {
          if (index >= emprestimos.length) return resolve(emprestimosComParcelas);

          const e = emprestimos[index];

          getParcelasData(e.id)
            .then(({ parcelas, pagamentos, parcelasOriginais }) => {
              try {
                const hoje = new Date();
                const meses = calcularMesesDeDiferenca(e.data, hoje);

                e.parcelasDetalhes = parcelas || [];
                e.parcelasOriginais = parcelasOriginais || [];
                e.meses_passados = meses;
                e.valor_com_juros = Number((toNumberSafe(e.valor) * Math.pow(1 + (toNumberSafe(e.taxa_juros) || 0) / 100, meses)).toFixed(2));
                e.total_pago = (pagamentos || []).reduce((soma, p) => soma + toNumberSafe(p.valor), 0);
                e.pagamentos = pagamentos || [];

                const capitalPago = calcularCapitalPagoAPartirDeParcelas(e.parcelasDetalhes || [], e.parcelasOriginais || []);
                const valorTotal = toNumberSafe(e.valor);
                const capitalRestanteRaw = valorTotal - capitalPago;
                const capitalRestanteFinal = Math.max(0, Number((typeof capitalRestanteRaw.toFixed === 'function') ? capitalRestanteRaw.toFixed(2) : capitalRestanteRaw));
                e.capital_restante = Number(Number(capitalRestanteFinal).toFixed(2));
              } catch (calcErr) {
                console.error('Erro ao calcular capital_restante:', calcErr);
                e.capital_restante = Number(toNumberSafe(e.valor).toFixed(2));
              }

              emprestimosComParcelas.push(e);
              carregarParcelas(index + 1);
            })
            .catch((errParcelas) => {
              console.error('Erro ao obter parcelas para emprestimo', e.id, errParcelas);
              e.parcelasDetalhes = [];
              e.parcelasOriginais = [];
              e.meses_passados = 0;
              e.valor_com_juros = Number(toNumberSafe(e.valor) || 0);
              e.total_pago = 0;
              e.pagamentos = [];
              e.capital_restante = Number(toNumberSafe(e.valor).toFixed(2));

              emprestimosComParcelas.push(e);
              carregarParcelas(index + 1);
            });
        };

        carregarParcelas(0);
      }
    );
  });
};

/* ---------- buscarEmprestimoPorId (mantida) ---------- */

exports.buscarEmprestimoPorId = (id) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM emprestimos WHERE id = ?', [id], (err, emprestimo) => {
      if (err) return reject(err);
      if (!emprestimo) return resolve(null);

      getParcelasData(emprestimo.id)
        .then(({ parcelas, pagamentos, parcelasOriginais }) => {
          try {
            emprestimo.parcelasDetalhes = parcelas || [];
            emprestimo.parcelasOriginais = parcelasOriginais || [];
            emprestimo.total_pago = (pagamentos || []).reduce((s, p) => s + toNumberSafe(p.valor), 0);

            const capitalPago = calcularCapitalPagoAPartirDeParcelas(emprestimo.parcelasDetalhes || [], emprestimo.parcelasOriginais || []);
            const valorTotal = toNumberSafe(emprestimo.valor);
            const capitalRestanteRaw = valorTotal - capitalPago;
            const capitalRestanteFinal = Math.max(0, Number((typeof capitalRestanteRaw.toFixed === 'function') ? capitalRestanteRaw.toFixed(2) : capitalRestanteRaw));
            emprestimo.capital_restante = Number(Number(capitalRestanteFinal).toFixed(2));
          } catch (calcErr) {
            console.error('Erro ao calcular capital_restante (buscarPorId):', calcErr);
            emprestimo.capital_restante = Number(toNumberSafe(emprestimo.valor).toFixed(2));
          }

          resolve(emprestimo);
        })
        .catch((errParcelas) => {
          console.error('Erro getParcelasData (buscarPorId):', errParcelas);
          emprestimo.parcelasDetalhes = [];
          emprestimo.parcelasOriginais = [];
          emprestimo.total_pago = 0;
          emprestimo.capital_restante = Number(toNumberSafe(emprestimo.valor).toFixed(2));
          resolve(emprestimo);
        });
    });
  });
};

/* ---------- atualizarEmprestimo (mantida) ---------- */

exports.atualizarEmprestimo = (id, dados) => {
  return new Promise((resolve, reject) => {
    const { cliente_id, valor, data, modalidade, parcelas, taxa_juros, observacao, dia_pagamento } = dados;

    if (!cliente_id || !valor || !data || !modalidade || taxa_juros === undefined) {
      return reject(new Error('Campos obrigatórios ausentes.'));
    }

    db.run(
      `UPDATE emprestimos SET
         cliente_id = ?, valor = ?, data = ?, modalidade = ?, taxa_juros = ?, observacao = ?, dia_pagamento = ?
       WHERE id = ?`,
      [cliente_id, valor, data, modalidade, taxa_juros, observacao, dia_pagamento, id],
      function (err) {
        if (err) return reject(err);
        resolve({ mensagem: 'Empréstimo atualizado com sucesso!' });
      }
    );
  });
};

/* ---------- criarEmprestimo (mantida) ---------- */

exports.criarEmprestimo = (dados) => {
  return new Promise((resolve, reject) => {
    const { cliente_id, valor, data, modalidade, parcelas, taxa_juros, observacao, dia_pagamento } = dados;

    if (!cliente_id || !valor || !data || !modalidade || taxa_juros === undefined || dia_pagamento === undefined) {
      return reject(new Error('Campos obrigatórios ausentes.'));
    }

    const dataCriacao = toISO(data) ? new Date(toISO(data)) : null;
    if (!dataCriacao) return reject(new Error('Data inválida'));

    db.get(
      'SELECT COUNT(*) AS total FROM emprestimos WHERE cliente_id = ?',
      [cliente_id],
      (err, row) => {
        if (err) return reject(err);

        const sequencia = (row && row.total) ? row.total + 1 : 1;
        const codigo_cliente = `${cliente_id}-${sequencia}`;

        const sql = `INSERT INTO emprestimos
                       (cliente_id, codigo_cliente, valor, data, modalidade, taxa_juros, observacao, dia_pagamento)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

        db.run(
          sql,
          [cliente_id, codigo_cliente, valor, data, modalidade, taxa_juros, observacao, dia_pagamento],
          function (err2) {
            if (err2) return reject(err2);

            const emprestimoId = this.lastID;

            if (modalidade === 'parcelado' && parcelas > 0) {
              try {
                const geradas = gerarParcelas({
                  capital: Number(valor),
                  taxa_juros: Number(taxa_juros),
                  qtdParcelas: Number(parcelas),
                  dataInicio: dataCriacao,
                  diaPagamento: Number(dia_pagamento)
                });

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
                    0
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

/* ---------- atualizarParcelaVencimento (mantida) ---------- */

exports.atualizarParcelaVencimento = (parcelaId, vencimento) => {
  return new Promise((resolve, reject) => {
    const vencISO = toISO(vencimento);
    if (!vencISO) {
      return reject(new Error('Data de vencimento inválida'));
    }

    db.run(
      'UPDATE parcelas SET vencimento = ? WHERE id = ?',
      [vencISO, parcelaId],
      function (err) {
        if (err) return reject(err);
        resolve({ mensagem: `Vencimento atualizado para parcela ${parcelaId}`, vencimento: vencISO });
      }
    );
  });
};

/* ---------- excluirEmprestimo (mantida) ---------- */

exports.excluirEmprestimo = (id) => {
  return new Promise((resolve, reject) => {
    if (!id) return reject(new Error('ID inválido'));

    db.serialize(() => {
      db.run('BEGIN TRANSACTION', (errBegin) => {
        if (errBegin) return reject(errBegin);

        db.run('DELETE FROM pagamentos WHERE emprestimo_id = ?', [id], function (errPay) {
          if (errPay) {
            db.run('ROLLBACK', () => {});
            return reject(errPay);
          }

          db.run('DELETE FROM parcelas_originais WHERE emprestimo_id = ?', [id], function (errOrig) {
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
                  resolve({ mensagem: `Empréstimo ${id} excluído com sucesso.` });
                });
              });
            });
          });
        });
      });
    });
  });
};

/* ---------- NOVA FUNÇÃO: listarEmprestimosQuitados ---------- */

function isLoanFinalizedInternal(emp) {
  if (!emp) return false;
  if (emp.quitado === true) return true;
  if (typeof emp.capital_restante === 'number' && emp.capital_restante <= 0) return true;

  const parcelas = emp.parcelasDetalhes || emp.parcelas || [];
  const relevantes = (parcelas || []).filter(p => p && Number(p.numero) !== -1);
  if (relevantes.length === 0) return false;

  return relevantes.every(p => {
    if (p.pago === true || p.pago === 1) return true;
    const valorPago = toNumberSafe(p.valor_pago);
    const valorTotal = toNumberSafe(p.valor_total || p.valor_com_desconto || 0);
    if (valorTotal > 0 && valorPago >= valorTotal) return true;
    return false;
  });
}

exports.listarEmprestimosQuitados = () => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT e.*, c.nome AS cliente_nome
       FROM emprestimos e
       JOIN clientes c ON c.id = e.cliente_id`,
      (err, emprestimos) => {
        if (err) return reject(err);

        const result = [];
        let i = 0;

        const carregar = () => {
          if (i >= emprestimos.length) return resolve(result);

          const e = emprestimos[i];
          getParcelasData(e.id)
            .then(({ parcelas, pagamentos, parcelasOriginais }) => {
              try {
                e.parcelasDetalhes = parcelas || [];
                e.parcelasOriginais = parcelasOriginais || [];
                e.pagamentos = pagamentos || [];
                e.total_pago = (pagamentos || []).reduce((s, p) => s + toNumberSafe(p.valor), 0);

                const capitalPago = calcularCapitalPagoAPartirDeParcelas(e.parcelasDetalhes || [], e.parcelasOriginais || []);
                const valorTotal = toNumberSafe(e.valor);
                const capitalRestanteRaw = valorTotal - capitalPago;
                const capitalRestanteFinal = Math.max(0, Number((typeof capitalRestanteRaw.toFixed === 'function') ? capitalRestanteRaw.toFixed(2) : capitalRestanteRaw));
                e.capital_restante = Number(Number(capitalRestanteFinal).toFixed(2));
              } catch (calcErr) {
                console.error('Erro calcular capital_restante (quitados):', calcErr);
                e.capital_restante = Number(toNumberSafe(e.valor).toFixed(2));
              }

              if (isLoanFinalizedInternal(e)) {
                result.push(e);
              }

              i++;
              carregar();
            })
            .catch((errParcelas) => {
              console.error('Erro getParcelasData (quitados) emprestimo', e.id, errParcelas);
              e.parcelasDetalhes = [];
              e.parcelasOriginais = [];
              e.pagamentos = [];
              e.total_pago = 0;
              e.capital_restante = Number(toNumberSafe(e.valor).toFixed(2));

              if (isLoanFinalizedInternal(e)) {
                result.push(e);
              }

              i++;
              carregar();
            });
        };

        carregar();
      }
    );
  });
};