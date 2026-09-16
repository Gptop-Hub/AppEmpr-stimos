const { isPlainObject } = require('./contracts');

function toPositiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

function toBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (!s) return !!defaultValue;
    if (s === 'true' || s === '1' || s === 'sim' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'nao' || s === 'no') return false;
  }
  return !!defaultValue;
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function pickFirstId(...values) {
  for (const value of values) {
    const id = toPositiveInteger(value);
    if (id != null) return id;
  }
  return null;
}

function normalizePeriod(periodRaw) {
  const p = String(periodRaw || '').trim().toLowerCase();
  const allowed = new Set(['dia', 'semana', 'mes', 'ano', 'total', 'custom']);
  return allowed.has(p) ? p : '';
}

function normalizeParcelasTipo(tipoRaw) {
  const t = String(tipoRaw || '').trim().toLowerCase();
  const allowed = new Set(['vencidas', 'vencendo', 'todas']);
  return allowed.has(t) ? t : '';
}

function resolveToolCallWithContext({ toolName, toolArgs, entities, screenContext }) {
  const args = isPlainObject(toolArgs) ? { ...toolArgs } : {};
  const ent = isPlainObject(entities) ? entities : {};
  const ctx = isPlainObject(screenContext) ? screenContext : {};
  const selected = isPlainObject(ctx.selected_ids) ? ctx.selected_ids : {};
  const filters = isPlainObject(ctx.active_filters) ? ctx.active_filters : {};

  if (toolName === 'caixa_resumo') {
    const periodoRaw = pickFirstNonEmpty(
      args.periodo,
      ent.periodo,
      filters.periodo_caixa,
      filters.periodo
    );
    const periodo = normalizePeriod(periodoRaw);
    const de = pickFirstNonEmpty(args.de, ent.de, filters.de, filters.data_de);
    const ate = pickFirstNonEmpty(args.ate, ent.ate, filters.ate, filters.data_ate);

    if (!periodo && !de && !ate) {
      return {
        needs_clarification: true,
        clarification_question:
          'Informe o periodo da consulta de caixa (ex: hoje, ontem, este mes ou intervalo com data inicial/final).',
      };
    }

    if (periodo === 'custom' && (!de || !ate)) {
      return {
        needs_clarification: true,
        clarification_question:
          'Para periodo personalizado, preciso de data inicial e final. Pode informar?',
      };
    }

    if (periodo === 'dia' && (!de || !ate)) {
      return {
        needs_clarification: true,
        clarification_question:
          'Para consulta diaria, preciso da data exata.',
      };
    }

    return {
      needs_clarification: false,
      resolved_args: {
        periodo: periodo || (de && ate && de !== ate ? 'custom' : 'dia'),
        ...(de ? { de } : {}),
        ...(ate ? { ate } : {}),
      },
      resolved_context: {},
    };
  }

  if (toolName === 'parcelas_por_periodo') {
    const tipo =
      normalizeParcelasTipo(pickFirstNonEmpty(args.tipo, ent.tipo, filters.tipo_parcelas)) ||
      'todas';
    const de = pickFirstNonEmpty(args.de, ent.de, filters.de, filters.data_de);
    const ate = pickFirstNonEmpty(args.ate, ent.ate, filters.ate, filters.data_ate);
    const incluirPagas = toBoolean(
      args.incluirPagas != null ? args.incluirPagas : ent.incluirPagas,
      false
    );

    if (!de || !ate) {
      return {
        needs_clarification: true,
        clarification_question:
          'Informe o periodo da consulta de parcelas com data inicial e final (YYYY-MM-DD).',
      };
    }

    return {
      needs_clarification: false,
      resolved_args: {
        tipo,
        de,
        ate,
        incluirPagas,
      },
      resolved_context: {},
    };
  }

  if (toolName === 'emprestimo_detalhe') {
    const emprestimoId = pickFirstId(
      args.emprestimo_id,
      ent.emprestimo_id,
      selected.emprestimo,
      selected.emprestimo_id,
      ctx.query_params && ctx.query_params.emprestimo
    );

    if (emprestimoId == null) {
      return {
        needs_clarification: true,
        clarification_question:
          'Qual emprestimo voce quer consultar? Informe o ID ou selecione na tela.',
      };
    }

    return {
      needs_clarification: false,
      resolved_args: { emprestimo_id: emprestimoId },
      resolved_context: { emprestimo_id: emprestimoId },
    };
  }

  if (toolName === 'cliente_busca') {
    const clienteId = pickFirstId(
      args.id,
      ent.id,
      ent.cliente_id,
      selected.cliente,
      selected.cliente_id,
      ctx.query_params && ctx.query_params.cliente
    );
    const clienteNome = pickFirstNonEmpty(
      args.nome,
      ent.nome,
      ent.cliente_nome,
      ent.cliente,
      filters.nome_cliente
    );

    if (clienteId == null && !clienteNome) {
      return {
        needs_clarification: true,
        clarification_question:
          'Qual cliente voce quer consultar? Pode informar nome ou ID.',
      };
    }

    return {
      needs_clarification: false,
      resolved_args: {
        ...(clienteId != null ? { id: clienteId } : {}),
        ...(clienteNome ? { nome: clienteNome } : {}),
      },
      resolved_context: {
        ...(clienteId != null ? { cliente_id: clienteId } : {}),
      },
    };
  }

  if (toolName === 'notificacoes_pendentes') {
    return {
      needs_clarification: false,
      resolved_args: {},
      resolved_context: {},
    };
  }

  return {
    needs_clarification: true,
    clarification_question: 'Nao consegui mapear o pedido para uma consulta valida.',
  };
}

module.exports = {
  resolveToolCallWithContext,
};
