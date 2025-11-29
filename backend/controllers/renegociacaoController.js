// backend/controllers/renegociacaoController.js
const db = require('../models/database');
const gerarParcelas = require('../utils/gerarParcelas');

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

exports.renegociarInplace = async (req, res) => {
  const emprestimoId = Number(req.params.id || 0);
  if (!emprestimoId) {
    return res.status(400).json({ ok: false, erro: 'ID inválido.' });
  }

  const {
    valor: rawValor,
    parcelas: rawParcelas,
    taxa_juros: rawTaxaJuros,
    data: rawData,
    data_pagamento: rawDataPagamento,
    observacao: rawObservacao
  } = req.body || {};

  const valor = toNumber(rawValor);
  const totalParcelas = toInt(rawParcelas);
  const taxaJuros = toNumber(rawTaxaJuros);
  const data = isDate(rawData) ? String(rawData).slice(0, 10) : null;
  const dataPagamento = isDate(rawDataPagamento)
    ? String(rawDataPagamento).slice(0, 10)
    : null;
  const observacao = (rawObservacao || '').toString();

  if (!valor || !totalParcelas || taxaJuros == null) {
    return res.status(400).json({
      ok: false,
      erro: 'valor e parcelas são obrigatórios; taxa_juros pode ser 0.'
    });
  }

  try {
    await ensureHistoricoTable();

    const hasParcelasCol = await tableHasColumn('emprestimos', 'parcelas');
    const hasUpdatedAtCol = await tableHasColumn('emprestimos', 'updated_at');
    const hasValorAtualCol = await tableHasColumn('emprestimos', 'valor_atual');
    const hasCapitalRestanteCol = await tableHasColumn('emprestimos', 'capital_restante');

    await runAsync(db, 'BEGIN');

    const emprestimo = await getAsync(
      db,
      'SELECT * FROM emprestimos WHERE id = ?',
      [emprestimoId]
    );

    if (!emprestimo) {
      await runAsync(db, 'ROLLBACK');
      return res.status(404).json({ ok: false, erro: 'Empréstimo não encontrado.' });
    }

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
      ORDER BY p.numero ASC`,
      [emprestimoId]
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

    const emprestimoAtualizado = await getAsync(
      db,
      'SELECT * FROM emprestimos WHERE id = ?',
      [emprestimoId]
    );

    await runAsync(
      db,
      `INSERT INTO renegociacoes_historico
         (emprestimo_id, versao, snapshot_emprestimo, snapshot_parcelas)
       VALUES (?, ?, ?, ?)`,
      [
        emprestimoId,
        proxVersao,
        JSON.stringify(emprestimoAtualizado || emprestimo),
        JSON.stringify(parcelasSnapshot)
      ]
    );

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
           (emprestimo_id, numero, valor_total, valor_capital, valor_juros, vencimento, pago)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        [emprestimoId, numero, valorTotal, valorCapital, valorJuros, vencimento]
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

exports.listarVersoesHistorico = async (req, res) => {
  const emprestimoId = Number(req.params.id || 0);
  if (!emprestimoId) {
    return res.status(400).json({ ok: false, erro: 'ID inválido.' });
  }

  try {
    await ensureHistoricoTable();
    const versoes = await allAsync(
      db,
      `SELECT id, versao, created_at
         FROM renegociacoes_historico
        WHERE emprestimo_id = ?
     ORDER BY versao DESC`,
      [emprestimoId]
    );
    return res.json({ ok: true, versoes });
  } catch (err) {
    console.error('listarVersoesHistorico erro:', err);
    return res.status(500).json({ ok: false, erro: 'Erro ao listar histórico.' });
  }
};

exports.obterVersaoHistorico = async (req, res) => {
  const emprestimoId = Number(req.params.id || 0);
  const versao = Number(req.params.versao || 0);

  if (!emprestimoId || !versao) {
    return res.status(400).json({ ok: false, erro: 'Parâmetros inválidos.' });
  }

  try {
    await ensureHistoricoTable();
    const row = await getAsync(
      db,
      `SELECT snapshot_emprestimo, snapshot_parcelas
         FROM renegociacoes_historico
        WHERE emprestimo_id = ? AND versao = ?`,
      [emprestimoId, versao]
    );

    if (!row) {
      return res.status(404).json({ ok: false, erro: 'Versão não encontrada.' });
    }

    return res.json({
      ok: true,
      emprestimo: JSON.parse(row.snapshot_emprestimo || '{}'),
      parcelas: JSON.parse(row.snapshot_parcelas || '[]')
    });
  } catch (err) {
    console.error('obterVersaoHistorico erro:', err);
    return res.status(500).json({ ok: false, erro: 'Erro ao obter versão.' });
  }
};
