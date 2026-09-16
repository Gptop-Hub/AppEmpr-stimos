// backend/controllers/renegociacaoController.js
const db = require('../models/database');
const gerarParcelas = require('../utils/gerarParcelas');
const { touchAtividade } = require('../utils/touchAtividade');
const { toISO, parseToDate } = require('../services/dateUtils');
const {
  calcularCapitalRestanteComRegra,
  toNumberSafe
} = require('../services/servicoemprestimo/core');
const { registrarSaidaEmprestimo } = require('../services/caixaService');
const { aplicarRenegociacao } = require('../services/renegociacaoService');

function runAsync(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function getAsync(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function allAsync(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function tableHasColumn(table, column) {
  const rows = await allAsync(
    db,
    `PRAGMA table_info(${table});`
  );
  return rows.some((col) => col && col.name === column);
}

async function ensureHistoricoTable() {
  await runAsync(
    db,
     `CREATE TABLE IF NOT EXISTS renegociacoes_historico (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       emprestimo_id INTEGER NOT NULL,
       versao INTEGER NOT NULL,
       snapshot_emprestimo TEXT NOT NULL,
       snapshot_parcelas   TEXT NOT NULL,
       tipo TEXT,
       observacao TEXT,
       detalhes TEXT,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (emprestimo_id) REFERENCES emprestimos(id)
     )`
  );
  await runAsync(
    db,
    `CREATE INDEX IF NOT EXISTS idx_hist_emprestimo_id
       ON renegociacoes_historico(emprestimo_id)`
  );
}

const toNumber = (value) => {
  if (typeof value === 'number') return value;
  if (value == null) return null;
  const coerced = Number(String(value).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(coerced) ? coerced : null;
};

const toInt = (value) => {
  const converted = toNumber(value);
  return converted == null ? null : Math.trunc(converted);
};

const isDate = (candidate) => {
  if (!candidate) return false;
  const parsed = new Date(candidate);
  return !Number.isNaN(parsed.getTime());
};

const f2 = (n) => Number(Number(n || 0).toFixed(2));

const isParcelaPaga = (parcela) => {
  if (!parcela) return false;
  if (parcela.pago === 1 || parcela.pago === true) return true;
  const total = toNumberSafe(parcela.valor_total);
  const pago = toNumberSafe(parcela.valor_pago);
  return total > 0 && pago >= total;
};

function extrairEstruturaDaParcela(parcela) {
  const atualTotal = Number(parcela.valor_total ?? 0);
  const atualCapital = Number(parcela.valor_capital ?? 0);
  const atualJuros = Number(parcela.valor_juros ?? 0);

  const originalTotal =
    parcela.original_valor_total != null ? Number(parcela.original_valor_total) : null;
  const originalCapital =
    parcela.original_valor_capital != null ? Number(parcela.original_valor_capital) : null;
  const originalJuros =
    parcela.original_valor_juros != null ? Number(parcela.original_valor_juros) : null;

  const estruturaCapital =
    originalCapital != null
      ? originalCapital
      : originalTotal != null && originalJuros != null
        ? originalTotal - originalJuros
        : atualCapital > 0
          ? atualCapital
          : Math.max(0, atualTotal - atualJuros);

  const estruturaJuros =
    originalJuros != null
      ? originalJuros
      : originalTotal != null && originalCapital != null
        ? originalTotal - originalCapital
        : atualJuros > 0
          ? atualJuros
          : Math.max(0, atualTotal - atualCapital);

  const capital = Number(estruturaCapital.toFixed(2));
  const juros = Number(estruturaJuros.toFixed(2));
  const total = Number((capital + juros).toFixed(2));

  return {
    capital,
    juros,
    total
  };
}

function normalizarDetalhesHistorico(detalhes) {
  if (!detalhes) return null;
  if (typeof detalhes === 'object') return detalhes;
  if (typeof detalhes === 'string') {
    try {
      return JSON.parse(detalhes);
    } catch {
      return null;
    }
  }
  return null;
}

function extrairValorAdicionarDoDetalhe(detalhes) {
  const det = normalizarDetalhesHistorico(detalhes);
  if (!det) return null;

  const valor = toNumberSafe(
    det.valor_adicionar ?? det.valor_adicionado ?? det.valorAdicionar
  );

  if (!Number.isFinite(valor) || valor <= 0) return null;
  return f2(valor);
}

async function obterComposicaoValorEmprestadoEpoca(emprestimoId, emprestimo) {
  const rows = await allAsync(
    db,
    `SELECT tipo, detalhes
       FROM renegociacoes_historico
      WHERE emprestimo_id = ?
   ORDER BY versao ASC`,
    [emprestimoId]
  );

  const addicoesHistoricas = [];
  for (const row of rows || []) {
    const tipo = String(row?.tipo || '').toLowerCase();
    const valorAdicionar = extrairValorAdicionarDoDetalhe(row?.detalhes);
    const ehEventoAdicionarCapital =
      tipo === 'adicionar_capital' || valorAdicionar != null;

    if (!ehEventoAdicionarCapital || valorAdicionar == null) continue;
    addicoesHistoricas.push(f2(valorAdicionar));
  }

  const somaAddicoes = addicoesHistoricas.reduce(
    (acc, value) => acc + toNumberSafe(value),
    0
  );

  const valorAtualContrato = toNumberSafe(
    emprestimo && emprestimo.valor_atual != null
      ? emprestimo.valor_atual
      : emprestimo && emprestimo.valor != null
        ? emprestimo.valor
        : null
  );

  let valorBase = toNumberSafe(
    emprestimo && emprestimo.valor_emprestado != null
      ? emprestimo.valor_emprestado
      : emprestimo && emprestimo.valor_original != null
        ? emprestimo.valor_original
        : emprestimo && emprestimo.valor_inicial != null
          ? emprestimo.valor_inicial
          : null
  );

  if ((!Number.isFinite(valorBase) || valorBase <= 0) && valorAtualContrato > 0) {
    const baseInferida = valorAtualContrato - somaAddicoes;
    valorBase = baseInferida > 0 ? baseInferida : valorAtualContrato;
  }

  if (!Number.isFinite(valorBase) || valorBase <= 0) {
    valorBase = valorAtualContrato > 0 ? valorAtualContrato : toNumberSafe(emprestimo?.valor);
  }

  const composicao = [valorBase, ...addicoesHistoricas]
    .map((value) => f2(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  const valorEmprestadoEpoca = composicao.length
    ? f2(composicao.reduce((acc, value) => acc + toNumberSafe(value), 0))
    : null;

  return {
    valorEmprestadoBase: composicao.length ? composicao[0] : null,
    valorEmprestadoComposicao: composicao,
    valorEmprestadoEpoca
  };
}

async function obterTotalPagoEmprestimoEpoca(emprestimoId) {
  const row = await getAsync(
    db,
    `SELECT COALESCE(SUM(valor), 0) AS total_pago
       FROM pagamentos
      WHERE emprestimo_id = ?`,
    [emprestimoId]
  );
  return f2(row?.total_pago || 0);
}

async function montarSnapshotEmprestimoEpoca({
  emprestimoId,
  emprestimo,
  parcelasSnapshot,
  tipoEvento,
  observacaoEvento,
  detalhesEvento
}) {
  const {
    valorEmprestadoBase,
    valorEmprestadoComposicao,
    valorEmprestadoEpoca
  } = await obterComposicaoValorEmprestadoEpoca(emprestimoId, emprestimo);

  const totalPagoEpoca = await obterTotalPagoEmprestimoEpoca(emprestimoId);
  const capitalRestanteEpoca = calcularCapitalRestanteComRegra(
    emprestimo,
    parcelasSnapshot || []
  );

  const snapshot = {
    ...emprestimo,
    valor_emprestado_base: valorEmprestadoBase,
    valor_emprestado_composicao: valorEmprestadoComposicao,
    composicao_valor_emprestado: valorEmprestadoComposicao,
    valor_emprestado_partes: valorEmprestadoComposicao,
    valor_emprestado:
      valorEmprestadoEpoca != null
        ? valorEmprestadoEpoca
        : toNumberSafe(
            emprestimo?.valor_emprestado ??
              emprestimo?.valor_atual ??
              emprestimo?.valor
          ),
    total_pago: totalPagoEpoca,
    capital_restante: f2(capitalRestanteEpoca),
    observacao: emprestimo?.observacao ?? emprestimo?.observacoes ?? '',
    data_inicio: emprestimo?.data ?? null
  };

  if (tipoEvento) snapshot.renegociacao_tipo = tipoEvento;
  if (observacaoEvento != null) snapshot.renegociacao_observacao = observacaoEvento;
  if (detalhesEvento != null) snapshot.renegociacao_detalhes = detalhesEvento;

  return snapshot;
}

exports.renegociarInplace = async (req, res) => {
  const emprestimoId = Number(req.params.id || 0);
  if (!emprestimoId) {
    return res.status(400).json({ ok: false, erro: 'ID invÃ¡lido.' });
  }

    const {
    valor: rawValor,
    parcelas: rawParcelas,
    taxa_juros: rawTaxaJuros,
    data: rawData,
    data_pagamento: rawDataPagamento,
    observacao: rawObservacao,
    pagamento_id: rawPagamentoId
  } = req.body || {};

  const valor = toNumber(rawValor);
  const totalParcelas = toInt(rawParcelas);
  const taxaJuros = toNumber(rawTaxaJuros);
  const data = isDate(rawData) ? String(rawData).slice(0, 10) : null;
  const dataPagamento = isDate(rawDataPagamento)
    ? String(rawDataPagamento).slice(0, 10)
    : null;
  const observacao = (rawObservacao || '').toString();
  const pagamentoId =
    rawPagamentoId != null && rawPagamentoId !== ''
      ? Number(rawPagamentoId)
      : null;

  if (!valor || !totalParcelas || taxaJuros == null) {
    return res.status(400).json({
      ok: false,
      erro: 'valor e parcelas sÃ£o obrigatÃ³rios; taxa_juros pode ser 0.'
    });
  }

  try {
    const result = await aplicarRenegociacao({
      emprestimo_id: emprestimoId,
      valor,
      parcelas: totalParcelas,
      taxa_juros: taxaJuros,
      data,
      data_pagamento: dataPagamento,
      observacao,
      pagamento_id: pagamentoId,
    }, null, { dbHandle: db, touchAtividade });
    return res.json({ ok: true, id: emprestimoId, versao: result.versao, historico_id: result.historico_id });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err && err.message ? err.message : 'Erro ao renegociar.' });
  }

  try {
    await ensureHistoricoTable();

    const hasParcelasCol = await tableHasColumn('emprestimos', 'parcelas');
    const hasUpdatedAtCol = await tableHasColumn('emprestimos', 'updated_at');
    const hasValorAtualCol = await tableHasColumn('emprestimos', 'valor_atual');
    const hasCapitalRestanteCol = await tableHasColumn('emprestimos', 'capital_restante');
    const hasRenegociacaoIdCol = await tableHasColumn('pagamentos', 'renegociacao_id');
    const hasTipoCol = await tableHasColumn('renegociacoes_historico', 'tipo');
    const hasObservacaoCol = await tableHasColumn('renegociacoes_historico', 'observacao');
    const hasDetalhesCol = await tableHasColumn('renegociacoes_historico', 'detalhes');

    await runAsync(db, 'BEGIN');

    const emprestimo = await getAsync(
      db,
      'SELECT * FROM emprestimos WHERE id = ?',
      [emprestimoId]
    );

    if (!emprestimo) {
      await runAsync(db, 'ROLLBACK');
      return res.status(404).json({ ok: false, erro: 'EmprÃ©stimo nÃ£o encontrado.' });
    }

    const versaoAtual = Number(emprestimo.versao_atual || 1);

    const parcelasBrutas = await allAsync(
      db,
      `SELECT
         p.*,
         po.valor_total   AS original_valor_total,
         po.valor_capital AS original_valor_capital,
         po.valor_juros   AS original_valor_juros
       FROM parcelas p
       LEFT JOIN parcelas_originais po
         ON po.emprestimo_id = p.emprestimo_id
        AND po.numero = p.numero
      WHERE p.emprestimo_id = ?
        AND (p.versao IS NULL OR p.versao = ?)
      ORDER BY p.numero ASC`,
      [emprestimoId, versaoAtual]
    );

    const parcelasSnapshot = parcelasBrutas.map((parcela) => {
      const estrutura = extrairEstruturaDaParcela(parcela);

      return {
        ...parcela,
        valor_total: estrutura.total,
        valor_capital: estrutura.capital,
        valor_juros: estrutura.juros,
        estrutura_valor_total: estrutura.total,
        estrutura_valor_capital: estrutura.capital,
        estrutura_valor_juros: estrutura.juros
      };
    });

    const rowVersao = await getAsync(
      db,
      'SELECT MAX(versao) AS ultima FROM renegociacoes_historico WHERE emprestimo_id = ?',
      [emprestimoId]
    );
    const proxVersao = Number(rowVersao?.ultima || 0) + 1;

    let pagamentoInfo = null;
    if (Number.isFinite(pagamentoId)) {
      pagamentoInfo = await getAsync(
        db,
        'SELECT id, valor, data, tipo_pagamento, observacao, parcela_origem FROM pagamentos WHERE id = ? AND emprestimo_id = ?',
        [pagamentoId, emprestimoId]
      );
    }

    let parcelaNumero = null;
    let parcelaValorTotal = null;
    let parcelaValorCapital = null;
    let parcelaValorJuros = null;

    if (pagamentoInfo && pagamentoInfo.parcela_origem != null) {
      const origemNum = Number(pagamentoInfo.parcela_origem);
      if (Number.isFinite(origemNum)) {
        parcelaNumero = Math.max(0, Math.trunc(origemNum)) + 1;
        const parcelaOrigem = parcelasSnapshot.find(
          (p) => Number(p.numero) === Number(parcelaNumero)
        );
        if (parcelaOrigem) {
          const totalBruto =
            parcelaOrigem.valor_total != null
              ? Number(parcelaOrigem.valor_total)
              : Number(
                  (Number(parcelaOrigem.valor_capital || 0) +
                    Number(parcelaOrigem.valor_juros || 0)).toFixed(2)
                );
          parcelaValorTotal = f2(totalBruto || 0);
          parcelaValorCapital = f2(parcelaOrigem.valor_capital || 0);
          parcelaValorJuros = f2(parcelaOrigem.valor_juros || 0);
        }
      }
    }

    const detalhes = pagamentoInfo
      ? {
          motivo: 'pagamento_excedente',
          pagamento_id: pagamentoInfo.id,
          valor_pago: f2(pagamentoInfo.valor || 0),
          data_pagamento: pagamentoInfo.data || null,
          tipo_pagamento: pagamentoInfo.tipo_pagamento || null,
          observacao_pagamento: pagamentoInfo.observacao || '',
          parcela_numero: parcelaNumero,
          valor_parcela: parcelaValorTotal,
          valor_parcela_capital: parcelaValorCapital,
          valor_parcela_juros: parcelaValorJuros
        }
      : { motivo: 'renegociacao_manual' };

    const snapshotEmprestimo = await montarSnapshotEmprestimoEpoca({
      emprestimoId,
      emprestimo,
      parcelasSnapshot,
      tipoEvento: pagamentoInfo ? 'pagamento_excedente' : 'renegociacao_manual',
      observacaoEvento: observacao || '',
      detalhesEvento: detalhes
    });

    const historicoCols = [
      'emprestimo_id',
      'versao',
      'snapshot_emprestimo',
      'snapshot_parcelas'
    ];
    const historicoParams = [
      emprestimoId,
      proxVersao,
      JSON.stringify(snapshotEmprestimo),
      JSON.stringify(parcelasSnapshot)
    ];

    if (hasTipoCol) {
      historicoCols.push('tipo');
      historicoParams.push(
        pagamentoInfo ? 'pagamento_excedente' : 'renegociacao_manual'
      );
    }
    if (hasObservacaoCol) {
      historicoCols.push('observacao');
      historicoParams.push(observacao || '');
    }
    if (hasDetalhesCol) {
      historicoCols.push('detalhes');
      historicoParams.push(JSON.stringify(detalhes));
    }

    const historicoSql = `INSERT INTO renegociacoes_historico
      (${historicoCols.join(', ')})
      VALUES (${historicoCols.map(() => '?').join(', ')})`;

    const historicoResult = await runAsync(db, historicoSql, historicoParams);

    if (hasRenegociacaoIdCol && Number.isFinite(pagamentoId)) {
      await runAsync(
        db,
        'UPDATE pagamentos SET renegociacao_id = ? WHERE id = ? AND emprestimo_id = ?',
        [historicoResult?.lastID ?? null, pagamentoId, emprestimoId]
      );
    }

    await runAsync(db, 'DELETE FROM parcelas WHERE emprestimo_id = ?', [emprestimoId]);
    await runAsync(db, 'DELETE FROM parcelas_originais WHERE emprestimo_id = ?', [emprestimoId]);

    const sets = ['valor = ?', 'taxa_juros = ?', 'observacao = ?'];
    const params = [valor, taxaJuros, observacao || emprestimo.observacao || ''];

    if (hasValorAtualCol) {
      sets.push('valor_atual = ?');
      params.push(valor);
    }

    if (hasParcelasCol) {
      sets.push('parcelas = ?');
      params.push(totalParcelas);
    }

    if (data) {
      sets.push('data = ?');
      params.push(data);
    }

    if (hasCapitalRestanteCol) {
      sets.push('capital_restante = ?');
      params.push(valor);
    }

    if (hasUpdatedAtCol) {
      sets.push('updated_at = CURRENT_TIMESTAMP');
    }

    const updateSql = `UPDATE emprestimos SET ${sets.join(', ')} WHERE id = ?`;
    params.push(emprestimoId);
    await runAsync(db, updateSql, params);

    const novasParcelas = gerarParcelas({
      capital: Number(valor),
      taxa_juros: Number(taxaJuros),
      qtdParcelas: Number(totalParcelas),
      dataInicio: data || emprestimo.data,
      primeiroVencimento: dataPagamento || null,
      diaPagamento: undefined
    });

    for (let i = 0; i < novasParcelas.length; i++) {
      const nova = novasParcelas[i];
      const numero = Number(nova.numero || i + 1);
      const valorCapital = Number(nova.valor_capital || 0);
      const valorJuros = Number(nova.valor_juros || 0);
      const valorTotal =
        nova.valor_total != null
          ? Number(nova.valor_total)
          : Number((valorCapital + valorJuros).toFixed(2));
      const vencimento = nova.vencimento_iso || nova.vencimento || null;

      await runAsync(
        db,
        `INSERT INTO parcelas
           (emprestimo_id, numero, valor_total, valor_capital, valor_juros, vencimento, pago, versao)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        [emprestimoId, numero, valorTotal, valorCapital, valorJuros, vencimento, versaoAtual]
      );

      await runAsync(
        db,
        `INSERT INTO parcelas_originais
           (emprestimo_id, numero, valor_total, valor_capital, valor_juros, valor_pago, valor_excedente, pago, data_pagamento)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0, NULL)`,
        [emprestimoId, numero, valorTotal, valorCapital, valorJuros]
      );
    }

    await runAsync(db, 'COMMIT');
    try {
      await touchAtividade({ emprestimoId });
    } catch (touchErr) {
      console.error('[touchAtividade] renegociar-inplace:', touchErr);
    }
    return res.json({ ok: true, id: emprestimoId, versao: proxVersao });
  } catch (err) {
    try {
      await runAsync(db, 'ROLLBACK');
    } catch {
      /* ignore */
    }
    console.error('[renegociarInplace] erro:', err);
    return res.status(500).json({
      ok: false,
      erro: err && err.message ? err.message : 'Erro ao renegociar.'
    });
  }
};

exports.adicionarCapital = async (req, res) => {
  const emprestimoId = Number(req.params.id || 0);
  if (!emprestimoId) {
    return res.status(400).json({ ok: false, erro: 'ID inv\u00e1lido.' });
  }

  const {
    valor_adicionar: rawValorAdicionar,
    qtd_parcelas: rawQtdParcelas,
    juros_mes: rawJurosMes,
    primeiro_vencimento: rawPrimeiroVencimento,
    observacao: rawObservacao
  } = req.body || {};

  const valorAdicionar = toNumber(rawValorAdicionar);
  const qtdParcelas = toInt(rawQtdParcelas);
  const jurosMes = toNumber(rawJurosMes);
  const primeiroVencimentoISO = toISO(rawPrimeiroVencimento);
  const observacao = (rawObservacao || '').toString();

  if (valorAdicionar == null || valorAdicionar <= 0) {
    return res.status(400).json({ ok: false, erro: 'valor_adicionar inv\u00e1lido.' });
  }
  if (!qtdParcelas || qtdParcelas < 1) {
    return res.status(400).json({ ok: false, erro: 'qtd_parcelas inv\u00e1lido.' });
  }
  if (jurosMes == null || jurosMes < 0) {
    return res.status(400).json({ ok: false, erro: 'juros_mes inv\u00e1lido.' });
  }
  if (!primeiroVencimentoISO) {
    return res.status(400).json({ ok: false, erro: 'primeiro_vencimento inv\u00e1lido.' });
  }

  try {
    await ensureHistoricoTable();

    const hasAtivoCol = await tableHasColumn('emprestimos', 'ativo');
    const hasParcelasCol = await tableHasColumn('emprestimos', 'parcelas');
    const hasUpdatedAtCol = await tableHasColumn('emprestimos', 'updated_at');
    const hasValorAtualCol = await tableHasColumn('emprestimos', 'valor_atual');
    const hasValorEmprestadoCol = await tableHasColumn('emprestimos', 'valor_emprestado');
    const hasCapitalRestanteCol = await tableHasColumn('emprestimos', 'capital_restante');
    const hasDiaPagamentoCol = await tableHasColumn('emprestimos', 'dia_pagamento');
    const hasVersaoAtualCol = await tableHasColumn('emprestimos', 'versao_atual');
    const hasVersaoParcelaCol = await tableHasColumn('parcelas', 'versao');

    const hasTipoCol = await tableHasColumn('renegociacoes_historico', 'tipo');
    const hasObservacaoCol = await tableHasColumn('renegociacoes_historico', 'observacao');
    const hasDetalhesCol = await tableHasColumn('renegociacoes_historico', 'detalhes');

    await runAsync(db, 'BEGIN');

    const emprestimo = await getAsync(
      db,
      'SELECT * FROM emprestimos WHERE id = ?',
      [emprestimoId]
    );

    if (!emprestimo) {
      await runAsync(db, 'ROLLBACK');
      return res.status(404).json({ ok: false, erro: 'Empr\u00e9stimo n\u00e3o encontrado.' });
    }

    if (hasAtivoCol && Number(emprestimo.ativo) === 0) {
      await runAsync(db, 'ROLLBACK');
      return res.status(400).json({ ok: false, erro: 'Empr\u00e9stimo n\u00e3o est\u00e1 ativo.' });
    }

    const observacaoAtualizada =
      observacao && observacao.trim() ? observacao : emprestimo.observacao || '';

    const versaoAtual = Number(emprestimo.versao_atual || 1);
    const novaVersao = versaoAtual + 1;

    if (hasVersaoParcelaCol) {
      await runAsync(
        db,
        'UPDATE parcelas SET versao = ? WHERE emprestimo_id = ? AND (versao IS NULL)',
        [versaoAtual, emprestimoId]
      );
    }

    const parcelasAtuais = await allAsync(
      db,
      `SELECT * FROM parcelas
       WHERE emprestimo_id = ?
         AND (versao IS NULL OR versao = ?)
       ORDER BY numero ASC, id ASC`,
      [emprestimoId, versaoAtual]
    );

    const capitalRestanteAtual = calcularCapitalRestanteComRegra(
      emprestimo,
      parcelasAtuais
    );
    const novoCapital = f2(capitalRestanteAtual + valorAdicionar);

    const parcelasBrutas = await allAsync(
      db,
      `SELECT
         p.*,
         po.valor_total   AS original_valor_total,
         po.valor_capital AS original_valor_capital,
         po.valor_juros   AS original_valor_juros
       FROM parcelas p
       LEFT JOIN parcelas_originais po
         ON po.emprestimo_id = p.emprestimo_id
        AND po.numero = p.numero
      WHERE p.emprestimo_id = ?
        AND (p.versao IS NULL OR p.versao = ?)
      ORDER BY p.numero ASC, p.id ASC`,
      [emprestimoId, versaoAtual]
    );

    const parcelasSnapshot = parcelasBrutas.map((parcela) => {
      const estrutura = extrairEstruturaDaParcela(parcela);

      return {
        ...parcela,
        valor_total: estrutura.total,
        valor_capital: estrutura.capital,
        valor_juros: estrutura.juros,
        estrutura_valor_total: estrutura.total,
        estrutura_valor_capital: estrutura.capital,
        estrutura_valor_juros: estrutura.juros
      };
    });

    const rowVersao = await getAsync(
      db,
      'SELECT MAX(versao) AS ultima FROM renegociacoes_historico WHERE emprestimo_id = ?',
      [emprestimoId]
    );
    const proxVersao = Number(rowVersao?.ultima || 0) + 1;

    const detalhes = {
      valor_adicionar: f2(valorAdicionar),
      capital_restante_anterior: f2(capitalRestanteAtual),
      novo_capital: f2(novoCapital),
      qtd_parcelas: qtdParcelas,
      juros_mes: f2(jurosMes),
      primeiro_vencimento: primeiroVencimentoISO,
      versao_anterior: versaoAtual,
      versao_nova: novaVersao
    };

    const snapshotEmprestimo = await montarSnapshotEmprestimoEpoca({
      emprestimoId,
      emprestimo,
      parcelasSnapshot,
      tipoEvento: 'adicionar_capital',
      observacaoEvento: observacao || '',
      detalhesEvento: detalhes
    });

    const historicoCols = [
      'emprestimo_id',
      'versao',
      'snapshot_emprestimo',
      'snapshot_parcelas'
    ];
    const historicoParams = [
      emprestimoId,
      proxVersao,
      JSON.stringify(snapshotEmprestimo),
      JSON.stringify(parcelasSnapshot)
    ];

    if (hasTipoCol) {
      historicoCols.push('tipo');
      historicoParams.push('adicionar_capital');
    }
    if (hasObservacaoCol) {
      historicoCols.push('observacao');
      historicoParams.push(observacao || '');
    }
    if (hasDetalhesCol) {
      historicoCols.push('detalhes');
      historicoParams.push(JSON.stringify(detalhes));
    }

    const historicoSql = `INSERT INTO renegociacoes_historico
      (${historicoCols.join(', ')})
      VALUES (${historicoCols.map(() => '?').join(', ')})`;
    const historicoResult = await runAsync(db, historicoSql, historicoParams);
    const historicoId = historicoResult?.lastID ?? null;

    await runAsync(
      db,
      'DELETE FROM parcelas_originais WHERE emprestimo_id = ?',
      [emprestimoId]
    );

    const novasParcelas = gerarParcelas({
      capital: Number(novoCapital),
      taxa_juros: Number(jurosMes),
      qtdParcelas: Number(qtdParcelas),
      dataInicio: emprestimo.data || new Date(),
      primeiroVencimento: primeiroVencimentoISO,
      diaPagamento: undefined
    });

    const parcelasInseridas = [];

    for (let i = 0; i < novasParcelas.length; i++) {
      const nova = novasParcelas[i];
      const numero = Number(i + 1);
      const valorCapital = f2(nova.valor_capital || 0);
      const valorJuros = f2(nova.valor_juros || 0);
      const valorTotal =
        nova.valor_total != null
          ? f2(nova.valor_total)
          : f2(valorCapital + valorJuros);
      const vencimento = nova.vencimento_iso || nova.vencimento || null;

      await runAsync(
        db,
        `INSERT INTO parcelas
          (emprestimo_id, numero, valor_total, valor_capital, valor_juros, vencimento, pago, valor_pago, valor_excedente, juros_adicionais, juros_pendentes, observacao, versao)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, '', ?)`,
        [
          emprestimoId,
          numero,
          valorTotal,
          valorCapital,
          valorJuros,
          vencimento,
          novaVersao
        ]
      );

      await runAsync(
        db,
        `INSERT INTO parcelas_originais
          (emprestimo_id, numero, valor_total, valor_capital, valor_juros, valor_pago, valor_excedente, pago, data_pagamento)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0, NULL)`,
        [emprestimoId, numero, valorTotal, valorCapital, valorJuros]
      );

      parcelasInseridas.push({
        ...nova,
        numero,
        vencimento,
        valor_total: valorTotal,
        valor_capital: valorCapital,
        valor_juros: valorJuros,
        valor_pago: 0,
        pago: 0,
        versao: novaVersao
      });
    }

    const diaPagamentoDate = parseToDate(primeiroVencimentoISO);
    const diaPagamento = diaPagamentoDate ? diaPagamentoDate.getDate() : null;

    const sets = ['taxa_juros = ?', 'valor = ?', 'observacao = ?'];
    const params = [Number(jurosMes), novoCapital, observacaoAtualizada];

    if (hasValorAtualCol) {
      sets.push('valor_atual = ?');
      params.push(novoCapital);
    }

    if (hasCapitalRestanteCol) {
      sets.push('capital_restante = ?');
      params.push(f2(novoCapital));
    }

    if (hasValorEmprestadoCol && emprestimo.valor_emprestado == null) {
      const baseValorEmprestado = toNumberSafe(
        emprestimo.valor_atual != null ? emprestimo.valor_atual : emprestimo.valor
      );
      sets.push('valor_emprestado = ?');
      params.push(f2(baseValorEmprestado));
    }

    if (hasParcelasCol) {
      sets.push('parcelas = ?');
      params.push(qtdParcelas);
    }

    if (hasVersaoAtualCol) {
      sets.push('versao_atual = ?');
      params.push(novaVersao);
    }

    if (hasDiaPagamentoCol && diaPagamento != null) {
      sets.push('dia_pagamento = ?');
      params.push(diaPagamento);
    }

    if (hasUpdatedAtCol) {
      sets.push('updated_at = CURRENT_TIMESTAMP');
    }

    const updateSql = `UPDATE emprestimos SET ${sets.join(', ')} WHERE id = ?`;
    params.push(emprestimoId);
    await runAsync(db, updateSql, params);

    const emprestimoAtualizado = await getAsync(
      db,
      'SELECT * FROM emprestimos WHERE id = ?',
      [emprestimoId]
    );

    await registrarSaidaEmprestimo(
      {
        emprestimo_id: emprestimoId,
        cliente_id: emprestimo && emprestimo.cliente_id != null ? Number(emprestimo.cliente_id) : null,
        valor_emprestimo: f2(valorAdicionar),
        descricao: 'Capital adicionado ao contrato',
        meta: {
          origem: '/emprestimos/:id/adicionar-capital',
          versao_anterior: versaoAtual,
          versao_nova: novaVersao,
          historico_id: historicoId,
          juros_mes: f2(jurosMes),
          qtd_parcelas: qtdParcelas,
          primeiro_vencimento: primeiroVencimentoISO,
        },
      },
      db
    );

    await runAsync(db, 'COMMIT');
    try {
      await touchAtividade({ emprestimoId });
    } catch (touchErr) {
      console.error('[touchAtividade] adicionar-capital:', touchErr);
    }

    return res.json({
      ok: true,
      id: emprestimoId,
      versao: proxVersao,
      historico_id: historicoId,
      emprestimo: emprestimoAtualizado,
      parcelas_novas: parcelasInseridas
    });
  } catch (err) {
    try {
      await runAsync(db, 'ROLLBACK');
    } catch {
      /* ignore */
    }
    console.error('[adicionarCapital] erro:', err);
    return res.status(500).json({
      ok: false,
      erro: err && err.message ? err.message : 'Erro ao adicionar capital.'
    });
  }
};

exports.listarVersoesHistorico = async (req, res) => {
  const emprestimoId = Number(req.params.id || 0);
  if (!emprestimoId) {
    return res.status(400).json({ ok: false, erro: 'ID invÃ¡lido.' });
  }

  try {
    await ensureHistoricoTable();
    const versoes = await allAsync(
      db,
      `SELECT id, versao, created_at, tipo, observacao, detalhes
         FROM renegociacoes_historico
        WHERE emprestimo_id = ?
     ORDER BY versao DESC`,
      [emprestimoId]
    );
    return res.json({ ok: true, versoes });
  } catch (err) {
    console.error('listarVersoesHistorico erro:', err);
    return res.status(500).json({ ok: false, erro: 'Erro ao listar histÃ³rico.' });
  }
};

exports.obterVersaoHistorico = async (req, res) => {
  const emprestimoId = Number(req.params.id || 0);
  const versao = Number(req.params.versao || 0);

  if (!emprestimoId || !versao) {
    return res.status(400).json({ ok: false, erro: 'ParÃ¢metros invÃ¡lidos.' });
  }

  try {
    await ensureHistoricoTable();
    const row = await getAsync(
      db,
      `SELECT snapshot_emprestimo, snapshot_parcelas, tipo, observacao, detalhes, created_at
         FROM renegociacoes_historico
        WHERE emprestimo_id = ? AND versao = ?`,
      [emprestimoId, versao]
    );

    if (!row) {
      return res.status(404).json({ ok: false, erro: 'VersÃ£o nÃ£o encontrada.' });
    }

    let detalhes = null;
    if (row.detalhes) {
      try {
        detalhes = JSON.parse(row.detalhes);
      } catch {
        detalhes = row.detalhes;
      }
    }

    return res.json({
      ok: true,
      emprestimo: JSON.parse(row.snapshot_emprestimo || '{}'),
      parcelas: JSON.parse(row.snapshot_parcelas || '[]'),
      tipo: row.tipo || null,
      observacao: row.observacao || null,
      detalhes,
      criado_em: row.created_at || null
    });
  } catch (err) {
    console.error('obterVersaoHistorico erro:', err);
    return res.status(500).json({ ok: false, erro: 'Erro ao obter versÃ£o.' });
  }
};

