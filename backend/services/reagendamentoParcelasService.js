const { runAsync, getAsync, allAsync } = require('../utils/sqliteAsync');
const actionService = require('./actionService');
const { ensureActionContractReady } = require('./actionIdentityService');
const { ACTION_TYPES } = require('./actionTypeContract');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function civilISO(value) {
  const text = String(value || '').trim();
  if (!DATE_RE.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? text
    : null;
}

function lastDayOfMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function addMonthsCivil(iso, months, desiredDay) {
  const valid = civilISO(iso);
  if (!valid) return null;
  const [year, month, day] = valid.split('-').map(Number);
  const monthIndex = month - 1 + Number(months || 0);
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const targetDay = Math.min(
    Math.max(1, Number.isFinite(Number(desiredDay)) ? Number(desiredDay) : day),
    lastDayOfMonth(targetYear, targetMonth)
  );
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

function changeDayCivil(iso, desiredDay) {
  const valid = civilISO(iso);
  const day = Number(desiredDay);
  if (!valid || !Number.isInteger(day) || day < 1 || day > 31) return null;
  const [year, month] = valid.split('-').map(Number);
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDayOfMonth(year, month - 1))).padStart(2, '0')}`;
}

// Conservadora por segurança: qualquer indicador de pagamento torna a parcela imutável.
function isEffectivelyPaid(parcela) {
  if (!parcela) return false;
  if (parcela.pago === 1 || parcela.pago === '1' || parcela.pago === true) return true;
  if (Number(parcela.valor_pago || 0) > 0) return true;
  return Boolean(String(parcela.data_pagamento || '').trim());
}

function periodKey(iso) {
  return String(iso || '').slice(0, 7);
}

function conflictError(message, conflicts) {
  const error = new Error(message);
  error.code = 'SCHEDULE_COLLISION';
  error.conflicts = conflicts;
  return error;
}

function validateNoCollisions(schedule) {
  const byPeriod = new Map();
  for (const parcela of schedule) {
    const due = civilISO(parcela.novo_vencimento || parcela.vencimento);
    if (!due) throw new Error(`Vencimento inválido na parcela ${parcela.numero}.`);
    const key = periodKey(due);
    const list = byPeriod.get(key) || [];
    list.push({ id: parcela.id, numero: parcela.numero, vencimento: due });
    byPeriod.set(key, list);
  }
  const conflicts = [...byPeriod.values()].filter((items) => items.length > 1);
  if (conflicts.length) {
    throw conflictError('A alteração criaria mais de uma parcela no mesmo mês do cronograma.', conflicts);
  }
}

function serializeSchedule(schedule) {
  return schedule.map((p) => ({
    id: Number(p.id),
    numero: Number(p.numero),
    vencimento: p.novo_vencimento || p.vencimento,
    pago: isEffectivelyPaid(p),
    nao_alterada: !p.alterar,
  }));
}

function formatDateBR(iso) {
  const text = String(iso || '').slice(0, 10);
  if (!civilISO(text)) return text;
  const [year, month, day] = text.split('-');
  return `${day}/${month}/${year}`;
}

function actionTypeFor() {
  return ACTION_TYPES.PARCELAS_REAGENDADAS;
}

function actionSummary({ tipo, alvo, changed, oldDay, newDay }) {
  if (tipo === 'single') {
    const parcela = changed[0];
    return `Vencimento da parcela ${parcela.numero} alterado de ${formatDateBR(parcela.vencimento)} para ${formatDateBR(parcela.novo_vencimento)}.`;
  }
  if (tipo === 'cascade') {
    return `Vencimento da parcela ${alvo.numero} e de ${Math.max(0, changed.length - 1)} parcela(s) seguinte(s) reagendado a partir de ${formatDateBR(changed[0].novo_vencimento)}.`;
  }
  return `Dia de vencimento das parcelas abertas alterado de ${oldDay} para ${newDay}.`;
}

function sqliteRowSnapshot(row) {
  const { alterar, novo_vencimento, ...sqliteRow } = row || {};
  return sqliteRow;
}

async function reagendarParcelas(input, { dbHandle, touchAtividade = null, actionApi = actionService } = {}) {
  if (!dbHandle) throw new Error('dbHandle é obrigatório.');
  const parcelaId = Number(input?.parcelaId);
  const tipo = String(input?.tipo || '');
  const novaDataISO = civilISO(input?.novaDataISO);
  const novoDia = Number(input?.novoDia);

  if (!Number.isInteger(parcelaId) || parcelaId <= 0) throw new Error('Parcela inválida.');
  if (!['single', 'cascade', 'change_day'].includes(tipo)) throw new Error('Tipo de reagendamento inválido.');
  if ((tipo === 'single' || tipo === 'cascade') && !novaDataISO) throw new Error('Informe uma data completa válida.');
  if (tipo === 'change_day' && (!Number.isInteger(novoDia) || novoDia < 1 || novoDia > 31)) {
    throw new Error('Informe um dia entre 1 e 31.');
  }

  // Mantem a migracao de identidade fora da transaction financeira. A acao
  // propriamente dita, inclusive a sequencia da origem, fica dentro dela.
  await ensureActionContractReady(dbHandle);
  await runAsync(dbHandle, 'BEGIN IMMEDIATE TRANSACTION');
  try {
    const alvo = await getAsync(dbHandle, `
      SELECT p.*, e.versao_atual, e.dia_pagamento, e.cliente_id
        FROM parcelas p
        JOIN emprestimos e ON e.id = p.emprestimo_id
       WHERE p.id = ?
         AND (p.versao IS NULL OR p.versao = e.versao_atual)
    `, [parcelaId]);
    if (!alvo) throw new Error('Parcela não encontrada no cronograma vigente.');
    if (isEffectivelyPaid(alvo)) throw new Error('Não é permitido alterar vencimento de parcela com pagamento registrado.');

    const schedule = await allAsync(dbHandle, `
      SELECT p.*
        FROM parcelas p
        JOIN emprestimos e ON e.id = p.emprestimo_id
       WHERE p.emprestimo_id = ?
         AND (p.numero IS NULL OR p.numero != -1)
         AND (p.versao IS NULL OR p.versao = e.versao_atual)
       ORDER BY p.numero ASC, p.id ASC
    `, [alvo.emprestimo_id]);
    const start = schedule.findIndex((p) => Number(p.id) === parcelaId);
    if (start < 0) throw new Error('Parcela não encontrada no cronograma vigente.');

    for (const parcela of schedule) {
      parcela.alterar = false;
      parcela.novo_vencimento = parcela.vencimento;
    }

    if (tipo === 'single') {
      schedule[start].alterar = true;
      schedule[start].novo_vencimento = novaDataISO;
    } else if (tipo === 'cascade') {
      let openOffset = 0;
      for (let index = start; index < schedule.length; index += 1) {
        const parcela = schedule[index];
        if (isEffectivelyPaid(parcela)) continue;
        parcela.alterar = true;
        parcela.novo_vencimento = addMonthsCivil(novaDataISO, openOffset, Number(novaDataISO.slice(8, 10)));
        openOffset += 1;
      }
    } else {
      for (let index = start; index < schedule.length; index += 1) {
        const parcela = schedule[index];
        if (isEffectivelyPaid(parcela)) continue;
        parcela.alterar = true;
        parcela.novo_vencimento = changeDayCivil(parcela.vencimento, novoDia);
      }
    }

    validateNoCollisions(schedule);

    const parcelasAlteradas = schedule.filter(
      (parcela) => parcela.alterar && parcela.novo_vencimento !== parcela.vencimento
    );
    const diaBase = tipo === 'cascade' ? Number(novaDataISO.slice(8, 10)) : novoDia;
    const diaPagamentoAlterado =
      (tipo === 'cascade' || tipo === 'change_day') && Number(alvo.dia_pagamento || 0) !== diaBase;

    // A mesma intencao sem mudanca efetiva nao cria mutacao nem historico falso.
    if (!parcelasAlteradas.length && !diaPagamentoAlterado) {
      await runAsync(dbHandle, 'COMMIT');
      return {
        emprestimoId: Number(alvo.emprestimo_id),
        tipo,
        cronograma: serializeSchedule(schedule),
        dia_pagamento: Number(alvo.dia_pagamento || 0) || null,
        semAlteracoes: true,
      };
    }

    const emprestimoAntes = diaPagamentoAlterado
      ? await getAsync(dbHandle, 'SELECT * FROM emprestimos WHERE id = ?', [alvo.emprestimo_id])
      : null;

    const contextoAcao = await actionApi.iniciarAcao({
      tipo: actionTypeFor(tipo),
      origem: 'interface',
      resumo: actionSummary({
        tipo,
        alvo,
        changed: parcelasAlteradas,
        oldDay: Number(alvo.dia_pagamento || 0) || null,
        newDay: diaBase,
      }),
      cliente_id: alvo.cliente_id,
      emprestimo_id: alvo.emprestimo_id,
      metadata: {
        tipo_reagendamento: tipo,
        parcela_alvo_id: Number(alvo.id),
        parcela_alvo_numero: Number(alvo.numero),
        dia_pagamento_anterior: Number(alvo.dia_pagamento || 0) || null,
        dia_pagamento_novo: diaPagamentoAlterado ? diaBase : null,
      },
    }, { dbHandle });

    if (Number.isSafeInteger(Number(alvo.cliente_id)) && Number(alvo.cliente_id) > 0) {
      await actionApi.registrarEntidade(contextoAcao, {
        entidade: 'cliente', entidade_id: alvo.cliente_id, papel: 'contexto',
      });
    }
    await actionApi.registrarEntidade(contextoAcao, {
      entidade: 'emprestimo', entidade_id: alvo.emprestimo_id, papel: 'contexto',
    });
    for (const parcela of parcelasAlteradas) {
      await actionApi.registrarEntidade(contextoAcao, {
        entidade: 'parcela', entidade_id: parcela.id,
        papel: Number(parcela.id) === parcelaId ? 'alvo' : 'afetada',
      });
      await actionApi.registrarSnapshot(contextoAcao, {
        momento: 'antes', entidade: 'parcela', entidade_id: parcela.id, dados: sqliteRowSnapshot(parcela),
      });
    }
    if (diaPagamentoAlterado) {
      await actionApi.registrarSnapshot(contextoAcao, {
        momento: 'antes', entidade: 'emprestimo', entidade_id: alvo.emprestimo_id,
        dados: emprestimoAntes,
      });
    }

    for (const parcela of parcelasAlteradas) {
      await runAsync(dbHandle, 'UPDATE parcelas SET vencimento = ? WHERE id = ?', [parcela.novo_vencimento, parcela.id]);
    }

    if (diaPagamentoAlterado) {
      await runAsync(dbHandle, 'UPDATE emprestimos SET dia_pagamento = ? WHERE id = ?', [diaBase, alvo.emprestimo_id]);
    }

    for (const parcela of parcelasAlteradas) {
      const depois = await getAsync(dbHandle, 'SELECT * FROM parcelas WHERE id = ?', [parcela.id]);
      await actionApi.registrarSnapshot(contextoAcao, {
        momento: 'depois', entidade: 'parcela', entidade_id: parcela.id, dados: depois,
      });
    }
    if (diaPagamentoAlterado) {
      const emprestimoDepois = await getAsync(dbHandle, 'SELECT * FROM emprestimos WHERE id = ?', [alvo.emprestimo_id]);
      await actionApi.registrarSnapshot(contextoAcao, {
        momento: 'depois', entidade: 'emprestimo', entidade_id: alvo.emprestimo_id, dados: emprestimoDepois,
      });
    }
    await actionApi.finalizarAcaoAplicada(contextoAcao);

    await runAsync(dbHandle, 'COMMIT');
    if (typeof touchAtividade === 'function') {
      try { await touchAtividade({ emprestimoId: alvo.emprestimo_id }); } catch (_) { /* pós-commit */ }
    }
    return {
      emprestimoId: Number(alvo.emprestimo_id),
      tipo,
      cronograma: serializeSchedule(schedule),
      dia_pagamento: diaPagamentoAlterado ? diaBase : Number(alvo.dia_pagamento || 0) || null,
    };
  } catch (error) {
    await runAsync(dbHandle, 'ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = {
  reagendarParcelas,
  __internal: { civilISO, addMonthsCivil, changeDayCivil, isEffectivelyPaid, validateNoCollisions },
};
