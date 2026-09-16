import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { AppIcon } from './menu';
import './relatorioFinanceiroPainel.css';

const FORMATTER_BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 2,
});

function toISODate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function fromISODate(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatDate(value) {
  const date = fromISODate(value);
  return date
    ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date)
    : '--';
}

function getRange(mode) {
  const today = new Date();
  const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  if (mode === 'semana') {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { de: toISODate(start), ate: toISODate(end) };
  }
  if (mode === 'mes') {
    return {
      de: toISODate(new Date(today.getFullYear(), today.getMonth(), 1)),
      ate: toISODate(endOfMonth),
    };
  }
  if (mode === 'ano') {
    return {
      de: `${today.getFullYear()}-01-01`,
      ate: `${today.getFullYear()}-12-31`,
    };
  }
  const iso = toISODate(today);
  return { de: iso, ate: iso };
}

function differenceInDays(de, ate) {
  const start = fromISODate(de);
  const end = fromISODate(ate);
  return start && end ? Math.round((end - start) / 86400000) : 0;
}

function chartLabel(key, grouping) {
  if (grouping === 'mes') {
    const [year, month] = key.split('-').map(Number);
    return new Intl.DateTimeFormat('pt-BR', { month: 'short', year: '2-digit' })
      .format(new Date(year, month - 1, 1))
      .replace('.', '');
  }
  return key.slice(8, 10);
}

function emptyPayload(de, ate, agrupamento) {
  return {
    periodo: { de, ate, agrupamento },
    indicadores: {},
    serie: [],
  };
}

export default function RelatorioFinanceiroPainel() {
  const [mode, setMode] = useState('mes');
  const initialRange = useMemo(() => getRange('mes'), []);
  const [customRange, setCustomRange] = useState(initialRange);
  const [appliedCustomRange, setAppliedCustomRange] = useState(initialRange);
  const [data, setData] = useState(() => emptyPayload(initialRange.de, initialRange.ate, 'dia'));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [requestKey, setRequestKey] = useState(0);
  const [detalhe, setDetalhe] = useState(null);

  const selectedRange = useMemo(
    () => (mode === 'personalizado' ? appliedCustomRange : getRange(mode)),
    [appliedCustomRange, mode]
  );
  const grouping = mode === 'ano' || (mode === 'personalizado' && differenceInDays(selectedRange.de, selectedRange.ate) > 31)
    ? 'mes'
    : 'dia';
  const singleDay = selectedRange.de === selectedRange.ate;

  const load = useCallback(async () => {
    if (!selectedRange.de || !selectedRange.ate || selectedRange.ate < selectedRange.de) return;
    setLoading(true);
    setError('');
    try {
      const response = await axios.get('/relatorios/home/painel-financeiro', {
        params: { de: selectedRange.de, ate: selectedRange.ate, agrupamento: grouping },
        headers: { 'Cache-Control': 'no-store' },
      });
      setData(response?.data || emptyPayload(selectedRange.de, selectedRange.ate, grouping));
    } catch (_) {
      setError('Não foi possível carregar o relatório financeiro.');
    } finally {
      setLoading(false);
    }
  }, [grouping, selectedRange.ate, selectedRange.de]);

  useEffect(() => { load(); }, [load, requestKey]);

  useEffect(() => {
    const refreshOnReturn = () => {
      if (document.visibilityState === 'visible') setRequestKey((current) => current + 1);
    };
    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshOnReturn);
    return () => {
      window.removeEventListener('focus', refreshOnReturn);
      document.removeEventListener('visibilitychange', refreshOnReturn);
    };
  }, []);

  const indicators = data?.indicadores || {};
  const chartMax = Math.max(1, ...(data?.serie || []).flatMap((item) => [Number(item.previsto) || 0, Number(item.recebido) || 0]));
  const hasMovement = (Number(indicators.previsto) || 0) > 0 || (Number(indicators.recebido) || 0) > 0;
  const applyCustom = () => {
    if (!customRange.de || !customRange.ate) {
      setError('Informe as duas datas do período personalizado.');
      return;
    }
    if (customRange.ate < customRange.de) {
      setError('A data final não pode ser anterior à data inicial.');
      return;
    }
    setAppliedCustomRange({ ...customRange });
    setRequestKey((current) => current + 1);
  };

  const openDetalhe = async (card) => {
    if (!card.metric || card.value == null) {
      setDetalhe({
        titulo: card.label,
        tipoValor: card.type || 'currency',
        rows: [],
        loading: false,
        mensagem: 'Este valor não possui uma composição histórica separada no banco.',
      });
      return;
    }
    setDetalhe({ titulo: card.label, tipoValor: card.type, rows: [], loading: true, mensagem: '' });
    try {
      const response = await axios.get('/relatorios/home/painel-financeiro/detalhes', {
        params: { de: selectedRange.de, ate: selectedRange.ate, agrupamento: grouping, metric: card.metric },
        headers: { 'Cache-Control': 'no-store' },
      });
      setDetalhe({ ...(response?.data || {}), loading: false, mensagem: '' });
    } catch (_) {
      setDetalhe((current) => current ? { ...current, loading: false, mensagem: 'Não foi possível carregar os clientes deste indicador.' } : null);
    }
  };

  const formatDetailValue = (value, type) => {
    if (type === 'count') return Number(value || 0).toLocaleString('pt-BR');
    if (type === 'percent') return `${Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
    return FORMATTER_BRL.format(Number(value) || 0);
  };

  const primaryCards = [
    { metric: 'previsto', label: 'Previsto para receber', value: indicators.previsto, type: 'currency' },
    { metric: 'recebido', label: 'Recebido no período', value: indicators.recebido, type: 'currency' },
    { metric: 'pendente', label: 'Pendente', value: indicators.pendente, type: 'currency' },
  ];
  const secondaryCards = [
    { metric: 'capitalRecebido', label: 'Capital recebido', value: indicators.capitalRecebido, type: 'currency' },
    { metric: 'jurosRecebidos', label: 'Juros recebidos', value: indicators.jurosRecebidos, type: 'currency' },
    { metric: null, label: 'Juros adicionais recebidos', value: indicators.jurosAdicionaisRecebidos, type: 'currency' },
    { metric: 'quantidadePagamentos', label: 'Pagamentos registrados', value: indicators.quantidadePagamentos, type: 'count' },
    { metric: 'quantidadeParcelasPendentes', label: 'Parcelas pendentes', value: indicators.quantidadeParcelasPendentes, type: 'count' },
    { metric: 'novosClientes', label: 'Novos clientes', value: indicators.novosClientes ?? 0, type: 'count' },
    { metric: 'novosEmprestimos', label: 'Novos empréstimos', value: indicators.novosEmprestimos, type: 'count' },
    { metric: 'valorEmprestado', label: 'Valor emprestado', value: indicators.valorEmprestado, type: 'currency' },
  ];

  return (
    <section className="financial-report" aria-labelledby="financial-report-title">
      <div className="financial-report__topline">
        <div>
          <p className="financial-report__kicker">Painel principal</p>
          <h1 id="financial-report-title">Relatório financeiro</h1>
          <p className="financial-report__period">{formatDate(selectedRange.de)} a {formatDate(selectedRange.ate)}</p>
        </div>
        <span className="financial-report__icon" aria-hidden="true"><AppIcon name="fluxo_caixa" /></span>
      </div>

      <div className="financial-report__filters" aria-label="Selecionar período">
        {[
          ['dia', 'Hoje'], ['semana', 'Semana'], ['mes', 'Mês'], ['ano', 'Ano'], ['personalizado', 'Personalizado'],
        ].map(([value, label]) => (
          <button key={value} type="button" className={mode === value ? 'is-active' : ''} onClick={() => setMode(value)}>{label}</button>
        ))}
      </div>

      {mode === 'personalizado' ? (
        <div className="financial-report__custom">
          <label>Início<input type="date" value={customRange.de} onChange={(event) => setCustomRange((range) => ({ ...range, de: event.target.value }))} /></label>
          <label>Fim<input type="date" value={customRange.ate} onChange={(event) => setCustomRange((range) => ({ ...range, ate: event.target.value }))} /></label>
          <button type="button" onClick={applyCustom}>Aplicar</button>
        </div>
      ) : null}

      {error ? (
        <div className="financial-report__error" role="alert">
          <span>{error}</span><button type="button" onClick={() => setRequestKey((current) => current + 1)}>Tentar novamente</button>
        </div>
      ) : null}

      <div className={`financial-report__body${loading ? ' is-loading' : ''}`} aria-busy={loading}>
        <div className="financial-report__primary-grid">
          {primaryCards.map((card) => <button type="button" key={card.label} className="financial-report__primary-card" onClick={() => openDetalhe(card)}><span>{card.label}</span><strong>{loading ? '—' : FORMATTER_BRL.format(Number(card.value) || 0)}</strong></button>)}
          <button type="button" className="financial-report__primary-card financial-report__primary-card--coverage" onClick={() => openDetalhe({ metric: 'cobertura', label: 'Cobertura do previsto', value: indicators.percentual, type: 'percent' })}><span>Cobertura do previsto</span><strong>{loading ? '—' : `${Number(indicators.percentual || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}</strong></button>
        </div>

        {!loading && !error && !hasMovement ? <p className="financial-report__empty">Sem movimentação financeira neste período.</p> : null}

        <div className="financial-report__content-grid">
          <div className="financial-report__secondary-grid">
            {secondaryCards.map((card) => <button type="button" key={card.label} className="financial-report__secondary-card" onClick={() => openDetalhe(card)}><span>{card.label}</span><strong>{card.value == null ? 'Indisponível' : card.type === 'count' ? Number(card.value || 0).toLocaleString('pt-BR') : FORMATTER_BRL.format(Number(card.value) || 0)}</strong></button>)}
          </div>
          {!singleDay ? (
            <figure className="financial-report__chart">
              <figcaption>Previsto × recebido</figcaption>
              <div className="financial-report__legend"><span><i className="is-planned" />Previsto</span><span><i className="is-received" />Recebido</span></div>
              <div className="financial-report__bars">
                {(data?.serie || []).map((item) => <div className="financial-report__bar-group" key={item.chave} title={`${formatDate(item.chave)} — Previsto: ${FORMATTER_BRL.format(item.previsto)}; Recebido: ${FORMATTER_BRL.format(item.recebido)}`}><div className="financial-report__bar is-planned" style={{ height: `${Math.max(2, (Number(item.previsto || 0) / chartMax) * 100)}%` }} /><div className="financial-report__bar is-received" style={{ height: `${Math.max(2, (Number(item.recebido || 0) / chartMax) * 100)}%` }} /><small>{chartLabel(item.chave, grouping)}</small></div>)}
              </div>
            </figure>
          ) : null}
        </div>
      </div>
      {detalhe ? (
        <div className="financial-report__details-backdrop" role="presentation" onMouseDown={() => setDetalhe(null)}>
          <section className="financial-report__details" role="dialog" aria-modal="true" aria-label={detalhe.titulo} onMouseDown={(event) => event.stopPropagation()}>
            <div className="financial-report__details-header"><h2>{detalhe.titulo}</h2><button type="button" onClick={() => setDetalhe(null)} aria-label="Fechar">×</button></div>
            {detalhe.loading ? <p>Carregando clientes…</p> : detalhe.mensagem ? <p>{detalhe.mensagem}</p> : detalhe.rows?.length ? <div className="financial-report__details-table"><div className="financial-report__details-row is-heading"><span>ID</span><span>Cliente</span><span>Valor</span></div>{detalhe.rows.map((row, index) => <div className="financial-report__details-row" key={`${row.id ?? 'sem-id'}-${row.nome}-${index}`}><span>{row.id ?? '—'}</span><span>{row.nome}</span><strong>{formatDetailValue(row.valor, detalhe.tipoValor)}</strong></div>)}</div> : <p>Nenhum cliente compõe este indicador no período.</p>}
          </section>
        </div>
      ) : null}
    </section>
  );
}
