// backend/routes/parcelas.js
const express = require('express');
const router = express.Router();
const { exigirProtecao, jurosExigemProtecao } = require('../middleware/protecao');
const db = require('../models/database');
const { toExtenso, toISO } = require('../services/dateUtils');
const { touchAtividade } = require('../utils/touchAtividade');
const { reagendarParcelas } = require('../services/reagendamentoParcelasService');
const { runAsync } = require('../utils/sqliteAsync');
const { ensureActionContractReady } = require('../services/actionIdentityService');
const { ensureEntityIdentityV1 } = require('../services/entityIdentityService');
const { capturarEstadoEmprestimo, registrarAcaoEmprestimo } = require('../services/emprestimoActionService');
const { ACTION_TYPES } = require('../services/actionTypeContract');
function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
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


/**
 * Converte vários formatos comuns para 'YYYY-MM-DD' (string).
 */
function paraInputDate(data) {
  if (!data && data !== 0) return '';

  // Date object
  if (data instanceof Date) {
    if (isNaN(data.getTime())) return '';
    const y = data.getFullYear();
    const m = String(data.getMonth() + 1).padStart(2, '0');
    const d = String(data.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  if (typeof data !== 'string') {
    const dt = new Date(data);
    if (!isNaN(dt.getTime())) {
      return paraInputDate(dt);
    }
    return '';
  }

  const s = data.trim();

  // já em ISO yyyy-mm-dd
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  // ISO com hora
  if (s.includes('T')) {
    const datePart = s.split('T')[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
  }

  // formato dd/mm/yyyy
  if (s.includes('/')) {
    const partes = s.split('/');
    if (partes.length === 3) {
      const d = partes[0].padStart(2, '0');
      const m = partes[1].padStart(2, '0');
      const y = partes[2];
      if (/^\d{4}$/.test(y)) {
        return `${y}-${m}-${d}`;
      }
    }
  }

  // fallback: tenta criar Date e converter
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) return paraInputDate(dt);

  return '';
}

/**
 * Último dia de um mês (1–12).
 */
function ultimoDiaDoMes(year, month) {
  // Date(year, month, 0) -> último dia do mês anterior a `month`
  return new Date(year, month, 0).getDate();
}

/**
 * Soma "months" meses a uma data ISO 'YYYY-MM-DD' sem usar timezone.
 * Ajusta o dia para não passar do último dia do mês.
 */
function addMonthsISO(dateISO, months) {
  const norm = paraInputDate(dateISO);
  if (!norm) return '';

  let [y, m, d] = norm.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return norm;
  }

  // soma meses "na mão"
  m += months; // pode ficar > 12 ou <= 0
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12 + 12) % 12 + 1; // 1..12

  const maxDia = ultimoDiaDoMes(y, m);
  if (d > maxDia) d = maxDia;

  const yy = String(y).padStart(4, '0');
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Diferença em MESES inteiros entre duas datas ISO (YYYY-MM-DD), ignorando dia.
 */
function diffMeses(antigaISO, novaISO) {
  const aNorm = paraInputDate(antigaISO);
  const nNorm = paraInputDate(novaISO);
  if (!aNorm || !nNorm) return 0;

  const [ay, am] = aNorm.split('-').map(Number);
  const [ny, nm] = nNorm.split('-').map(Number);

  return (ny - ay) * 12 + (nm - am);
}

/**
 * Aplica um NOVO DIA a uma data ISO, preservando ano/mês.
 */
function aplicarNovoDia(dateISO, novoDiaBruto) {
  const norm = paraInputDate(dateISO);
  if (!norm) return norm;

  const [yStr, mStr] = norm.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    return norm;
  }

  const maxDia = ultimoDiaDoMes(y, m);
  let dia = Number(novoDiaBruto);
  if (!Number.isFinite(dia) || dia < 1) dia = 1;
  if (dia > maxDia) dia = maxDia;

  const dd = String(dia).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

/**
 * Detecta se a parcela já foi paga.
 */
function parcelaJaPaga(p) {
  const flagPago = p.pago === 1 || p.pago === '1' || p.pago === true;
  const temValor = Number(p.valor_pago || 0) > 0;
  return flagPago || temValor;
}

// Regra específica para "alterar DIA em todas as parcelas":
// - bloqueia somente se flag pago estiver marcada.
// - não considera valor_pago nem data_pagamento aqui.
function parcelaBloqueadaParaAlterarDia(p) {
  return p.pago === 1 || p.pago === '1' || p.pago === true;
}

// GET - listar parcelas de um empréstimo
router.get('/:emprestimo_id', (req, res) => {
  const { emprestimo_id } = req.params;

  db.all(
    `SELECT p.*
       FROM parcelas p
       JOIN emprestimos e ON e.id = p.emprestimo_id
      WHERE p.emprestimo_id = ?
        AND (p.versao IS NULL OR p.versao = e.versao_atual)
      ORDER BY p.numero ASC`,
    [emprestimo_id],
    (err, rows) => {
      if (err) return res.status(500).json({ erro: err.message });

      const parcelasFormatadas = (rows || []).map((p) => ({
        ...p,
        vencimento: paraInputDate(p.vencimento),
        data_pagamento: paraInputDate(p.data_pagamento),
      }));

      res.json(parcelasFormatadas);
    }
  );
});

// POST - criar parcela
router.post('/', (req, res) => {
  const {
    emprestimo_id,
    numero,
    capital,
    juros,
    vencimento,
    observacao,
  } = req.body;

  db.run(
      `INSERT INTO parcelas (
        emprestimo_id, numero, valor_capital, valor_juros, vencimento, pago, observacao,
        valor_pago, data_pagamento, juros_adicionais, juros_pendentes, versao
      ) VALUES (?, ?, ?, ?, ?, 0, ?, 0, null, 0, 0, (SELECT versao_atual FROM emprestimos WHERE id = ?))`,
    [emprestimo_id, numero, capital, juros, vencimento, observacao || '', emprestimo_id],
    function (err) {
      if (err) return res.status(500).json({ erro: err.message });
      res.json({ id: this.lastID });
    }
  );
});

// PUT - atualizar campos enviados
router.put('/:id', exigirProtecao('adicionar_juros_parcela', {
  aplicavel: req => Object.hasOwn(req.body || {}, 'juros_adicionais') && jurosExigemProtecao(req.params.id),
}), (req, res) => {
  const { id } = req.params;

  const campos = [
    'valor_capital',
    'valor_juros',
    'vencimento',
    'pago',
    'observacao',
    'valor_pago',
    'data_pagamento',
    'juros_adicionais',
    'juros_pendentes',
    'explicacao',
  ];

  const updates = [];
  const values = [];

  campos.forEach((campo) => {
    if (Object.prototype.hasOwnProperty.call(req.body, campo)) {
      updates.push(`${campo} = ?`);
      values.push(req.body[campo]);
    }
  });

  if (updates.length === 0) {
    return res.status(400).json({ erro: 'Nenhum dado enviado para atualizar.' });
  }

  values.push(id);

  const sql = `UPDATE parcelas SET ${updates.join(', ')} WHERE id = ?`;

  db.get('SELECT emprestimo_id FROM parcelas WHERE id = ?', [id], (errFind, row) => {
    if (errFind) return res.status(500).json({ erro: errFind.message });
    const emprestimoId = row && row.emprestimo_id ? row.emprestimo_id : null;

    db.run(sql, values, async function (err) {
      if (err) return res.status(500).json({ erro: err.message });
      try {
        await touchAtividade({ emprestimoId });
      } catch (touchErr) {
        console.error('[touchAtividade] parcela/update:', touchErr);
      }
      res.json({ status: 'Parcela atualizada com sucesso' });
    });
  });
});

// POST - adicionar juros adicionais manualmente
router.post('/:id/juros-adicionais', exigirProtecao('adicionar_juros_parcela', {
  aplicavel: req => jurosExigemProtecao(req.params.id),
}), async (req, res) => {
  const { id } = req.params;
  const { valor, motivo, data } = req.body || {};
  console.log('[juros-adicionais] id:', id);
  console.log('[juros-adicionais] body:', req.body);

  const parseValor = (raw) => {
    if (raw === 0) return 0;
    if (raw == null || raw === '') return null;
    const txt = String(raw).trim();
    if (!txt) return null;
    const hasComma = txt.includes(',');
    const hasDot = txt.includes('.');
    let normalized = txt;
    if (hasComma && hasDot) {
      normalized = txt.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = txt.replace(',', '.');
    }
    const num = Number(normalized);
    return Number.isFinite(num) ? num : null;
  };

  const valorNum = parseValor(valor);
  if (valorNum == null || valorNum < 0) {
    return res.status(400).json({ erro: 'Valor inválido.' });
  }

  const motivoTxt = String(motivo || '').trim();
  if (!motivoTxt) {
    return res.status(400).json({ erro: 'Motivo é obrigatório.' });
  }

  try {
    await ensureEntityIdentityV1(db);
    await ensureActionContractReady(db);
    await runAsync(db, 'BEGIN IMMEDIATE TRANSACTION');
  } catch (error) {
    console.error('[juros-adicionais] preparo da acao falhou:', error);
    return res.status(500).json({ erro: 'Erro ao registrar juros adicionais.' });
  }

  db.get('SELECT * FROM parcelas WHERE id = ?', [id], async (err, parcela) => {
    if (err) {
      await runAsync(db, 'ROLLBACK').catch(() => {});
      console.error('[juros-adicionais] select erro:', err && err.stack || err);
      return res.status(500).json({ erro: err.message });
    }
    if (!parcela) {
      await runAsync(db, 'ROLLBACK').catch(() => {});
      return res.status(404).json({ erro: 'Parcela não encontrada.' });
    }

    const pagoFlag =
      parcela.pago === 1 || parcela.pago === '1' || parcela.pago === true;
    if (pagoFlag) {
      await runAsync(db, 'ROLLBACK').catch(() => {});
      return res.status(409).json({ erro: 'Parcela já está paga.' });
    }

    let antes;
    try {
      antes = await capturarEstadoEmprestimo(parcela.emprestimo_id, { dbHandle: db });
    } catch (stateError) {
      await runAsync(db, 'ROLLBACK').catch(() => {});
      console.error('[juros-adicionais] erro ao capturar estado anterior:', stateError);
      return res.status(500).json({ erro: 'Erro ao registrar juros adicionais.' });
    }

    const dataISO = toISO(data) || toISO(new Date());
    const dataExtenso = toExtenso(dataISO);
    const valorFmt = Number(valorNum || 0).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
    const novaLinha = `⏫ Na data ${dataExtenso} foi definido Juros de ${valorFmt} pelo Motivo: ${motivoTxt}`;
    const explicacaoAtual = String(parcela.explicacao || '').trim();
    const explicacaoNova = explicacaoAtual
      ? `${explicacaoAtual}\n${novaLinha}`
      : novaLinha;

    db.run(
      `
      UPDATE parcelas
      SET juros_adicionais = ?,
          explicacao = ?
      WHERE id = ?
      `,
      [valorNum, explicacaoNova, id],
      async function (err2) {
        if (err2) {
          await runAsync(db, 'ROLLBACK').catch(() => {});
          console.error('[juros-adicionais] update erro:', err2 && err2.stack || err2);
          return res.status(500).json({ erro: err2.message });
        }
        console.log('[juros-adicionais] update changes:', this.changes);
        try {
          await touchAtividade({ emprestimoId: parcela.emprestimo_id });
        } catch (touchErr) {
          console.error('[touchAtividade] parcela/juros-adicionais:', touchErr);
        }
        try {
          const depois = await capturarEstadoEmprestimo(parcela.emprestimo_id, { dbHandle: db });
          await registrarAcaoEmprestimo({
            tipo: ACTION_TYPES.JUROS_ADICIONAIS_ADICIONADOS,
            origem: 'interface',
            emprestimoId: Number(parcela.emprestimo_id),
            clienteId: antes.cliente?.id || depois.cliente?.id || null,
            antes,
            depois,
            parametros: {
              parcela_id: Number(parcela.id),
              parcela_uid: parcela.parcela_uid || null,
              valor_adicionado: valorNum,
              explicacao: motivoTxt,
              data: dataISO,
            },
            resumo: `Juros adicionais registrados na parcela ${parcela.id}`,
          }, { dbHandle: db });
          await runAsync(db, 'COMMIT');
        } catch (actionError) {
          await runAsync(db, 'ROLLBACK').catch(() => {});
          console.error('[juros-adicionais] erro ao registrar acao:', actionError);
          return res.status(500).json({ erro: 'Erro ao registrar juros adicionais.' });
        }
        db.get('SELECT * FROM parcelas WHERE id = ?', [id], (err3, row) => {
          if (err3) {
            console.error('[juros-adicionais] select final erro:', err3 && err3.stack || err3);
            return res.status(500).json({ erro: err3.message });
          }
          console.log('[juros-adicionais] parcela final:', row);
          res.json({ parcela: row });
        });
      }
    );
  });
});

/**
 * Fluxo vigente de reagendamento confirmado pela UI.
 * Uma única operação atômica; os endpoints legados abaixo permanecem apenas
 * para compatibilidade e não são usados pela lista atual de parcelas.
 */
router.post('/reagendar-confirmado', async (req, res) => {
  try {
    const resultado = await reagendarParcelas(req.body || {}, {
      dbHandle: db,
      touchAtividade,
    });
    return res.json({ success: true, ...resultado });
  } catch (error) {
    const status = error?.code === 'SCHEDULE_COLLISION' ? 409 : 400;
    return res.status(status).json({
      success: false,
      error: error?.message || 'Não foi possível reagendar os vencimentos.',
      conflicts: error?.conflicts || [],
    });
  }
});

/**
 * POST /parcelas/:id/reagendar
 * body: { novaDataISO, modo: 'single' | 'cascade' }
 */
router.post('/:id/reagendar', (req, res) => {
  const { id } = req.params;
  const { novaDataISO, modo } = req.body;

  if (!novaDataISO) {
    return res
      .status(400)
      .json({ success: false, error: 'novaDataISO é obrigatória' });
  }

  const novaDataNormalizada = paraInputDate(novaDataISO);
  if (!novaDataNormalizada) {
    return res
      .status(400)
      .json({ success: false, error: 'Data inválida. Use YYYY-MM-DD.' });
  }

  const cascade = modo === 'cascade';

  // Busca a parcela alvo
  db.get(
    `SELECT id, emprestimo_id, numero, vencimento, pago, valor_pago, data_pagamento
     FROM parcelas
     WHERE id = ?`,
    [id],
    (err, parcela) => {
      if (err) {
        console.error('Erro ao buscar parcela para reagendar:', err);
        return res
          .status(500)
          .json({ success: false, error: 'Erro ao buscar parcela' });
      }
      if (!parcela) {
        return res
          .status(404)
          .json({ success: false, error: 'Parcela não encontrada' });
      }

      // Mantem a mesma regra do fluxo "alterar dia em todas":
      // so bloqueia se a flag pago estiver marcada.
      if (parcelaBloqueadaParaAlterarDia(parcela)) {
        return res.status(400).json({
          success: false,
          error: 'Não é permitido alterar o vencimento de parcela já paga.',
        });
      }

      const vencimentoOriginal = paraInputDate(parcela.vencimento);
      const deltaMeses = diffMeses(vencimentoOriginal, novaDataNormalizada);

      db.serialize(() => {
        db.run('BEGIN TRANSACTION', (errBegin) => {
          if (errBegin) {
            console.error('Erro ao iniciar transaction:', errBegin);
            return res
              .status(500)
              .json({ success: false, error: 'Erro ao iniciar transaction' });
          }

          // 1) Atualiza a parcela alvo
          db.run(
            `UPDATE parcelas SET vencimento = ? WHERE id = ?`,
            [novaDataNormalizada, parcela.id],
            function (errUpdateAtual) {
              if (errUpdateAtual) {
                console.error(
                  'Erro ao atualizar vencimento da parcela alvo:',
                  errUpdateAtual
                );
                db.run('ROLLBACK', () => {
                  return res.status(500).json({
                    success: false,
                    error: 'Erro ao atualizar parcela alvo',
                  });
                });
                return;
              }

              // Se não for cascade ou deltaMeses = 0, encerra aqui
              if (!cascade || deltaMeses === 0) {
                db.run('COMMIT', async (errCommit) => {
                  if (errCommit) {
                    console.error('Erro ao dar COMMIT:', errCommit);
                    db.run('ROLLBACK', () => {
                      return res.status(500).json({
                        success: false,
                        error: 'Erro ao salvar alterações',
                      });
                    });
                    return;
                  }

                  await runTouchWithLogs('parcelas/reagendar-single', parcela.emprestimo_id);
                  return res.json({
                    success: true,
                    modo: 'single',
                    deltaMeses,
                  });
                });
                return;
              }

              // 2) Cascade: próximas NÃO PAGAS
              db.all(
                `SELECT p.id, p.numero, p.vencimento, p.pago, p.valor_pago, p.data_pagamento
                   FROM parcelas p
                   JOIN emprestimos e ON e.id = p.emprestimo_id
                  WHERE p.emprestimo_id = ?
                    AND p.numero > ?
                    AND (p.versao IS NULL OR p.versao = e.versao_atual)
                  ORDER BY p.numero ASC`,
                [parcela.emprestimo_id, parcela.numero],
                (errProximas, proximas) => {
                  if (errProximas) {
                    console.error(
                      'Erro ao buscar proximas parcelas para cascade:',
                      errProximas
                    );
                    db.run('ROLLBACK', () => {
                      return res.status(500).json({
                        success: false,
                        error: 'Erro ao buscar parcelas seguintes',
                      });
                    });
                    return;
                  }

                  if (!proximas || proximas.length === 0) {
                    db.run('COMMIT', async (errCommit2) => {
                      if (errCommit2) {
                        console.error('Erro ao dar COMMIT:', errCommit2);
                        db.run('ROLLBACK', () => {
                          return res.status(500).json({
                            success: false,
                            error: 'Erro ao salvar alterações',
                          });
                        });
                        return;
                      }

                      await runTouchWithLogs('parcelas/reagendar-cascade', parcela.emprestimo_id);
                      return res.json({
                        success: true,
                        modo: 'cascade',
                        atualizadas: 0,
                        deltaMeses,
                      });
                    });
                    return;
                  }

                  let index = 0;
                  let countAtualizadas = 0;

                  const atualizarProxima = () => {
                    if (index >= proximas.length) {
                      db.run('COMMIT', async (errCommit3) => {
                        if (errCommit3) {
                          console.error('Erro ao dar COMMIT:', errCommit3);
                          db.run('ROLLBACK', () => {
                            return res.status(500).json({
                              success: false,
                              error: 'Erro ao salvar alterações',
                            });
                          });
                          return;
                        }

                        await runTouchWithLogs('parcelas/reagendar-cascade', parcela.emprestimo_id);
                        return res.json({
                          success: true,
                          modo: 'cascade',
                          atualizadas: countAtualizadas,
                          deltaMeses,
                        });
                      });
                      return;
                    }

                    const p = proximas[index];
                    index += 1;

                    // pula parcelas já pagas
                    if (parcelaBloqueadaParaAlterarDia(p)) {
                      atualizarProxima();
                      return;
                    }

                    const vencAntigo = paraInputDate(p.vencimento);
                    const novaDataCascade = addMonthsISO(
                      vencAntigo,
                      deltaMeses
                    );

                    db.run(
                      `UPDATE parcelas SET vencimento = ? WHERE id = ?`,
                      [novaDataCascade, p.id],
                      function (errUpdate) {
                        if (errUpdate) {
                          console.error(
                            'Erro ao atualizar parcela em cascade:',
                            errUpdate
                          );
                          db.run('ROLLBACK', () => {
                            return res.status(500).json({
                              success: false,
                              error: 'Erro ao atualizar parcelas seguintes',
                            });
                          });
                          return;
                        }

                        countAtualizadas += 1;
                        atualizarProxima();
                      }
                    );
                  };

                  atualizarProxima();
                }
              );
            }
          );
        });
      });
    }
  );
});

/**
 * POST /parcelas/emprestimo/:emprestimo_id/alterar-dia-vencimento
 * body: { novaDataISO }
 *
 * Aplica o DIA da novaDataISO a TODAS as parcelas NÃO PAGAS do empréstimo,
 * preservando ano/mês de cada parcela.
 */
router.post(
  '/emprestimo/:emprestimo_id/alterar-dia-vencimento',
  (req, res) => {
    const { emprestimo_id } = req.params;
    const { novaDataISO } = req.body;

    console.log(
      '[DEBUG alterar-dia-vencimento] emprestimo_id param =',
      emprestimo_id
    );

    if (!novaDataISO) {
      return res.status(400).json({
        success: false,
        error: 'novaDataISO é obrigatória',
      });
    }

    const norm = paraInputDate(novaDataISO);
    if (!norm) {
      return res.status(400).json({
        success: false,
        error: 'Data inválida. Use YYYY-MM-DD.',
      });
    }

    const partes = norm.split('-');
    if (partes.length !== 3) {
      return res.status(400).json({
        success: false,
        error: 'Data inválida. Use YYYY-MM-DD.',
      });
    }

    const novoDia = Number(partes[2]);
    if (!Number.isFinite(novoDia) || novoDia < 1 || novoDia > 31) {
      return res.status(400).json({
        success: false,
        error: 'Dia inválido na nova data.',
      });
    }

    db.all(
      `SELECT p.id, p.vencimento, p.pago, p.valor_pago, p.data_pagamento
         FROM parcelas p
         JOIN emprestimos e ON e.id = p.emprestimo_id
        WHERE p.emprestimo_id = ?
          AND (p.versao IS NULL OR p.versao = e.versao_atual)
        ORDER BY p.numero ASC`,
      [emprestimo_id],
      (err, rows) => {
        console.log(
          '[alterar-dia-vencimento] emprestimo_id =',
          emprestimo_id,
          'qtde parcelas encontradas =',
          rows ? rows.length : 0
        );
        if (err) {
          console.error('Erro ao buscar parcelas para alterar dia:', err);
          return res.status(500).json({
            success: false,
            error: 'Erro ao buscar parcelas',
          });
        }

        if (!rows || rows.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'Nenhuma parcela encontrada para este empréstimo.',
          });
        }

        db.serialize(() => {
          db.run('BEGIN TRANSACTION', (errBegin) => {
            if (errBegin) {
              console.error('Erro ao iniciar transaction:', errBegin);
              return res.status(500).json({
                success: false,
                error: 'Erro ao iniciar transaction',
              });
            }

            let index = 0;
            let countAtualizadas = 0;

            const atualizarProxima = () => {
              if (index >= rows.length) {
                db.run('COMMIT', async (errCommit) => {
                  if (errCommit) {
                    console.error('Erro ao dar COMMIT:', errCommit);
                    db.run('ROLLBACK', () => {
                      return res.status(500).json({
                        success: false,
                        error: 'Erro ao salvar alterações',
                      });
                    });
                    return;
                  }

                  if (countAtualizadas === 0) {
                    return res.status(400).json({
                      success: false,
                      error:
                        'Nenhuma parcela não paga foi encontrada para atualizar o dia de vencimento.',
                    });
                  }

                  try {
                    await touchAtividade({ emprestimoId: emprestimo_id });
                  } catch (touchErr) {
                    console.error('[touchAtividade] parcelas/alterar-dia:', touchErr);
                  }
                  return res.json({
                    success: true,
                    atualizadas: countAtualizadas,
                    novoDia,
                  });
                });
                return;
              }

              const p = rows[index];
              index += 1;

              // NÃO mexe em parcela já paga (regra específica deste fluxo)
              if (parcelaBloqueadaParaAlterarDia(p)) {
                atualizarProxima();
                return;
              }

              const vencAntigo = paraInputDate(p.vencimento);
              const novoVenc = aplicarNovoDia(vencAntigo, novoDia);

              db.run(
                `UPDATE parcelas SET vencimento = ? WHERE id = ?`,
                [novoVenc, p.id],
                function (errUpdate) {
                  if (errUpdate) {
                    console.error(
                      'Erro ao atualizar vencimento (alterar-dia-vencimento):',
                      errUpdate
                    );
                    db.run('ROLLBACK', () => {
                      return res.status(500).json({
                        success: false,
                        error:
                          'Erro ao atualizar vencimentos do empréstimo',
                      });
                    });
                    return;
                  }

                  countAtualizadas += 1;
                  atualizarProxima();
                }
              );
            };

            atualizarProxima();
          });
        });
      }
    );
  }
);

// DELETE - apagar parcela
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  db.run(`DELETE FROM parcelas WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ erro: err.message });
    res.json({ status: 'Parcela removida' });
  });
});

module.exports = router;
