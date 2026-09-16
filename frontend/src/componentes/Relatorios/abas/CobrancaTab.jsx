import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { buildCobrancaQueryParams, getCobranca } from '../services/relatoriosApi';
import ClienteIdentity from '../../common/ClienteIdentity.jsx';
import useClientesCatalogo from '../../common/useClientesCatalogo.js';

function hojeLocalISO() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function formatarDataCurta(value) {
  if (!isIsoDate(value)) return '-';
  const [y, m, d] = String(value).split('-');
  return `${d}/${m}/${y}`;
}

function formatarMoeda(value) {
  const n = Number(value || 0);
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function parseApiError(err, fallback) {
  return (
    err?.response?.data?.error ||
    err?.response?.data?.erro ||
    err?.message ||
    fallback ||
    'Erro inesperado.'
  );
}

function abrirPaginaImpressao(filters) {
  const params = buildCobrancaQueryParams(filters, { includePagination: false });
  const qs = new URLSearchParams(params).toString();
  const baseHref = window.location.href.split('#')[0];
  const hashPath = `#/relatorios/cobranca/print${qs ? `?${qs}` : ''}`;
  const popup = window.open(`${baseHref}${hashPath}`, '_blank', 'noopener,noreferrer');
  if (!popup) {
    window.location.hash = `/relatorios/cobranca/print${qs ? `?${qs}` : ''}`;
  }
}

const cardStyle = {
  border: '1px solid var(--border-soft)',
  borderRadius: 12,
  background: 'var(--bg-card)',
  padding: 12,
};

export default function CobrancaTab() {
  const { resolverCliente } = useClientesCatalogo();
  const hoje = useMemo(() => hojeLocalISO(), []);

  const [de, setDe] = useState(hoje);
  const [ate, setAte] = useState(hoje);
  const [status, setStatus] = useState('todos');
  const [clienteNome, setClienteNome] = useState('');
  const [clienteId, setClienteId] = useState('');
  const [incluirPagas, setIncluirPagas] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');
  const [resultado, setResultado] = useState({
    itens: [],
    total: 0,
    totalPages: 1,
    page: 1,
    pageSize: 50,
    de: hoje,
    ate: hoje,
  });

  const carregar = useCallback(
    async (next = {}) => {
      const deParam = String(next.de ?? de).trim();
      const ateParam = String(next.ate ?? ate).trim();
      const statusParam = String(next.status ?? status).trim();
      const clienteNomeParam = String(next.cliente_nome ?? clienteNome).trim();
      const clienteIdParam = String(next.cliente_id ?? clienteId).replace(/\D/g, '');
      const incluirPagasParam =
        typeof next.incluirPagas === 'boolean' ? next.incluirPagas : incluirPagas;
      const pageParam = Number(next.page || page);
      const pageSizeParam = Number(next.pageSize || pageSize);

      if (!isIsoDate(deParam) || !isIsoDate(ateParam)) {
        setErro('Informe um periodo valido no formato YYYY-MM-DD.');
        return;
      }
      if (deParam > ateParam) {
        setErro('Periodo invalido: "de" nao pode ser maior que "ate".');
        return;
      }

      setLoading(true);
      setErro('');
      try {
        const payload = await getCobranca({
          de: deParam,
          ate: ateParam,
          status: statusParam,
          cliente_nome: clienteNomeParam,
          cliente_id: clienteIdParam,
          incluirPagas: incluirPagasParam,
          page: pageParam,
          pageSize: pageSizeParam,
        });
        setResultado({
          itens: Array.isArray(payload?.itens) ? payload.itens : [],
          total: Number(payload?.total || 0),
          totalPages: Math.max(1, Number(payload?.totalPages || 1)),
          page: Number(payload?.page || pageParam),
          pageSize: Number(payload?.pageSize || pageSizeParam),
          de: payload?.de || deParam,
          ate: payload?.ate || ateParam,
        });
      } catch (err) {
        setErro(parseApiError(err, 'Erro ao carregar cobranca.'));
      } finally {
        setLoading(false);
      }
    },
    [ate, clienteId, clienteNome, de, incluirPagas, page, pageSize, status]
  );

  useEffect(() => {
    carregar({ page: 1, pageSize });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalItens = Number(resultado.total || 0);
  const totalPages = Math.max(1, Number(resultado.totalPages || 1));
  const currentPage = Math.min(Math.max(1, Number(resultado.page || page)), totalPages);
  const itens = Array.isArray(resultado.itens) ? resultado.itens : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={cardStyle}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            carregar({ page: 1, pageSize });
          }}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: 10,
            alignItems: 'end',
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>De</span>
            <input
              type="date"
              value={de}
              onChange={(event) => setDe(event.target.value)}
              style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-soft)' }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Ate</span>
            <input
              type="date"
              value={ate}
              onChange={(event) => setAte(event.target.value)}
              style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-soft)' }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Status</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-soft)' }}
            >
              <option value="vencidas">Vencidas</option>
              <option value="vencendo">Vencendo</option>
              <option value="todos">Todos</option>
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Cliente (nome)</span>
            <input
              type="text"
              value={clienteNome}
              onChange={(event) => setClienteNome(event.target.value)}
              placeholder="Digite o início do nome"
              style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-soft)' }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>ID do cliente</span>
            <input
              type="text"
              inputMode="numeric"
              value={clienteId}
              onChange={(event) => setClienteId(event.target.value.replace(/\D/g, ''))}
              placeholder="ID"
              style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-soft)' }}
            />
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minHeight: 38,
              whiteSpace: 'nowrap',
            }}
          >
            <input
              type="checkbox"
              checked={incluirPagas}
              onChange={(event) => setIncluirPagas(event.target.checked)}
            />
            <span>Incluir pagas</span>
          </label>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => {
                setDe(hoje);
                setAte(hoje);
                setStatus('todos');
                setClienteNome('');
                setClienteId('');
                setIncluirPagas(false);
                setPage(1);
                setPageSize(50);
                carregar({
                  de: hoje,
                  ate: hoje,
                  status: 'todos',
                  cliente_nome: '',
                  cliente_id: '',
                  incluirPagas: false,
                  page: 1,
                  pageSize: 50,
                });
              }}
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid var(--border-soft)',
                background: 'var(--bg-card)',
                color: 'var(--text-main)',
                cursor: loading ? 'default' : 'pointer',
              }}
              disabled={loading}
            >
              Limpar
            </button>
            <button
              type="submit"
              disabled={loading}
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid #2563eb',
                background: '#2563eb',
                color: '#fff',
                cursor: loading ? 'default' : 'pointer',
                fontWeight: 700,
              }}
            >
              {loading ? 'Carregando...' : 'Aplicar filtros'}
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() =>
                abrirPaginaImpressao({
                  de,
                  ate,
                  status,
                  cliente_nome: clienteNome,
                  cliente_id: clienteId,
                  incluirPagas,
                })
              }
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid #0f766e',
                background: '#0f766e',
                color: '#fff',
                cursor: loading ? 'default' : 'pointer',
                fontWeight: 700,
              }}
            >
              Imprimir
            </button>
          </div>
        </form>

        <div
          style={{
            marginTop: 10,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            alignItems: 'center',
            justifyContent: 'space-between',
            color: 'var(--text-muted)',
            fontSize: '0.92em',
          }}
        >
          <span>
            Periodo aplicado: {formatarDataCurta(resultado.de)} ate {formatarDataCurta(resultado.ate)}
          </span>
          <span>Total de registros: {totalItens}</span>
        </div>
      </div>

      <div style={cardStyle}>
        {erro ? (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid #fecaca',
              background: '#fee2e2',
              color: '#991b1b',
              marginBottom: 10,
            }}
          >
            {erro}
          </div>
        ) : null}

        {loading ? <div style={{ color: 'var(--text-muted)' }}>Carregando cobranca...</div> : null}

        {!loading && !erro && itens.length === 0 ? (
          <div style={{ color: 'var(--text-muted)' }}>
            Nenhuma parcela encontrada para os filtros selecionados.
          </div>
        ) : null}

        {!erro && itens.length > 0 ? (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  minWidth: 980,
                  borderCollapse: 'collapse',
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-card)',
                }}
              >
                <thead>
                  <tr style={{ background: 'rgba(15,118,110,0.12)' }}>
                    {[
                      'Cliente',
                      'Telefone',
                      'Emprestimo',
                      'Parcela',
                      'Vencimento',
                      'Valor',
                      'Dias em atraso',
                      'Observacao',
                    ].map((header) => (
                      <th
                        key={header}
                        style={{
                          textAlign: 'left',
                          padding: '10px 8px',
                          borderBottom: '1px solid var(--border-soft)',
                          fontSize: '0.88em',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {itens.map((item) => (
                    <tr key={`${item.parcela_id || 'p'}-${item.emprestimo_id || 'e'}-${item.parcela_numero || 'n'}`}>
                      <td style={{ padding: '12px 8px', borderBottom: '1px solid var(--border-soft)' }}>
                        <ClienteIdentity
                          cliente={resolverCliente(item.cliente_id, item.cliente_nome)}
                          avatarSize={30}
                          className="cliente-identity--table"
                        />
                      </td>
                      <td
                        style={{
                          padding: '12px 8px',
                          borderBottom: '1px solid var(--border-soft)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.telefone || '-'}
                      </td>
                      <td style={{ padding: '12px 8px', borderBottom: '1px solid var(--border-soft)' }}>
                        {item.emprestimo_id || '-'}
                      </td>
                      <td style={{ padding: '12px 8px', borderBottom: '1px solid var(--border-soft)' }}>
                        {item.parcela_numero || '-'}
                      </td>
                      <td style={{ padding: '12px 8px', borderBottom: '1px solid var(--border-soft)' }}>
                        {formatarDataCurta(item.vencimento)}
                      </td>
                      <td style={{ padding: '12px 8px', borderBottom: '1px solid var(--border-soft)' }}>
                        {formatarMoeda(item.valor_total)}
                      </td>
                      <td style={{ padding: '12px 8px', borderBottom: '1px solid var(--border-soft)' }}>
                        {Number(item.dias_em_atraso || 0)}
                      </td>
                      <td
                        style={{
                          padding: '12px 8px',
                          borderBottom: '1px solid var(--border-soft)',
                          minWidth: 180,
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {item.observacao || ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div
              style={{
                marginTop: 10,
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() => {
                    const prev = Math.max(1, currentPage - 1);
                    setPage(prev);
                    carregar({ page: prev, pageSize });
                  }}
                  disabled={loading || currentPage <= 1}
                  style={{
                    padding: '7px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--border-soft)',
                    background: 'var(--bg-card)',
                    color: 'var(--text-main)',
                    cursor: loading || currentPage <= 1 ? 'default' : 'pointer',
                  }}
                >
                  Anterior
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = Math.min(totalPages, currentPage + 1);
                    setPage(next);
                    carregar({ page: next, pageSize });
                  }}
                  disabled={loading || currentPage >= totalPages}
                  style={{
                    padding: '7px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--border-soft)',
                    background: 'var(--bg-card)',
                    color: 'var(--text-main)',
                    cursor: loading || currentPage >= totalPages ? 'default' : 'pointer',
                  }}
                >
                  Proxima
                </button>
                <span style={{ color: 'var(--text-muted)' }}>
                  Pagina {currentPage} de {totalPages}
                </span>
              </div>

              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ color: 'var(--text-muted)' }}>Itens por pagina</span>
                <select
                  value={pageSize}
                  onChange={(event) => {
                    const nextPageSize = Number(event.target.value || 50);
                    setPageSize(nextPageSize);
                    setPage(1);
                    carregar({ page: 1, pageSize: nextPageSize });
                  }}
                  style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-soft)' }}
                >
                  {[20, 50, 100, 200].map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
