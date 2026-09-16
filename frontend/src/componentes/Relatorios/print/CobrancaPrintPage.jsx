import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getCobrancaPrint } from '../services/relatoriosApi';
import ClienteIdentity from '../../common/ClienteIdentity.jsx';
import useClientesCatalogo from '../../common/useClientesCatalogo.js';

const PRINT_STYLES = `
  :root { color-scheme: light; }
  body {
    margin: 0;
    background: #e4e4e7;
    color: #111827;
    font-family: Arial, Helvetica, sans-serif;
  }
  .cobranca-print-page {
    padding: 14px;
  }
  .cobranca-print-sheet {
    width: min(100%, 210mm);
    margin: 0 auto;
    padding: 8mm 7mm;
    background: #ffffff;
    box-shadow: 0 2px 14px rgba(2, 6, 23, 0.2);
  }
  .cobranca-print-note {
    margin: 0 0 10px 0;
    font-size: 12px;
    color: #334155;
  }
  .cobranca-print-error {
    border: 1px solid #fca5a5;
    background: #fee2e2;
    color: #7f1d1d;
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 12px;
  }
  .cobranca-print-loading {
    color: #475569;
    margin-bottom: 12px;
  }
  .cobranca-print-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  .cobranca-print-table thead {
    display: table-header-group;
  }
  .cobranca-print-table tfoot {
    display: table-row-group;
  }
  .cobranca-print-table tr {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .cobranca-print-table th,
  .cobranca-print-table td {
    border: 1px solid #334155;
    padding: 8px 6px;
    font-size: 11px;
    vertical-align: top;
    word-break: break-word;
  }
  .cobranca-print-table th {
    background: #f1f5f9;
    font-weight: 700;
    text-align: left;
  }
  .cobranca-print-meta-head {
    background: #ffffff !important;
    padding: 10px 8px !important;
  }
  .cobranca-print-title {
    font-size: 18px;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .cobranca-print-meta {
    font-size: 11px;
    color: #334155;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .cobranca-print-col-nowrap {
    white-space: nowrap;
  }
  .cobranca-print-col-obs {
    width: 26%;
  }
  .cobranca-print-obs-space {
    min-height: 28px;
    display: block;
  }
  .cobranca-print-empty {
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 12px;
    color: #475569;
    font-size: 12px;
  }

  @page {
    size: A4 portrait;
    margin: 10mm 8mm;
  }

  @media print {
    body {
      background: #ffffff;
    }
    .cobranca-print-page {
      padding: 0;
    }
    .cobranca-print-sheet {
      width: auto;
      margin: 0;
      padding: 0;
      box-shadow: none;
    }
    .screen-only {
      display: none !important;
    }
  }
`;

function formatarDataCurta(value) {
  const raw = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '-';
  const [y, m, d] = raw.split('-');
  return `${d}/${m}/${y}`;
}

function formatarDataHora(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yy} ${hh}:${mi}`;
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

function parseSearchFilters(search) {
  const query = new URLSearchParams(search || '');
  return {
    de: query.get('de') || '',
    ate: query.get('ate') || '',
    status: query.get('status') || 'todos',
    cliente_nome: query.get('cliente_nome') || '',
    cliente_id: query.get('cliente_id') || '',
    incluirPagas: query.get('incluirPagas') === '1',
  };
}

export default function CobrancaPrintPage() {
  const location = useLocation();
  const { resolverCliente } = useClientesCatalogo();
  const generatedAt = useMemo(() => new Date(), []);
  const hasPrintedRef = useRef(false);

  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');
  const [payload, setPayload] = useState({
    de: '',
    ate: '',
    total: 0,
    itens: [],
  });

  const filtrosBusca = useMemo(() => parseSearchFilters(location.search), [location.search]);

  useEffect(() => {
    hasPrintedRef.current = false;
    let cancelled = false;

    async function carregar() {
      setLoading(true);
      setErro('');
      try {
        const data = await getCobrancaPrint(filtrosBusca);
        if (cancelled) return;
        setPayload({
          de: data?.de || filtrosBusca.de || '',
          ate: data?.ate || filtrosBusca.ate || '',
          total: Number(data?.total || 0),
          itens: Array.isArray(data?.itens) ? data.itens : [],
        });
      } catch (err) {
        if (cancelled) return;
        setErro(parseApiError(err, 'Erro ao carregar dados de impressao da cobranca.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    carregar();
    return () => {
      cancelled = true;
    };
  }, [filtrosBusca]);

  useEffect(() => {
    if (loading || erro || hasPrintedRef.current) return;
    hasPrintedRef.current = true;
    const id = window.setTimeout(() => {
      window.print();
    }, 220);
    return () => window.clearTimeout(id);
  }, [loading, erro, payload.total]);

  const itens = Array.isArray(payload.itens) ? payload.itens : [];
  const periodoTexto = `${formatarDataCurta(payload.de)} ate ${formatarDataCurta(payload.ate)}`;
  const clienteFiltro = String(filtrosBusca.cliente_nome || '').trim();
  const statusTexto = String(filtrosBusca.status || 'todos');
  const incluirPagasTexto = filtrosBusca.incluirPagas ? 'sim' : 'nao';

  return (
    <div className="cobranca-print-page">
      <style>{PRINT_STYLES}</style>
      <div className="cobranca-print-sheet">
        <p className="cobranca-print-note screen-only">
          Versao de impressao carregada. Se a janela de impressao nao abrir automaticamente, use
          Ctrl+P.
        </p>

        {erro ? <div className="cobranca-print-error">{erro}</div> : null}
        {loading ? <div className="cobranca-print-loading">Carregando relatorio...</div> : null}

        {!loading && !erro && itens.length === 0 ? (
          <div className="cobranca-print-empty">
            Nenhuma parcela encontrada para os filtros informados.
          </div>
        ) : null}

        {!erro && itens.length > 0 ? (
          <table className="cobranca-print-table">
            <thead>
              <tr>
                <th colSpan={8} className="cobranca-print-meta-head">
                  <div className="cobranca-print-title">Relatorio de Cobranca</div>
                  <div className="cobranca-print-meta">
                    <span>Periodo: {periodoTexto}</span>
                    <span>Gerado em: {formatarDataHora(generatedAt)}</span>
                    <span>Status: {statusTexto}</span>
                    <span>Incluir pagas: {incluirPagasTexto}</span>
                    {clienteFiltro ? <span>Cliente: {clienteFiltro}</span> : null}
                  </div>
                </th>
              </tr>
              <tr>
                <th style={{ width: '18%' }}>Cliente</th>
                <th className="cobranca-print-col-nowrap" style={{ width: '12%' }}>
                  Telefone
                </th>
                <th className="cobranca-print-col-nowrap" style={{ width: '9%' }}>
                  Emprestimo
                </th>
                <th className="cobranca-print-col-nowrap" style={{ width: '8%' }}>
                  Parcela
                </th>
                <th className="cobranca-print-col-nowrap" style={{ width: '10%' }}>
                  Vencimento
                </th>
                <th className="cobranca-print-col-nowrap" style={{ width: '11%' }}>
                  Valor
                </th>
                <th className="cobranca-print-col-nowrap" style={{ width: '10%' }}>
                  Dias atraso
                </th>
                <th className="cobranca-print-col-obs">Observacao</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((item) => (
                <tr key={`${item.parcela_id || 'p'}-${item.emprestimo_id || 'e'}-${item.parcela_numero || 'n'}`}>
                  <td>
                    <ClienteIdentity
                      cliente={resolverCliente(item.cliente_id, item.cliente_nome)}
                      avatarSize={26}
                      className="cliente-identity--table"
                    />
                  </td>
                  <td className="cobranca-print-col-nowrap">{item.telefone || '-'}</td>
                  <td className="cobranca-print-col-nowrap">{item.emprestimo_id || '-'}</td>
                  <td className="cobranca-print-col-nowrap">{item.parcela_numero || '-'}</td>
                  <td className="cobranca-print-col-nowrap">{formatarDataCurta(item.vencimento)}</td>
                  <td className="cobranca-print-col-nowrap">{formatarMoeda(item.valor_total)}</td>
                  <td className="cobranca-print-col-nowrap">{Number(item.dias_em_atraso || 0)}</td>
                  <td>
                    <div>{item.observacao || ''}</div>
                    <span className="cobranca-print-obs-space" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  );
}
