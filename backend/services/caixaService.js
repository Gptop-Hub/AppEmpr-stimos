const db = require('../models/database');
const { toISO } = require('./dateUtils');
const { runAsync, getAsync, allAsync } = require('../utils/sqliteAsync');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function f2(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function todayLocalISO() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function isIsoDate(value) {
  return typeof value === 'string' && ISO_DATE_RE.test(value);
}

function toDateOnly(value, fallbackToday = true) {
  const iso = toISO(value);
  if (iso && isIsoDate(iso)) return iso;
  return fallbackToday ? todayLocalISO() : null;
}

function startOfMonthISO(referenceISO) {
  const iso = toDateOnly(referenceISO);
  const [year, month] = iso.split('-');
  return `${year}-${month}-01`;
}

function startOfYearISO(referenceISO) {
  const iso = toDateOnly(referenceISO);
  const [year] = iso.split('-');
  return `${year}-01-01`;
}

function startOfWeekISO(referenceISO) {
  const iso = toDateOnly(referenceISO);
  const dt = new Date(`${iso}T00:00:00`);
  const weekDay = dt.getDay(); // 0 = domingo, 1 = segunda
  const diffToMonday = (weekDay + 6) % 7;
  dt.setDate(dt.getDate() - diffToMonday);
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function endOfWeekISO(referenceISO) {
  const inicioSemana = startOfWeekISO(referenceISO);
  const dt = new Date(`${inicioSemana}T00:00:00`);
  dt.setDate(dt.getDate() + 6);
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function resolvePeriodoRange({ periodo = 'custom', de, ate } = {}) {
  const modo = String(periodo || 'custom').toLowerCase();
  const hoje = todayLocalISO();

  if (modo === 'dia') {
    return { periodo: 'dia', de: hoje, ate: hoje };
  }
  if (modo === 'semana') {
    return {
      periodo: 'semana',
      de: startOfWeekISO(hoje),
      ate: endOfWeekISO(hoje),
    };
  }
  if (modo === 'mes') {
    return { periodo: 'mes', de: startOfMonthISO(hoje), ate: hoje };
  }
  if (modo === 'ano') {
    return { periodo: 'ano', de: startOfYearISO(hoje), ate: hoje };
  }
  if (modo === 'total') {
    return { periodo: 'total', de: '1900-01-01', ate: hoje };
  }

  const deISO = toDateOnly(de, false);
  const ateISO = toDateOnly(ate, false);
  if (!deISO || !ateISO) {
    throw new Error('Periodo custom exige de e ate no formato YYYY-MM-DD.');
  }
  if (deISO > ateISO) {
    throw new Error('Intervalo invalido: de deve ser menor ou igual a ate.');
  }
  return { periodo: 'custom', de: deISO, ate: ateISO };
}

async function getTableColumns(tableName, dbHandle = db) {
  const rows = await allAsync(dbHandle, `PRAGMA table_info(${tableName})`);
  return new Set((rows || []).map((row) => row && row.name).filter(Boolean));
}

function normalizeTipoPagamento(value) {
  return String(value || '').trim().toLowerCase();
}

function safeJsonParse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function inferSplitFromPagamento(payload = {}) {
  const valor = f2(payload.valor ?? payload.valor_total ?? 0);
  const tipo = normalizeTipoPagamento(payload.tipo_pagamento);
  if (
    tipo === 'juros' ||
    tipo === 'manual_juros_parcial' ||
    tipo === 'somente_juros' ||
    tipo === 'juros_parcial'
  ) {
    return { juros: valor, capital: 0 };
  }
  return { juros: 0, capital: valor };
}

function buildParcelaKeyForBackfill(payload = {}) {
  const emprestimoId = payload && payload.emprestimo_id != null
    ? Number(payload.emprestimo_id)
    : null;
  if (!Number.isFinite(emprestimoId)) return null;

  if (payload && payload.parcela_id != null && Number.isFinite(Number(payload.parcela_id))) {
    return `${emprestimoId}|id:${Math.trunc(Number(payload.parcela_id))}`;
  }
  if (payload && payload.parcela_origem != null && Number.isFinite(Number(payload.parcela_origem))) {
    return `${emprestimoId}|orig:${Math.trunc(Number(payload.parcela_origem))}`;
  }
  if (payload && payload.parcela_numero != null && Number.isFinite(Number(payload.parcela_numero))) {
    return `${emprestimoId}|num:${Math.trunc(Number(payload.parcela_numero))}`;
  }
  return null;
}

function getJurosReferenciaParcela(payload = {}) {
  return f2(
    Number(payload?.parcela_valor_juros || 0) +
      Number(payload?.parcela_juros_pendentes || 0) +
      Number(payload?.parcela_juros_adicionais || 0)
  );
}

function inferSplitFromPagamentoBackfill(payload = {}, jurosRestantePorParcela = null) {
  const valor = f2(payload.valor ?? payload.valor_total ?? 0);
  if (valor <= 0) return { juros: 0, capital: 0 };

  const tipo = normalizeTipoPagamento(payload.tipo_pagamento);
  if (
    tipo === 'juros' ||
    tipo === 'manual_juros_parcial' ||
    tipo === 'somente_juros' ||
    tipo === 'juros_parcial'
  ) {
    return { juros: valor, capital: 0 };
  }

  const tipoCompatSplitParcela =
    tipo === '' ||
    tipo === 'normal' ||
    tipo === 'adiantado_total';
  if (!tipoCompatSplitParcela) {
    return { juros: 0, capital: valor };
  }

  const parcelaKey = buildParcelaKeyForBackfill(payload);
  const jurosReferencia = getJurosReferenciaParcela(payload);
  if (!parcelaKey || jurosReferencia <= 0) {
    return { juros: 0, capital: valor };
  }

  let jurosRestante = jurosReferencia;
  if (jurosRestantePorParcela instanceof Map && jurosRestantePorParcela.has(parcelaKey)) {
    jurosRestante = f2(jurosRestantePorParcela.get(parcelaKey));
  }

  const jurosAplicado = f2(Math.min(valor, Math.max(0, jurosRestante)));
  const capitalAplicado = f2(Math.max(0, valor - jurosAplicado));

  if (jurosRestantePorParcela instanceof Map) {
    jurosRestantePorParcela.set(parcelaKey, f2(Math.max(0, jurosRestante - jurosAplicado)));
  }

  return { juros: jurosAplicado, capital: capitalAplicado };
}

function formatFingerprint({
  emprestimo_id = null,
  data = null,
  valor = 0,
  parcela_origem = null,
  tipo_pagamento = null,
}) {
  const idEmprestimo = emprestimo_id != null ? Number(emprestimo_id) : '';
  const dataISO = toDateOnly(data || null, true);
  const valorFmt = f2(valor).toFixed(2);
  const parcela = parcela_origem != null && Number.isFinite(Number(parcela_origem))
    ? String(Math.trunc(Number(parcela_origem)))
    : '';
  const tipo = normalizeTipoPagamento(tipo_pagamento);
  return `${idEmprestimo}|${dataISO}|${valorFmt}|${parcela}|${tipo}`;
}

function buildPagamentoFingerprintFromCaixaRow(row) {
  const meta = safeJsonParse(row && row.meta_json);
  const parcelaOrigemMeta = meta && meta.parcela_origem != null
    ? Number(meta.parcela_origem)
    : null;
  const parcelaOrigemFromNumero =
    row && row.parcela_numero != null && Number.isFinite(Number(row.parcela_numero))
      ? Number(row.parcela_numero) - 1
      : null;

  return formatFingerprint({
    emprestimo_id: row && row.emprestimo_id != null ? Number(row.emprestimo_id) : null,
    data: (row && (row.data_pagamento || row.data)) || null,
    valor: row && row.valor_total != null ? Number(row.valor_total) : 0,
    parcela_origem: parcelaOrigemMeta != null ? parcelaOrigemMeta : parcelaOrigemFromNumero,
    tipo_pagamento: meta && meta.tipo_pagamento != null ? meta.tipo_pagamento : null,
  });
}

function buildPagamentoFingerprintFromPagamentoRow(row) {
  return formatFingerprint({
    emprestimo_id: row && row.emprestimo_id != null ? Number(row.emprestimo_id) : null,
    data: row && row.data_pagamento ? row.data_pagamento : null,
    valor: row && row.valor != null ? Number(row.valor) : 0,
    parcela_origem:
      row && row.parcela_origem != null && Number.isFinite(Number(row.parcela_origem))
        ? Number(row.parcela_origem)
        : null,
    tipo_pagamento: row && row.tipo_pagamento != null ? row.tipo_pagamento : null,
  });
}

function normalizeMeta(meta) {
  if (!meta) return null;
  if (typeof meta === 'string') return meta;
  try {
    return JSON.stringify(meta);
  } catch {
    return null;
  }
}

async function resolveClienteContext({
  emprestimoId = null,
  clienteId = null,
  clienteNome = null,
}, dbHandle = db) {
  if (clienteId != null || clienteNome != null) {
    return {
      clienteId: clienteId != null ? Number(clienteId) : null,
      clienteNome: clienteNome != null ? String(clienteNome) : null,
    };
  }

  if (!emprestimoId) {
    return { clienteId: null, clienteNome: null };
  }

  const row = await getAsync(
    dbHandle,
    `SELECT e.cliente_id, c.nome AS cliente_nome
       FROM emprestimos e
       LEFT JOIN clientes c ON c.id = e.cliente_id
      WHERE e.id = ?`,
    [emprestimoId]
  );

  return {
    clienteId: row && row.cliente_id != null ? Number(row.cliente_id) : null,
    clienteNome: row && row.cliente_nome != null ? String(row.cliente_nome) : null,
  };
}

async function registrarMovimentoCaixa(payload = {}, dbHandle = db) {
  const tipo = String(payload.tipo || '').toUpperCase();
  const categoria = String(payload.categoria || '').toUpperCase();

  if (!tipo || !categoria) {
    throw new Error('tipo e categoria sao obrigatorios para registrar movimento de caixa.');
  }

  const dataEvento = toDateOnly(payload.data || payload.data_pagamento || payload.dataPagamento);
  const metaJson = normalizeMeta(payload.meta_json || payload.meta || null);

  const result = await runAsync(
    dbHandle,
    `INSERT INTO caixa_movimentos
      (
        tipo, categoria, data,
        cliente_id, cliente_nome, emprestimo_id, parcela_id, parcela_numero,
        data_vencimento, data_pagamento,
        valor_total, valor_juros, valor_capital, valor_emprestimo, valor_despesa,
        descricao, meta_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tipo,
      categoria,
      dataEvento,
      payload.cliente_id != null ? Number(payload.cliente_id) : null,
      payload.cliente_nome != null ? String(payload.cliente_nome) : null,
      payload.emprestimo_id != null ? Number(payload.emprestimo_id) : null,
      payload.parcela_id != null ? Number(payload.parcela_id) : null,
      payload.parcela_numero != null ? Number(payload.parcela_numero) : null,
      payload.data_vencimento != null ? toDateOnly(payload.data_vencimento, false) : null,
      payload.data_pagamento != null ? toDateOnly(payload.data_pagamento, false) : null,
      f2(payload.valor_total),
      f2(payload.valor_juros),
      f2(payload.valor_capital),
      f2(payload.valor_emprestimo),
      f2(payload.valor_despesa),
      payload.descricao != null ? String(payload.descricao) : null,
      metaJson,
    ]
  );

  return {
    id: result && result.lastID ? Number(result.lastID) : null,
    data: dataEvento,
  };
}

async function registrarEntradaPagamento(payload = {}, dbHandle = db) {
  const emprestimoId = payload.emprestimo_id != null
    ? Number(payload.emprestimo_id)
    : payload.emprestimoId != null
      ? Number(payload.emprestimoId)
      : null;

  const contexto = await resolveClienteContext(
    {
      emprestimoId,
      clienteId: payload.cliente_id ?? payload.clienteId ?? null,
      clienteNome: payload.cliente_nome ?? payload.clienteNome ?? null,
    },
    dbHandle
  );

  return registrarMovimentoCaixa(
    {
      tipo: 'ENTRADA',
      categoria: 'PAGAMENTO',
      data: payload.data || payload.data_pagamento || payload.dataPagamento,
      cliente_id: contexto.clienteId,
      cliente_nome: contexto.clienteNome,
      emprestimo_id: emprestimoId,
      parcela_id: payload.parcela_id ?? payload.parcelaId ?? null,
      parcela_numero: payload.parcela_numero ?? payload.parcelaNumero ?? null,
      data_vencimento: payload.data_vencimento ?? payload.dataVencimento ?? null,
      data_pagamento: payload.data_pagamento ?? payload.dataPagamento ?? payload.data ?? null,
      valor_total: payload.valor_total ?? payload.valorTotal ?? 0,
      valor_juros: payload.valor_juros ?? payload.valorJuros ?? 0,
      valor_capital: payload.valor_capital ?? payload.valorCapital ?? 0,
      descricao: payload.descricao || 'Pagamento registrado',
      meta_json: payload.meta_json || payload.meta || null,
      valor_emprestimo: 0,
      valor_despesa: 0,
    },
    dbHandle
  );
}

async function registrarSaidaEmprestimo(payload = {}, dbHandle = db) {
  const emprestimoId = payload.emprestimo_id != null
    ? Number(payload.emprestimo_id)
    : payload.emprestimoId != null
      ? Number(payload.emprestimoId)
      : null;

  const contexto = await resolveClienteContext(
    {
      emprestimoId,
      clienteId: payload.cliente_id ?? payload.clienteId ?? null,
      clienteNome: payload.cliente_nome ?? payload.clienteNome ?? null,
    },
    dbHandle
  );

  const valorEmprestimo = f2(
    payload.valor_emprestimo ?? payload.valorEmprestimo ?? payload.valor_total ?? payload.valorTotal ?? 0
  );

  return registrarMovimentoCaixa(
    {
      tipo: 'SAIDA',
      categoria: 'EMPRESTIMO',
      data: payload.data || payload.dataEvento || null,
      cliente_id: contexto.clienteId,
      cliente_nome: contexto.clienteNome,
      emprestimo_id: emprestimoId,
      valor_total: valorEmprestimo,
      valor_emprestimo: valorEmprestimo,
      valor_juros: 0,
      valor_capital: 0,
      valor_despesa: 0,
      descricao: payload.descricao || 'Emprestimo concedido',
      meta_json: payload.meta_json || payload.meta || null,
    },
    dbHandle
  );
}

async function registrarSaidaDespesa(payload = {}, dbHandle = db) {
  const valorDespesa = f2(payload.valor_despesa ?? payload.valorDespesa ?? payload.valor ?? 0);

  return registrarMovimentoCaixa(
    {
      tipo: 'SAIDA',
      categoria: 'DESPESA',
      data: payload.data || null,
      valor_total: valorDespesa,
      valor_despesa: valorDespesa,
      valor_juros: 0,
      valor_capital: 0,
      valor_emprestimo: 0,
      descricao: payload.descricao || payload.observacao || 'Despesa manual',
      meta_json: payload.meta_json || payload.meta || null,
    },
    dbHandle
  );
}

async function listarDespesas({ de, ate } = {}, dbHandle = db) {
  let where = "categoria = 'DESPESA'";
  const params = [];

  if (de && ate) {
    const deISO = toDateOnly(de, false);
    const ateISO = toDateOnly(ate, false);
    if (deISO && ateISO) {
      where += ' AND DATE(data) BETWEEN DATE(?) AND DATE(?)';
      params.push(deISO, ateISO);
    }
  }

  const rows = await allAsync(
    dbHandle,
    `SELECT
       id,
       DATE(data) AS data,
       descricao,
       COALESCE(valor_despesa, 0) AS valor_despesa,
       COALESCE(valor_total, 0) AS valor_total,
       meta_json,
       created_at
     FROM caixa_movimentos
     WHERE ${where}
     ORDER BY DATE(data) DESC, id DESC`,
    params
  );

  return (rows || []).map((row) => ({
    ...row,
    valor_despesa: f2(row.valor_despesa),
    valor_total: f2(row.valor_total),
  }));
}

function toPositiveIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

async function backfillMovimentosCaixa(options = {}, dbHandle = db) {
  const limiteEmprestimos = toPositiveIntOrNull(options.limiteEmprestimos);
  const limitePagamentos = toPositiveIntOrNull(options.limitePagamentos);

  const [emprestimosCols, pagamentosCols, parcelasCols, clientesCols] = await Promise.all([
    getTableColumns('emprestimos', dbHandle),
    getTableColumns('pagamentos', dbHandle),
    getTableColumns('parcelas', dbHandle),
    getTableColumns('clientes', dbHandle),
  ]);

  const clienteNomeExpr = clientesCols.has('nome') ? 'c.nome' : 'NULL';
  const valorEmprestimoExpr = emprestimosCols.has('valor_emprestado')
    ? 'COALESCE(e.valor_emprestado, e.valor, 0)'
    : 'COALESCE(e.valor, 0)';
  const dataEmprestimoExpr = emprestimosCols.has('data') ? 'DATE(e.data)' : "DATE('now')";
  const modalidadeExpr = emprestimosCols.has('modalidade') ? 'e.modalidade' : 'NULL';
  const taxaExpr = emprestimosCols.has('taxa_juros') ? 'e.taxa_juros' : 'NULL';

  const dataPagamentoExpr = pagamentosCols.has('data')
    ? 'DATE(pg.data)'
    : pagamentosCols.has('created_at')
      ? 'DATE(pg.created_at)'
      : 'NULL';
  const tipoPagamentoExpr = pagamentosCols.has('tipo_pagamento')
    ? 'pg.tipo_pagamento'
    : pagamentosCols.has('tipo')
      ? 'pg.tipo'
      : 'NULL';
  const observacaoPagamentoExpr = pagamentosCols.has('observacao') ? 'pg.observacao' : 'NULL';
  const parcelaOrigemExpr = pagamentosCols.has('parcela_origem') ? 'pg.parcela_origem' : 'NULL';

  const hasParcelaNumero = parcelasCols.has('numero');
  const hasParcelaVencimento = parcelasCols.has('vencimento');
  const hasParcelaVersao = parcelasCols.has('versao');
  const hasParcelaValorJuros = parcelasCols.has('valor_juros');
  const hasParcelaJurosPendentes = parcelasCols.has('juros_pendentes');
  const hasParcelaJurosAdicionais = parcelasCols.has('juros_adicionais');
  const hasEmprestimoVersao = emprestimosCols.has('versao_atual');

  const versaoFiltro = hasParcelaVersao && hasEmprestimoVersao
    ? 'AND (p2.versao = e.versao_atual OR p2.versao IS NULL)'
    : '';
  const parcelaNumeroFormula = pagamentosCols.has('parcela_origem')
    ? '(pg.parcela_origem + 1)'
    : 'NULL';

  const parcelaIdExpr = pagamentosCols.has('parcela_origem') && hasParcelaNumero
    ? `(
        SELECT p2.id
        FROM parcelas p2
        WHERE p2.emprestimo_id = pg.emprestimo_id
          AND p2.numero = ${parcelaNumeroFormula}
          ${versaoFiltro}
        ORDER BY p2.id DESC
        LIMIT 1
      )`
    : 'NULL';
  const parcelaNumeroExpr = pagamentosCols.has('parcela_origem')
    ? parcelaNumeroFormula
    : 'NULL';
  const dataVencimentoExpr =
    pagamentosCols.has('parcela_origem') && hasParcelaNumero && hasParcelaVencimento
      ? `(
          SELECT DATE(p2.vencimento)
          FROM parcelas p2
          WHERE p2.emprestimo_id = pg.emprestimo_id
            AND p2.numero = ${parcelaNumeroFormula}
            ${versaoFiltro}
          ORDER BY p2.id DESC
          LIMIT 1
        )`
      : 'NULL';
  const parcelaValorJurosExpr =
    pagamentosCols.has('parcela_origem') && hasParcelaNumero && hasParcelaValorJuros
      ? `(
          SELECT COALESCE(p2.valor_juros, 0)
          FROM parcelas p2
          WHERE p2.emprestimo_id = pg.emprestimo_id
            AND p2.numero = ${parcelaNumeroFormula}
            ${versaoFiltro}
          ORDER BY p2.id DESC
          LIMIT 1
        )`
      : '0';
  const parcelaJurosPendentesExpr =
    pagamentosCols.has('parcela_origem') && hasParcelaNumero && hasParcelaJurosPendentes
      ? `(
          SELECT COALESCE(p2.juros_pendentes, 0)
          FROM parcelas p2
          WHERE p2.emprestimo_id = pg.emprestimo_id
            AND p2.numero = ${parcelaNumeroFormula}
            ${versaoFiltro}
          ORDER BY p2.id DESC
          LIMIT 1
        )`
      : '0';
  const parcelaJurosAdicionaisExpr =
    pagamentosCols.has('parcela_origem') && hasParcelaNumero && hasParcelaJurosAdicionais
      ? `(
          SELECT COALESCE(p2.juros_adicionais, 0)
          FROM parcelas p2
          WHERE p2.emprestimo_id = pg.emprestimo_id
            AND p2.numero = ${parcelaNumeroFormula}
            ${versaoFiltro}
          ORDER BY p2.id DESC
          LIMIT 1
        )`
      : '0';

  const resultado = {
    emprestimos_inseridos: 0,
    emprestimos_ignorados: 0,
    emprestimos_lidos: 0,
    pagamentos_inseridos: 0,
    pagamentos_atualizados: 0,
    pagamentos_ignorados: 0,
    pagamentos_lidos: 0,
    periodo_referencia: {
      de: null,
      ate: todayLocalISO(),
    },
  };

  await runAsync(dbHandle, 'BEGIN IMMEDIATE TRANSACTION');
  try {
    const [emprestimos, pagamentos, caixaEmprestimos, caixaPagamentos] = await Promise.all([
      allAsync(
        dbHandle,
        `SELECT
           e.id AS emprestimo_id,
           e.cliente_id AS cliente_id,
           ${clienteNomeExpr} AS cliente_nome,
           ${dataEmprestimoExpr} AS data_evento,
           ${valorEmprestimoExpr} AS valor_emprestimo,
           ${modalidadeExpr} AS modalidade,
           ${taxaExpr} AS taxa_juros
         FROM emprestimos e
         LEFT JOIN clientes c ON c.id = e.cliente_id
         ORDER BY e.id ASC`
      ),
      allAsync(
        dbHandle,
        `SELECT
           pg.id AS pagamento_id,
           pg.emprestimo_id AS emprestimo_id,
           e.cliente_id AS cliente_id,
           ${clienteNomeExpr} AS cliente_nome,
           COALESCE(pg.valor, 0) AS valor,
           ${dataPagamentoExpr} AS data_pagamento,
           ${tipoPagamentoExpr} AS tipo_pagamento,
           ${observacaoPagamentoExpr} AS observacao,
            ${parcelaOrigemExpr} AS parcela_origem,
            ${parcelaIdExpr} AS parcela_id,
            ${parcelaNumeroExpr} AS parcela_numero,
            ${dataVencimentoExpr} AS data_vencimento,
            ${parcelaValorJurosExpr} AS parcela_valor_juros,
            ${parcelaJurosPendentesExpr} AS parcela_juros_pendentes,
            ${parcelaJurosAdicionaisExpr} AS parcela_juros_adicionais
          FROM pagamentos pg
          LEFT JOIN emprestimos e ON e.id = pg.emprestimo_id
          LEFT JOIN clientes c ON c.id = e.cliente_id
         ORDER BY pg.id ASC`
      ),
      allAsync(
        dbHandle,
        `SELECT
           emprestimo_id
         FROM caixa_movimentos
         WHERE UPPER(COALESCE(categoria, '')) = 'EMPRESTIMO'
           AND emprestimo_id IS NOT NULL`
      ),
      allAsync(
        dbHandle,
        `SELECT
            id,
            emprestimo_id,
            parcela_numero,
            data,
            data_pagamento,
            valor_total,
            valor_juros,
            valor_capital,
            meta_json
          FROM caixa_movimentos
          WHERE UPPER(COALESCE(categoria, '')) = 'PAGAMENTO'`
      ),
    ]);

    resultado.emprestimos_lidos = Array.isArray(emprestimos) ? emprestimos.length : 0;
    resultado.pagamentos_lidos = Array.isArray(pagamentos) ? pagamentos.length : 0;

    const emprestimosNoCaixa = new Set(
      (caixaEmprestimos || [])
        .map((row) => (row && row.emprestimo_id != null ? Number(row.emprestimo_id) : null))
        .filter((id) => Number.isFinite(id))
    );

    const pagamentoIdsNoCaixa = new Set();
    const pagamentosFingerprintNoCaixa = new Map();
    const pagamentosBackfillNoCaixa = new Map();

    for (const row of caixaPagamentos || []) {
      const meta = safeJsonParse(row && row.meta_json);
      const pagamentoIdMeta =
        meta && meta.pagamento_id != null && Number.isFinite(Number(meta.pagamento_id))
          ? Number(meta.pagamento_id)
          : null;
      if (pagamentoIdMeta != null) pagamentoIdsNoCaixa.add(pagamentoIdMeta);
      if (
        pagamentoIdMeta != null &&
        meta &&
        (meta.backfill === true || meta.origem === '/caixa/backfill')
      ) {
        const arr = pagamentosBackfillNoCaixa.get(pagamentoIdMeta) || [];
        arr.push(row);
        pagamentosBackfillNoCaixa.set(pagamentoIdMeta, arr);
      }

      const fingerprint = buildPagamentoFingerprintFromCaixaRow(row);
      const atual = pagamentosFingerprintNoCaixa.get(fingerprint) || 0;
      pagamentosFingerprintNoCaixa.set(fingerprint, atual + 1);
    }

    let emprestimosInseridos = 0;
    for (const row of emprestimos || []) {
      const emprestimoId =
        row && row.emprestimo_id != null && Number.isFinite(Number(row.emprestimo_id))
          ? Number(row.emprestimo_id)
          : null;
      if (emprestimoId == null) {
        resultado.emprestimos_ignorados += 1;
        continue;
      }

      if (emprestimosNoCaixa.has(emprestimoId)) {
        resultado.emprestimos_ignorados += 1;
        continue;
      }

      if (limiteEmprestimos != null && emprestimosInseridos >= limiteEmprestimos) {
        resultado.emprestimos_ignorados += 1;
        continue;
      }

      const dataEvento = toDateOnly(row.data_evento || null, true);
      await registrarSaidaEmprestimo(
        {
          data: dataEvento,
          cliente_id: row.cliente_id != null ? Number(row.cliente_id) : null,
          cliente_nome: row.cliente_nome || null,
          emprestimo_id: emprestimoId,
          valor_emprestimo: row.valor_emprestimo != null ? Number(row.valor_emprestimo) : 0,
          descricao: 'Emprestimo concedido (retroativo)',
          meta: {
            origem: '/caixa/backfill',
            backfill: true,
            emprestimo_id_origem: emprestimoId,
            modalidade: row.modalidade || null,
            taxa_juros: row.taxa_juros != null ? Number(row.taxa_juros) : null,
          },
        },
        dbHandle
      );
      emprestimosNoCaixa.add(emprestimoId);
      emprestimosInseridos += 1;
      resultado.emprestimos_inseridos += 1;
    }

    const pagamentosJaConsumidos = new Map();
    const jurosRestantePorParcela = new Map();
    let pagamentosInseridos = 0;
    for (const row of pagamentos || []) {
      const pagamentoId =
        row && row.pagamento_id != null && Number.isFinite(Number(row.pagamento_id))
          ? Number(row.pagamento_id)
          : null;

      const dataPagamento = toDateOnly(row.data_pagamento || null, false);
      if (!dataPagamento) {
        resultado.pagamentos_ignorados += 1;
        continue;
      }

      const valor = f2(row.valor || 0);
      if (valor <= 0) {
        resultado.pagamentos_ignorados += 1;
        continue;
      }

      const split = inferSplitFromPagamentoBackfill(row, jurosRestantePorParcela);
      const pagamentosBackfillExistentes = pagamentoId != null
        ? pagamentosBackfillNoCaixa.get(pagamentoId) || []
        : [];
      if (pagamentosBackfillExistentes.length > 0) {
        const jurosNovo = f2(split.juros);
        const capitalNovo = f2(split.capital);
        for (const rowBackfill of pagamentosBackfillExistentes) {
          const jurosAtual = f2(rowBackfill?.valor_juros || 0);
          const capitalAtual = f2(rowBackfill?.valor_capital || 0);
          if (Math.abs(jurosAtual - jurosNovo) <= 0.009 && Math.abs(capitalAtual - capitalNovo) <= 0.009) {
            continue;
          }
          await runAsync(
            dbHandle,
            `UPDATE caixa_movimentos
                SET valor_total = ?,
                    valor_juros = ?,
                    valor_capital = ?
              WHERE id = ?
                AND UPPER(COALESCE(categoria, '')) = 'PAGAMENTO'`,
            [valor, jurosNovo, capitalNovo, Number(rowBackfill.id)]
          );
          resultado.pagamentos_atualizados += 1;
        }
        resultado.pagamentos_ignorados += 1;
        continue;
      }
      if (pagamentoId != null && pagamentoIdsNoCaixa.has(pagamentoId)) {
        resultado.pagamentos_ignorados += 1;
        continue;
      }

      const fingerprint = buildPagamentoFingerprintFromPagamentoRow({
        ...row,
        data_pagamento: dataPagamento,
      });
      const jaNoCaixa = pagamentosFingerprintNoCaixa.get(fingerprint) || 0;
      const jaConsumido = pagamentosJaConsumidos.get(fingerprint) || 0;
      if (jaConsumido < jaNoCaixa) {
        pagamentosJaConsumidos.set(fingerprint, jaConsumido + 1);
        resultado.pagamentos_ignorados += 1;
        continue;
      }

      if (limitePagamentos != null && pagamentosInseridos >= limitePagamentos) {
        resultado.pagamentos_ignorados += 1;
        continue;
      }

      await registrarEntradaPagamento(
        {
          data: dataPagamento,
          data_pagamento: dataPagamento,
          cliente_id: row.cliente_id != null ? Number(row.cliente_id) : null,
          cliente_nome: row.cliente_nome || null,
          emprestimo_id: row.emprestimo_id != null ? Number(row.emprestimo_id) : null,
          parcela_id: row.parcela_id != null ? Number(row.parcela_id) : null,
          parcela_numero: row.parcela_numero != null ? Number(row.parcela_numero) : null,
          data_vencimento: row.data_vencimento || null,
          valor_total: valor,
          valor_juros: split.juros,
          valor_capital: split.capital,
          descricao: row.observacao
            ? `Pagamento retroativo: ${String(row.observacao).slice(0, 100)}`
            : 'Pagamento retroativo',
          meta: {
            origem: '/caixa/backfill',
            backfill: true,
            pagamento_id: pagamentoId,
            tipo_pagamento: row.tipo_pagamento || null,
            observacao: row.observacao || null,
            parcela_origem:
              row.parcela_origem != null && Number.isFinite(Number(row.parcela_origem))
                ? Number(row.parcela_origem)
                : null,
          },
        },
        dbHandle
      );

      pagamentosInseridos += 1;
      resultado.pagamentos_inseridos += 1;
      if (pagamentoId != null) pagamentoIdsNoCaixa.add(pagamentoId);
      pagamentosFingerprintNoCaixa.set(fingerprint, (pagamentosFingerprintNoCaixa.get(fingerprint) || 0) + 1);
    }

    const intervalo = await getAsync(
      dbHandle,
      `SELECT
         MIN(DATE(data)) AS de,
         MAX(DATE(data)) AS ate
       FROM caixa_movimentos`
    );
    resultado.periodo_referencia = {
      de: intervalorowToISO(intervalo && intervalo.de),
      ate: intervalorowToISO(intervalo && intervalo.ate) || todayLocalISO(),
    };

    await runAsync(dbHandle, 'COMMIT');
    return resultado;
  } catch (err) {
    await runAsync(dbHandle, 'ROLLBACK').catch(() => {});
    throw err;
  }
}

function intervalorowToISO(value) {
  const iso = toDateOnly(value || null, false);
  return iso && isIsoDate(iso) ? iso : null;
}

module.exports = {
  f2,
  todayLocalISO,
  toDateOnly,
  isIsoDate,
  startOfWeekISO,
  endOfWeekISO,
  resolvePeriodoRange,
  registrarMovimentoCaixa,
  registrarEntradaPagamento,
  registrarSaidaEmprestimo,
  registrarSaidaDespesa,
  listarDespesas,
  backfillMovimentosCaixa,
};
