import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { AppIcon } from './menu';
import {
  actionTimeLabel,
  buildSnapshotComparison,
  formatCurrency,
  formatDetailValue,
  groupActionsByDay,
  metadataEntries,
  parseActionDate,
} from './acoesPresentation.js';
import './acoes.css';

const FILTERS = [
  ['todas', 'Todas'],
  ['clientes', 'Clientes'],
  ['emprestimos', 'Empréstimos'],
  ['pagamentos', 'Pagamentos'],
  ['financeiro', 'Financeiro'],
];

function readableError(error, fallback) {
  return error?.response?.data?.error || error?.message || fallback;
}

function ActionCard({ action, onDetails }) {
  const amount = formatCurrency(action.valor);
  return (
    <article className={`acoes-card${action.secundaria ? ' is-secondary' : ''}`}>
      <div className="acoes-card__timeline" aria-hidden="true">
        <span className="acoes-card__dot" />
      </div>
      <div className="acoes-card__body">
        <div className="acoes-card__topline">
          <div>
            <div className="acoes-card__eyebrow">
              <time dateTime={action.created_at}>{actionTimeLabel(action.created_at)}</time>
              <span aria-hidden="true">•</span>
              <span>{action.categoria === 'secundarias' ? 'Atividade do sistema' : action.nome}</span>
            </div>
            <h3>{action.nome}</h3>
          </div>
          <span className={`acoes-status is-${action.status}`}>{action.status_nome}</span>
        </div>

        <p className="acoes-card__summary">{action.resumo}</p>

        <div className="acoes-card__facts">
          {action.cliente?.nome ? (
            <span><strong>Cliente</strong>{action.cliente.nome}</span>
          ) : null}
          {action.emprestimo ? (
            <span><strong>Contrato</strong>{action.emprestimo.referencia}</span>
          ) : null}
          {amount ? (
            <span className="acoes-card__amount"><strong>Valor</strong>{amount}</span>
          ) : null}
        </div>

        <div className="acoes-card__actions">
          <button type="button" className="acoes-button is-primary" onClick={() => onDetails(action)}>
            Ver detalhes
          </button>
          <button
            type="button"
            className="acoes-button is-undo"
            disabled
            title="Reversão ainda não disponível"
          >
            Desfazer
          </button>
        </div>
      </div>
    </article>
  );
}

function DetailValue({ item, side }) {
  const value = side === 'before' ? item.before : item.after;
  return (
    <div className={`acoes-detail-value${item.changed ? ' is-changed' : ''}`}>
      <span>{item.label}</span>
      <strong>{formatDetailValue(item.key, value)}</strong>
    </div>
  );
}

function ActionDetails({ action, loading, error, onClose }) {
  const comparison = useMemo(
    () => buildSnapshotComparison(action?.snapshots || []),
    [action]
  );
  const operation = useMemo(() => metadataEntries(action?.metadata), [action]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="acoes-drawer-backdrop" data-dialog-overlay="true" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside className="acoes-drawer" role="dialog" aria-modal="true" aria-labelledby="acao-detail-title">
        <header className="acoes-drawer__header">
          <div>
            <span className="acoes-drawer__kicker">Detalhes da ação</span>
            <h2 id="acao-detail-title">{action?.nome || 'Carregando…'}</h2>
          </div>
          <button type="button" className="acoes-drawer__close" onClick={onClose} aria-label="Fechar detalhes">×</button>
        </header>

        {loading ? <div className="acoes-drawer__feedback">Carregando os detalhes…</div> : null}
        {error ? <div className="acoes-alert is-error">{error}</div> : null}
        {!loading && !error && action ? (
          <div className="acoes-drawer__content">
            <section className="acoes-detail-hero">
              <div>
                <span>Quando</span>
                <strong>{(() => {
                  const date = parseActionDate(action.created_at);
                  return date
                    ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short' }).format(date)
                    : 'Data não informada';
                })()}</strong>
              </div>
              {action.cliente?.nome ? <div><span>Cliente</span><strong>{action.cliente.nome}</strong></div> : null}
              {action.emprestimo ? <div><span>Contrato</span><strong>{action.emprestimo.referencia}</strong></div> : null}
              <div><span>Status</span><strong>{action.status_nome}</strong></div>
            </section>

            <section className="acoes-detail-section">
              <div className="acoes-detail-section__heading">
                <span className="acoes-step is-operation">2</span>
                <div><span>O que foi feito</span><h3>{action.resumo}</h3></div>
              </div>
              {operation.length ? (
                <div className="acoes-operation-grid">
                  {operation.map((item) => (
                    <div key={item.key}><span>{item.label}</span><strong>{formatDetailValue(item.key, item.value)}</strong></div>
                  ))}
                </div>
              ) : <p className="acoes-muted">Não há parâmetros adicionais registrados para esta ação.</p>}
            </section>

            {comparison.items.length ? (
              <section className="acoes-comparison" aria-label="Comparação antes e depois">
                <div className="acoes-comparison__column is-before">
                  <div className="acoes-comparison__title"><span className="acoes-step">1</span><h3>Antes</h3></div>
                  {comparison.items.map((item) => <DetailValue key={`before-${item.key}`} item={item} side="before" />)}
                </div>
                <div className="acoes-comparison__column is-after">
                  <div className="acoes-comparison__title"><span className="acoes-step is-after">3</span><h3>Depois</h3></div>
                  {comparison.items.map((item) => <DetailValue key={`after-${item.key}`} item={item} side="after" />)}
                </div>
              </section>
            ) : (
              <section className="acoes-empty-detail">
                <h3>Antes e depois</h3>
                <p>Esta ação não possui snapshots com campos apresentáveis.</p>
              </section>
            )}
            {comparison.truncated ? <p className="acoes-muted">A comparação prioriza os primeiros campos alterados deste registro.</p> : null}

            <footer className="acoes-drawer__footer">
              <button type="button" className="acoes-button is-undo" disabled title="Reversão ainda não disponível">
                Desfazer
              </button>
              <span>Reversão ainda não disponível</span>
            </footer>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

export default function Acoes() {
  const [category, setCategory] = useState('todas');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, has_more: false });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const requestId = useRef(0);

  const load = async ({ page = 1, append = false, nextCategory = category, nextSearch = search } = {}) => {
    const currentRequest = ++requestId.current;
    append ? setLoadingMore(true) : setLoading(true);
    setError('');
    try {
      const response = await axios.get('/acoes', {
        params: { page, limit: 20, category: nextCategory, search: nextSearch || undefined },
        headers: { 'Cache-Control': 'no-store' },
      });
      if (currentRequest !== requestId.current) return;
      const nextItems = Array.isArray(response.data?.items) ? response.data.items : [];
      setItems((previous) => append ? [...previous, ...nextItems] : nextItems);
      setPagination(response.data?.pagination || { page, total: nextItems.length, has_more: false });
    } catch (loadError) {
      if (currentRequest === requestId.current) {
        setError(readableError(loadError, 'Não foi possível carregar o histórico de ações.'));
      }
    } finally {
      if (currentRequest === requestId.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  useEffect(() => { load({ page: 1 }); }, [category, search]);

  const openDetails = async (summary) => {
    setSelected(summary);
    setDetailLoading(true);
    setDetailError('');
    try {
      const response = await axios.get(`/acoes/${encodeURIComponent(summary.acao_uid)}`, {
        headers: { 'Cache-Control': 'no-store' },
      });
      setSelected(response.data);
    } catch (detailRequestError) {
      setDetailError(readableError(detailRequestError, 'Não foi possível carregar os detalhes.'));
    } finally {
      setDetailLoading(false);
    }
  };

  const groups = useMemo(() => groupActionsByDay(items), [items]);

  return (
    <div className="acoes-page">
      <header className="acoes-header">
        <div className="acoes-header__icon"><AppIcon name="acoes" /></div>
        <div>
          <span className="acoes-header__kicker">Histórico do sistema</span>
          <h1>Ações</h1>
          <p>Veja o que mudou, quando aconteceu e quais registros foram afetados.</p>
        </div>
        <div className="acoes-header__summary">
          <strong>{pagination.total ?? 0}</strong>
          <span>{Number(pagination.total) === 1 ? 'ação encontrada' : 'ações encontradas'}</span>
        </div>
      </header>

      <section className="acoes-toolbar" aria-label="Filtros do histórico">
        <div className="acoes-filters" role="group" aria-label="Filtrar por categoria">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={category === value ? 'is-active' : ''}
              onClick={() => setCategory(value)}
              aria-pressed={category === value}
            >
              {label}
            </button>
          ))}
        </div>
        <form className="acoes-search" onSubmit={(event) => {
          event.preventDefault();
          setSearch(searchDraft.trim());
        }}>
          <label htmlFor="acoes-search">Pesquisar no histórico</label>
          <div>
            <input
              id="acoes-search"
              type="search"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              maxLength={120}
              placeholder="Cliente, ação ou descrição"
            />
            <button type="submit">Pesquisar</button>
          </div>
        </form>
      </section>

      {error ? <div className="acoes-alert is-error">{error}<button type="button" onClick={() => load({ page: 1 })}>Tentar novamente</button></div> : null}
      {loading ? <div className="acoes-feedback">Carregando ações…</div> : null}
      {!loading && !error && groups.length === 0 ? (
        <div className="acoes-empty"><AppIcon name="acoes" /><h2>Nenhuma ação encontrada</h2><p>Ajuste os filtros ou a pesquisa para consultar outro período do histórico.</p></div>
      ) : null}

      {!loading && groups.map((group) => (
        <section className="acoes-day" key={group.label}>
          <div className="acoes-day__heading"><h2>{group.label}</h2><span>{group.items.length}</span></div>
          <div className="acoes-day__list">
            {group.items.map((action) => <ActionCard key={action.acao_uid} action={action} onDetails={openDetails} />)}
          </div>
        </section>
      ))}

      {pagination.has_more ? (
        <div className="acoes-load-more">
          <button type="button" onClick={() => load({ page: Number(pagination.page) + 1, append: true })} disabled={loadingMore}>
            {loadingMore ? 'Carregando…' : 'Carregar mais ações'}
          </button>
        </div>
      ) : null}

      {selected ? (
        <ActionDetails
          action={selected}
          loading={detailLoading}
          error={detailError}
          onClose={() => { setSelected(null); setDetailError(''); }}
        />
      ) : null}
    </div>
  );
}
