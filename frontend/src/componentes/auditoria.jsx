// frontend/src/componentes/auditoria.jsx
import React, { useMemo, useState } from 'react';
import axios from 'axios';
import notify from '../ui/notify';
import ParcelaList from './Emprestimos/ParcelaList.jsx';
import ClienteIdentity from './common/ClienteIdentity.jsx';
import useClientesCatalogo from './common/useClientesCatalogo.js';

const parseError = (err, fallback) =>
  err?.response?.data?.error ||
  err?.response?.data?.erro ||
  err?.message ||
  fallback ||
  'Erro inesperado.';

function normalizarParcelaAuditoria(p) {
  const parcelaId = p?.parcela_id ?? p?.id ?? null;

  return {
    id: parcelaId,
    parcela_id: parcelaId,

    emprestimo_id: p?.emprestimo_id ?? null,

    numero: p?.parcela_numero ?? p?.numero ?? null,
    vencimento: p?.parcela_vencimento ?? p?.vencimento ?? null,

    valor_total: Number(p?.parcela_valor_total ?? p?.valor_total ?? 0),
    valor_pago: Number(p?.parcela_valor_pago ?? p?.valor_pago ?? 0),
    valor_capital: Number(p?.parcela_valor_capital ?? p?.valor_capital ?? 0),
    valor_juros: Number(p?.parcela_valor_juros ?? p?.valor_juros ?? 0),
    juros_pendentes: Number(p?.parcela_juros_pendentes ?? p?.juros_pendentes ?? 0),
    juros_adicionais: Number(p?.parcela_juros_adicionais ?? p?.juros_adicionais ?? 0),

    pago: p?.parcela_pago ?? p?.pago ?? 0,
    data_pagamento: p?.parcela_data_pagamento ?? p?.data_pagamento ?? null,
    explicacao: p?.parcela_explicacao ?? p?.explicacao ?? '',

    observacao: p?.observacao ?? null,
    tipo_pagamento: p?.tipo_pagamento ?? null,
    valor_original: p?.valor_original ?? null,

    renegociada: p?.parcela_renegociada ?? p?.renegociada ?? 0,

    // extras
    cliente_id: p?.cliente_id ?? null,
    cliente_nome: p?.cliente_nome ?? null,
    cliente_telefone: p?.cliente_telefone ?? null,
    cliente_endereco: p?.cliente_endereco ?? null,
  };
}

export default function Auditoria() {
  const { resolverCliente } = useClientesCatalogo();
  const [dataConsulta, setDataConsulta] = useState('');
  const [buscando, setBuscando] = useState(false);

  // aparece só depois que buscar
  const [jaBuscou, setJaBuscou] = useState(false);

  // checkbox só controla o que é exibido
  const [mostrarPagas, setMostrarPagas] = useState(false);

  // cache: pendentes e “todas (incluindo pagas)” para a mesma data
  const [cache, setCache] = useState(() => ({
    data: '',
    pendentes: [],
    todas: null, // null = ainda não buscou com incluirPagas=1
  }));

  const limparAuditoria = () => {
    setDataConsulta('');
    setMostrarPagas(false);
    setJaBuscou(false);
    setCache({ data: '', pendentes: [], todas: null });
  };

  const buscarPendentes = async () => {
    if (!dataConsulta) {
      notify.error('Selecione uma data.');
      return;
    }

    setBuscando(true);
    setJaBuscou(true);
    setMostrarPagas(false);

    try {
      const resp = await axios.get('/notificacoes/parcelas-por-data', {
        params: { data: dataConsulta, incluirPagas: '0' },
      });

      const lista = (resp.data?.parcelas || []).map(normalizarParcelaAuditoria);

      setCache({
        data: dataConsulta,
        pendentes: lista,
        todas: null,
      });

      if (lista.length === 0) {
        notify.info('Nenhuma parcela encontrada para essa data.');
      }
    } catch (err) {
      notify.error(parseError(err, 'Erro ao consultar auditoria.'));
    } finally {
      setBuscando(false);
    }
  };

  const buscarTodasSePreciso = async (dataISO) => {
    // se já tem cache para a mesma data, e “todas” já está carregado, não precisa buscar
    if (cache.data === dataISO && Array.isArray(cache.todas)) return;

    setBuscando(true);
    try {
      const resp = await axios.get('/notificacoes/parcelas-por-data', {
        params: { data: dataISO, incluirPagas: '1' },
      });

      const lista = (resp.data?.parcelas || []).map(normalizarParcelaAuditoria);

      setCache((prev) => ({
        data: dataISO,
        pendentes: prev.data === dataISO ? prev.pendentes : [],
        todas: lista,
      }));
    } catch (err) {
      notify.error(parseError(err, 'Erro ao consultar auditoria.'));
      // se falhar, desmarca para não ficar “travado”
      setMostrarPagas(false);
    } finally {
      setBuscando(false);
    }
  };

  const onToggleMostrarPagas = async (checked) => {
    setMostrarPagas(checked);

    // se marcou, busca “todas” (uma vez) e depois é só alternar visualmente
    if (checked) {
      const dataISO = dataConsulta || cache.data;
      if (!dataISO) return;
      await buscarTodasSePreciso(dataISO);
    }
  };

  // lista exibida conforme checkbox
  const parcelasExibidas = useMemo(() => {
    const base = mostrarPagas
      ? Array.isArray(cache.todas)
        ? cache.todas
        : []
      : cache.pendentes;

    // quando mostrar pagas: pagas primeiro, depois pendentes; e por número
    if (mostrarPagas) {
      return [...base].sort((a, b) => {
        const pa = Number(a?.pago || 0) ? 0 : 1; // pagas primeiro
        const pb = Number(b?.pago || 0) ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return Number(a?.numero || 0) - Number(b?.numero || 0);
      });
    }

    return base;
  }, [mostrarPagas, cache]);

  // agrupa por empréstimo, para mostrar header com cliente e botões
  const gruposPorEmprestimo = useMemo(() => {
    const map = new Map();
    for (const p of parcelasExibidas || []) {
      const empId = p?.emprestimo_id ?? 'sem_emprestimo';
      if (!map.has(empId)) map.set(empId, []);
      map.get(empId).push(p);
    }
    for (const [k, arr] of map.entries()) {
      arr.sort((a, b) => {
        if (mostrarPagas) {
          const pa = Number(a?.pago || 0) ? 0 : 1;
          const pb = Number(b?.pago || 0) ? 0 : 1;
          if (pa !== pb) return pa - pb;
        }
        return Number(a.numero || 0) - Number(b.numero || 0);
      });
      map.set(k, arr);
    }
    return Array.from(map.entries()).sort(([a, listaA], [b, listaB]) => {
      if (mostrarPagas) {
        const aTemPaga = (listaA || []).some((p) => Number(p?.pago || 0));
        const bTemPaga = (listaB || []).some((p) => Number(p?.pago || 0));
        if (aTemPaga !== bTemPaga) return aTemPaga ? -1 : 1;
      }
      const na = a === 'sem_emprestimo' ? Number.MAX_SAFE_INTEGER : Number(a);
      const nb = b === 'sem_emprestimo' ? Number.MAX_SAFE_INTEGER : Number(b);
      return na - nb;
    });
  }, [parcelasExibidas, mostrarPagas]);

  const navegar = (hash) => {
    if (!hash) return;
    window.location.hash = hash;
  };

  const irParaEmprestimos = (emprestimoId, parcelaNumero) => {
    if (!emprestimoId) return;
    const params = new URLSearchParams();
    params.set('emprestimo', emprestimoId);
    if (parcelaNumero != null && parcelaNumero !== '') params.set('parcela', parcelaNumero);
    navegar(`#/emprestimos?${params.toString()}`);
  };

  const irParaPagamento = (emprestimoId, parcelaNumero) => {
    if (!emprestimoId) return;
    const params = new URLSearchParams();
    params.set('emprestimo', emprestimoId);
    if (parcelaNumero != null && parcelaNumero !== '') params.set('parcela', parcelaNumero);
    navegar(`#/pagamento?${params.toString()}`);
  };

  const podeMostrarCheckbox = jaBuscou; // só depois de buscar
  const podeMostrarX = jaBuscou || parcelasExibidas.length > 0;
  const meses = [
    'janeiro',
    'fevereiro',
    'marco',
    'abril',
    'maio',
    'junho',
    'julho',
    'agosto',
    'setembro',
    'outubro',
    'novembro',
    'dezembro',
  ];

  const formatarDataLonga = (iso) => {
    if (!iso || typeof iso !== 'string') return '';
    const [ano, mes, dia] = iso.split('-');
    const mesNome = meses[Number(mes) - 1] || '';
    const diaNum = Number(dia);
    if (!ano || !mesNome || !diaNum) return '';
    return `${diaNum} de ${mesNome} de ${ano}`;
  };

  return (
    <section
      style={{
        marginTop: 30,
        padding: 16,
        borderRadius: 10,
        border: '1px solid var(--border-soft)',
        background: 'var(--bg-card)',
      }}
    >
      <h3 style={{ marginTop: 0, marginBottom: 4 }}>
        Conferir parcelas por data de vencimento
      </h3>

      <div style={{ color: 'var(--text-muted)', fontSize: '0.9em', marginBottom: 12, marginTop: 0 }}>
        Selecione uma data e veja todas as parcelas com vencimento nesse dia.
        {dataConsulta ? ` Data: ${formatarDataLonga(dataConsulta)}` : ''}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <input
          type="date"
          value={dataConsulta}
          onChange={(e) => setDataConsulta(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') buscarPendentes();
          }}
          style={{ padding: 8 }}
        />

        <button
          onClick={buscarPendentes}
          disabled={buscando}
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            border: 'none',
            background: '#2563eb',
            color: '#fff',
            cursor: 'pointer',
            opacity: buscando ? 0.8 : 1,
          }}
        >
          {buscando ? 'Buscando...' : 'Buscar'}
        </button>

        {podeMostrarX ? (
          <button
            type="button"
            onClick={limparAuditoria}
            title="Limpar"
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              border: 'none',
              background: '#dc2626',
              color: '#fff',
              cursor: 'pointer',
              fontWeight: 800,
              lineHeight: '34px',
            }}
          >
            X
          </button>
        ) : null}

        {podeMostrarCheckbox ? (
          <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', color: 'var(--text-main)' }}>
            <input
              type="checkbox"
              checked={mostrarPagas}
              onChange={(e) => onToggleMostrarPagas(e.target.checked)}
              disabled={buscando}
            />
            Mostrar pagas também
          </label>
        ) : null}
      </div>

      {parcelasExibidas.length > 0 ? (
        <div style={{ marginTop: 25, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {gruposPorEmprestimo.map(([empId, lista]) => {
            const primeiro = lista[0] || {};
            const clienteNome = primeiro.cliente_nome || 'Cliente não informado';
            const clienteId = primeiro.cliente_id != null ? String(primeiro.cliente_id) : '-';

            return (
              <div
                key={String(empId)}
                style={{
                  padding: 12,
                  borderRadius: 10,
                  border: '1px solid var(--border-soft)',
                  background: 'rgba(15,23,42,0.02)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    marginBottom: 10,
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <ClienteIdentity
                      cliente={resolverCliente(clienteId, clienteNome)}
                      avatarSize={40}
                      secondary={`Cliente #${clienteId}`}
                      nameClassName="cliente-identity__name--strong"
                    />
                    <div style={{ fontSize: '0.9em', color: 'var(--text-muted)' }}>
                      Empréstimo #{empId} • {lista.length} parcela(s)
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => irParaEmprestimos(empId, lista[0]?.numero)}
                      style={{
                        padding: '6px 12px',
                        borderRadius: 8,
                        border: 'none',
                        background: '#2563eb',
                        color: '#fff',
                        cursor: 'pointer',
                        fontWeight: 700,
                        fontSize: '0.85em',
                      }}
                    >
                      Ir para empréstimo
                    </button>

                    <button
                      type="button"
                      onClick={() => irParaPagamento(empId, lista[0]?.numero)}
                      style={{
                        padding: '6px 12px',
                        borderRadius: 8,
                        border: 'none',
                        background: '#16a34a',
                        color: '#fff',
                        cursor: 'pointer',
                        fontWeight: 800,
                        fontSize: '0.85em',
                      }}
                    >
                      Ir para pagamento
                    </button>
                  </div>
                </div>

                <ParcelaList parcelas={lista} />
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
