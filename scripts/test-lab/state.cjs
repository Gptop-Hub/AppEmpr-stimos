'use strict';
const assert = require('node:assert/strict');
const { SEED, DATE, mark, all } = require('./runtime.cjs');
// Semantic financial fields only: no SQLite rowids, sequences, indexes or volatile audit clocks.
const collections = {
  clientes: ['clientes', 'nome cpf telefone endereco trabalho referencia observacao criadoEm receber_notificacoes_cobranca motivo_notificacoes_cobranca'],
  emprestimos: ['emprestimos', 'cliente_id codigo_cliente valor valor_emprestado valor_atual data modalidade taxa_juros observacao dia_pagamento capital_restante saldo_devedor versao_atual parcelas ativo'],
  parcelas: ['parcelas', 'emprestimo_id numero valor_total valor_capital valor_juros vencimento pago observacao valor_pago data_pagamento juros_adicionais juros_pendentes valor_excedente explicacao tipo_pagamento capital_restante parcela_origem_numero versao'],
  parcelasOriginais: ['parcelas_originais', 'parcela_id emprestimo_id numero valor_total valor_capital valor_juros valor_pago valor_excedente pago data_pagamento explicacao'],
  pagamentos: ['pagamentos', 'emprestimo_id valor data tipo_pagamento observacao parcela_origem renegociacao_id'],
  historicos: ['renegociacoes_historico', 'emprestimo_id versao snapshot_emprestimo snapshot_parcelas tipo observacao detalhes'],
  caixa: ['caixa_movimentos', 'tipo categoria data cliente_id cliente_nome emprestimo_id parcela_id parcela_numero data_vencimento data_pagamento valor_total valor_juros valor_capital valor_emprestimo valor_despesa descricao meta_json'],
};
const jsonFields = new Set(['snapshot_emprestimo', 'snapshot_parcelas', 'detalhes', 'meta_json']);
const refs = { cliente_id: 'clientes', emprestimo_id: 'emprestimos', emprestimoId: 'emprestimos', emprestimo_id_origem: 'emprestimos', parcela_id: 'parcelas', parcelaId: 'parcelas', pagamento_id: 'pagamentos', renegociacao_id: 'historicos', historico_id: 'historicos' };
const parcelKey = (loan, version, number) => `${loan}-V${String(version || 1).padStart(2, '0')}-P${String(number).padStart(2, '0')}`;
function transform(value, maps, context = null) {
  if (Array.isArray(value)) return value.map(v => transform(v, maps, context));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, v] of Object.entries(value)) {
    if (['created_at', 'updated_at', 'last_activity_at'].includes(key)) continue;
    const group = key === 'id' ? context : refs[key];
    if (group && v != null) {
      if (!maps[group]?.has(v)) throw Error(`Referência sem destino: ${group}.${key}=${v}`);
      result[key] = maps[group].get(v);
    } else result[key] = transform(v, maps, key === 'snapshot_emprestimo' ? 'emprestimos' : key === 'snapshot_parcelas' ? 'parcelas' : null);
  }
  return result;
}
async function exportState(db, scenarios, owned = null) {
  const raw = {};
  const maps = {};
  for (const [key, [table]] of Object.entries(collections)) {
    const rows = await all(db, `SELECT * FROM ${table} ORDER BY id`);
    raw[key] = owned ? rows.filter(row => owned[key].includes(row.id)) : rows;
    maps[key] = new Map();
  }
  for (const row of raw.clientes) maps.clientes.set(row.id, row.referencia);
  for (const row of raw.emprestimos) maps.emprestimos.set(row.id, row.codigo_cliente);
  for (const row of raw.parcelas) maps.parcelas.set(row.id, parcelKey(maps.emprestimos.get(row.emprestimo_id), row.versao, row.numero));
  for (const row of raw.historicos) {
    maps.historicos.set(row.id, `${maps.emprestimos.get(row.emprestimo_id)}-H${row.versao}`);
    for (const p of JSON.parse(row.snapshot_parcelas)) maps.parcelas.set(p.id, parcelKey(maps.emprestimos.get(row.emprestimo_id), p.versao || row.versao, p.numero));
  }
  for (const key of ['pagamentos', 'caixa', 'parcelasOriginais']) {
    const counters = new Map();
    for (const row of raw[key]) {
      const loan = maps.emprestimos.get(row.emprestimo_id);
      const count = (counters.get(loan) || 0) + 1;
      counters.set(loan, count);
      maps[key].set(row.id, `${loan}-${key}-${String(count).padStart(2, '0')}`);
    }
  }
  const dataset = { datasetVersion: 1, seed: SEED, generatedFrom: 'SISTEMA-EMPRESTIMOS PC / rotinas locais de criação, pagamento, juros e renegociação', dataReferencia: DATE, moeda: 'BRL', convencoes: { taxa_juros: 'percentual: 10 significa 10%; gerador PC aplica sobre saldo de capital por período', valores: 'reais, precisão de centavos conforme PC', parcela_origem: 'índice zero-based dentro da versão do pagamento', ids: 'identidades canônicas; importador remapeia todas as referências, inclusive snapshots', historico: 'snapshot congelado; parcela referenciada pelo caixa pode existir somente no histórico', datas: 'fixas; situação de atraso no resumo avaliada em dataReferencia' }, cenarios: scenarios };
  for (const [key, [, fields]] of Object.entries(collections)) {
    dataset[key] = raw[key].map(row => {
      const selected = { id: row.id };
      for (const field of fields.split(' ')) if (row[field] != null) selected[field] = jsonFields.has(field) ? JSON.parse(row[field]) : row[field];
      return transform(selected, maps, key);
    }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  }
  return dataset;
}
const money = n => Math.round(Number(n || 0) * 100);
function validateDataset(d) {
  assert.equal(d.datasetVersion, 1); assert.equal(d.seed, SEED); assert.equal(d.dataReferencia, DATE);
  assert.equal(d.clientes.length, 20); assert.equal(d.emprestimos.length, 100); assert.equal(d.cenarios.length, 100);
  const maps = {};
  for (const key of Object.keys(collections)) {
    maps[key] = new Map(d[key].map(r => [r.id, r]));
    assert.equal(maps[key].size, d[key].length, `IDs duplicados: ${key}`);
  }
  for (const h of d.historicos) {
    assert.equal(h.snapshot_emprestimo.taxa_juros, 10);
    assert.equal(h.snapshot_emprestimo.id, h.emprestimo_id);
    for (const p of h.snapshot_parcelas) {
      assert.equal(p.emprestimo_id, h.emprestimo_id);
      maps.parcelas.set(p.id, p);
    }
  }
  for (const [key] of Object.entries(collections)) for (const row of d[key]) {
    assert.match(row.id, /^TEST-C\d{3}/);
    for (const [field, group] of Object.entries(refs)) if (row[field] != null) assert(maps[group].has(row[field]), `${key}.${field}: ${row[field]}`);
  }
  for (const c of d.clientes) {
    assert.equal(c.observacao, mark(c.id)); assert.equal(c.referencia, c.id);
    assert.equal(c.receber_notificacoes_cobranca, 0);
    assert.equal(d.emprestimos.filter(e => e.cliente_id === c.id).length, 5);
  }
  for (const loan of d.emprestimos) {
    assert.equal(loan.taxa_juros, 10); assert.equal(loan.observacao, mark(loan.id)); assert.equal(loan.codigo_cliente, loan.id);
    const ps = d.parcelas.filter(p => p.emprestimo_id === loan.id && p.versao === loan.versao_atual);
    assert(ps.length > 0);
    assert.equal(new Set(ps.map(p => p.numero)).size, ps.length);
    for (const p of ps) {
      assert(p.valor_capital >= 0 && p.valor_juros >= 0 && (p.juros_pendentes || 0) >= 0 && (p.juros_adicionais || 0) >= 0);
      assert(/^\d{4}-\d{2}-\d{2}$/.test(p.vencimento));
      assert(money(p.valor_total) >= 0);
      if (p.pago) assert(p.data_pagamento, `Parcela paga sem data: ${p.id}`);
    }
    const payments = d.pagamentos.filter(p => p.emprestimo_id === loan.id);
    const receipts = d.caixa.filter(m => m.emprestimo_id === loan.id && m.categoria === 'PAGAMENTO');
    assert.equal(payments.reduce((s,p) => s + money(p.valor),0), receipts.reduce((s,p) => s + money(p.valor_total),0));
    for (const p of payments) {
      assert(p.valor > 0); assert(p.data <= DATE);
      const matches = receipts.filter(m => m.meta_json?.pagamento_id === p.id);
      assert.equal(matches.length, 1, `Caixa do pagamento ${p.id}`);
      const m = matches[0];
      assert.equal(money(m.valor_total), money(p.valor));
      assert.equal(money(m.valor_total), money(m.valor_juros) + money(m.valor_capital));
      assert.equal(m.data, p.data);
      const parcela = maps.parcelas.get(m.parcela_id);
      assert(parcela && parcela.emprestimo_id === loan.id);
      assert.equal(parcela.numero - 1, p.parcela_origem);
      if (p.tipo_pagamento === 'juros' || p.tipo_pagamento === 'manual_juros_parcial') assert.equal(money(m.valor_capital), 0);
    }
    const issues = d.caixa.filter(m => m.emprestimo_id === loan.id && m.categoria === 'EMPRESTIMO');
    const additional = d.historicos.filter(h => h.emprestimo_id === loan.id && h.tipo === 'adicionar_capital').reduce((s,h) => s + money(h.detalhes.valor_adicionar), 0);
    assert.equal(issues.reduce((s,m) => s + money(m.valor_emprestimo), 0), money(loan.valor_emprestado) + additional);
  }
  return { clientes: d.clientes.length, emprestimos: d.emprestimos.length, taxasDiferentesDe10: 0, parcelas: d.parcelas.length, pagamentos: d.pagamentos.length, caixa: d.caixa.length, historicos: d.historicos.length, distribuicao: d.cenarios.reduce((a,c) => { a[c.situacao] = (a[c.situacao] || 0) + 1; return a; }, {}) };
}
function summary(d, capitalRule) {
  return d.emprestimos.map(e => {
    const ps = d.parcelas.filter(p => p.emprestimo_id === e.id && p.versao === e.versao_atual);
    const capital = capitalRule(e, ps);
    const scenario = d.cenarios.find(c => c.id === e.id);
    return { cliente: e.cliente_id, emprestimo: e.id, capitalInicial: e.valor_emprestado, taxaPercentual: e.taxa_juros, quantidadeParcelas: ps.length, versaoAtual: e.versao_atual, estadoAtual: ps.every(p => p.pago) ? 'quitado' : 'em_aberto', capitalRestante: capital, valorRecebido: d.pagamentos.filter(p => p.emprestimo_id === e.id).reduce((s,p) => s + money(p.valor), 0) / 100, parcelasVencidas: ps.filter(p => !p.pago && p.vencimento < DATE).length, situacao: scenario.situacao };
  });
}
module.exports = { collections, jsonFields, refs, transform, exportState, validateDataset, summary };
